import { NextResponse } from 'next/server'
import clientPromise from '@/lib/mongodb'
import { resolveBrand, type Brand } from '@/lib/brand'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const COLLECTION = 'prompts'
const PROMPTS_DIR = join(process.cwd(), '..', 'prompts')

export type PromptRecord = {
  brand: string
  tenantId: string
  type: 'discovery' | 'enrichment'
  content: string
  source: 'mongodb' | 'disk'
  updatedAt: string
}

function resolvePromptPath(tenantId: string, type: 'discovery' | 'enrichment'): string {
  return join(PROMPTS_DIR, type, `${tenantId}.md`)
}

function diskPromptExists(tenantId: string, type: 'discovery' | 'enrichment'): { path: string; exists: boolean } {
  const path = resolvePromptPath(tenantId, type)
  return { path, exists: existsSync(path) }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const brand = resolveBrand(searchParams.get('brand') || 'cogmap')
    const tenantId = searchParams.get('tenantId') || brand
    const type = searchParams.get('type')

    if (!type || (type !== 'discovery' && type !== 'enrichment')) {
      return NextResponse.json({ error: 'type query param required: discovery or enrichment' }, { status: 400 })
    }

    if (!process.env.MONGODB_URI) {
      const { path: diskPath, exists } = diskPromptExists(tenantId, type)
      if (exists) {
        return NextResponse.json({ prompt: readFileSync(diskPath, 'utf-8'), source: 'disk' })
      }
      // Fall back to legacy flat filename (cogmap.md etc.)
      const legacyPath = join(PROMPTS_DIR, type, `${brand}.md`)
      if (existsSync(legacyPath)) {
        return NextResponse.json({ prompt: readFileSync(legacyPath, 'utf-8'), source: 'disk-legacy' })
      }
      return NextResponse.json({ prompt: '', source: 'default', error: 'not found' }, { status: 404 })
    }

    const client = await clientPromise
    const db = client.db()
    const collection = db.collection(COLLECTION)

    const doc = await collection.findOne({ brand, tenantId, type })

    if (!doc) {
      const { path: diskPath, exists } = diskPromptExists(tenantId, type)
      if (exists) {
        return NextResponse.json({ prompt: readFileSync(diskPath, 'utf-8'), source: 'disk' })
      }
      const legacyPath = join(PROMPTS_DIR, type, `${brand}.md`)
      if (existsSync(legacyPath)) {
        return NextResponse.json({ prompt: readFileSync(legacyPath, 'utf-8'), source: 'disk-legacy' })
      }
      return NextResponse.json({ prompt: '', source: 'default', error: 'not found' }, { status: 404 })
    }

    const { _id, ...prompt } = doc as any
    return NextResponse.json({ prompt, source: 'mongodb' })
  } catch (error: any) {
    console.error('[PromptEditor:GET] error:', error)
    return NextResponse.json({ error: 'Failed to fetch prompt', details: error.message }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const brand = resolveBrand(body.brand || 'cogmap')
    const tenantId = body.tenantId || brand
    const type = body.type
    const content = body.content

    if (!type || (type !== 'discovery' && type !== 'enrichment')) {
      return NextResponse.json({ error: 'type required: discovery or enrichment' }, { status: 400 })
    }
    if (typeof content !== 'string') {
      return NextResponse.json({ error: 'content must be a string' }, { status: 400 })
    }

    if (process.env.MONGODB_URI) {
      const client = await clientPromise
      const db = client.db()
      const collection = db.collection(COLLECTION)
      await collection.updateOne(
        { brand, tenantId, type },
        { $set: { content, source: 'mongodb', updatedAt: new Date().toISOString() } },
        { upsert: true }
      )
    }

    // Also write to disk so cron jobs that read files directly still work
    const { path: diskPath } = diskPromptExists(tenantId, type)
    const dir = join(diskPath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(diskPath, content, 'utf-8')
    // Also update legacy flat filename
    const legacyPath = join(PROMPTS_DIR, type, `${brand}.md`)
    const legacyDir = join(legacyPath, '..')
    if (!existsSync(legacyDir)) mkdirSync(legacyDir, { recursive: true })
    writeFileSync(legacyPath, content, 'utf-8')

    return NextResponse.json({ ok: true, brand, tenantId, type, source: 'mongodb', updatedAt: new Date().toISOString() })
  } catch (error: any) {
    console.error('[PromptEditor:PUT] error:', error)
    return NextResponse.json({ error: 'Failed to save prompt', details: error.message }, { status: 500 })
  }
}

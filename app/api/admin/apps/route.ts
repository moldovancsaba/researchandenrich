import { NextResponse } from 'next/server'
import clientPromise from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'

const COLLECTION = 'contentcreator_apps'

export const dynamic = 'force-dynamic'

function getBrand(request: Request): string {
  const url = new URL(request.url)
  const brand = (url.searchParams.get('brand') || '').trim()
  return brand || 'default'
}

export async function GET(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const client = await clientPromise
    const db = client.db()
    const apps = await db.collection(COLLECTION).find({}).sort({ createdAt: 1 }).toArray()

    return NextResponse.json({
      apps: apps.map((a: any) => ({
        appId: a.appId,
        displayName: a.displayName,
        description: a.description || '',
        apiBase: a.apiBase || '',
        verifier: a.verifier || 'list-based',
        schemaMapper: a.schemaMapper || 'default',
        searchEngines: a.searchEngines || ['google', 'serpapi'],
        qualityPipeline: a.qualityPipeline || ['DRAFT', 'CHECKED', 'VERIFIED'],
        maxResultsPerRun: a.maxResultsPerRun || 50,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    })
  } catch (error: any) {
    console.error('[API:admin/apps] GET error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const { appId, displayName, description, apiBase, verifier, schemaMapper, searchEngines, qualityPipeline, maxResultsPerRun } = body

    if (!appId || !displayName) {
      return NextResponse.json(
        { error: 'appId and displayName are required' },
        { status: 400 }
      )
    }

    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ appId })
    if (existing) {
      return NextResponse.json(
        { error: `App with appId "${appId}" already exists` },
        { status: 409 }
      )
    }

    const now = new Date().toISOString()
    const app = {
      appId,
      displayName,
      description: description || '',
      apiBase: apiBase || '',
      verifier: verifier || 'list-based',
      schemaMapper: schemaMapper || 'default',
      searchEngines: searchEngines || ['google', 'serpapi'],
      qualityPipeline: qualityPipeline || ['DRAFT', 'CHECKED', 'VERIFIED'],
      maxResultsPerRun: maxResultsPerRun || 50,
      tenantIds: [],
      createdAt: now,
      updatedAt: now,
    }

    await db.collection(COLLECTION).insertOne(app)

    return NextResponse.json({ app }, { status: 201 })
  } catch (error: any) {
    console.error('[API:admin/apps] POST error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}
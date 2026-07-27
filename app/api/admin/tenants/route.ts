import { NextResponse } from 'next/server'
import clientPromise from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'

const COLLECTION = 'contentcreator_tenants'

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
    const tenants = await db.collection(COLLECTION).find({}).sort({ sortOrder: 1, tenantId: 1 }).toArray()

    return NextResponse.json({
      tenants: tenants.map((t: any) => ({
        tenantId: t.tenantId,
        appId: t.appId,
        displayName: t.displayName || t.tenantId,
        description: t.description || '',
        status: t.status || 'paused',
        apiBase: t.apiBase || '',
        board: t.board || '',
        brandFields: t.brandFields || { pro: `pro_for_${t.tenantId}`, con: `con_for_${t.tenantId}`, valueProp: '' },
        forbiddenFields: t.forbiddenFields || [],
        iceScoring: t.iceScoring || false,
        discovery: {
          prompt: t.discovery?.prompt || `prompts/discovery/${t.tenantId}.md`,
          schedule: t.discovery?.schedule || { kind: 'every', everyMs: 2700000 },
        },
        enrichment: {
          prompt: t.enrichment?.prompt || `prompts/enrichment/${t.tenantId}.md`,
          schedule: t.enrichment?.schedule || { kind: 'every', everyMs: 2700000 },
        },
        sortOrder: t.sortOrder ?? 0,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    })
  } catch (error: any) {
    console.error('[API:admin/tenants] GET error:', error)
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
    const { tenantId, appId, displayName, description, status, apiBase, board, brandFields, forbiddenFields, iceScoring, discovery, enrichment, sortOrder } = body

    if (!tenantId || !appId) {
      return NextResponse.json(
        { error: 'tenantId and appId are required' },
        { status: 400 }
      )
    }

    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ tenantId })
    if (existing) {
      return NextResponse.json(
        { error: `Tenant "${tenantId}" already exists` },
        { status: 409 }
      )
    }

    const now = new Date().toISOString()
    const tenant = {
      tenantId,
      appId,
      displayName: displayName || tenantId,
      description: description || '',
      status: status || 'paused',
      apiBase: apiBase || '',
      board: board || '',
      brandFields: brandFields || { pro: `pro_for_${tenantId}`, con: `con_for_${tenantId}`, valueProp: '' },
      forbiddenFields: forbiddenFields || [],
      iceScoring: iceScoring || false,
      discovery: discovery || { prompt: `prompts/discovery/${tenantId}.md`, schedule: { kind: 'every', everyMs: 2700000 } },
      enrichment: enrichment || { prompt: `prompts/enrichment/${tenantId}.md`, schedule: { kind: 'every', everyMs: 2700000 } },
      sortOrder: sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    }

    await db.collection(COLLECTION).insertOne(tenant)

    return NextResponse.json({ tenant }, { status: 201 })
  } catch (error: any) {
    console.error('[API:admin/tenants] POST error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

import { NextResponse } from 'next/server'
import clientPromise from '/root/.openclaw/workspace/Agents/contentcreator/lib/mongodb'
import { requireApiKey } from '/root/.openclaw/workspace/Agents/contentcreator/lib/api-auth'

const COLLECTION = 'contentcreator_tenants'

export const dynamic = 'force-dynamic'

function getTenantId(request: Request): string {
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  return parts[parts.length - 1]
}

export async function GET(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const tenantId = getTenantId(request)
    const client = await clientPromise
    const db = client.db()

    const tenant = await db.collection(COLLECTION).findOne({ tenantId })
    if (!tenant) {
      return NextResponse.json(
        { error: `Tenant "${tenantId}" not found` },
        { status: 404 }
      )
    }

    return NextResponse.json({
      tenantId: tenant.tenantId,
      appId: tenant.appId,
      displayName: tenant.displayName || tenant.tenantId,
      description: tenant.description || '',
      status: tenant.status || 'paused',
      apiBase: tenant.apiBase || '',
      board: tenant.board || '',
      brandFields: tenant.brandFields || { pro: `pro_for_${tenantId}`, con: `con_for_${tenantId}`, valueProp: '' },
      forbiddenFields: tenant.forbiddenFields || [],
      iceScoring: tenant.iceScoring || false,
      discovery: {
        prompt: tenant.discovery?.prompt || `prompts/discovery/${tenantId}.md`,
        schedule: tenant.discovery?.schedule || { kind: 'every', everyMs: 2700000 },
      },
      enrichment: {
        prompt: tenant.enrichment?.prompt || `prompts/enrichment/${tenantId}.md`,
        schedule: tenant.enrichment?.schedule || { kind: 'every', everyMs: 2700000 },
      },
      sortOrder: tenant.sortOrder ?? 0,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    })
  } catch (error: any) {
    console.error('[API:admin/tenants] GET error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

export async function PUT(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const tenantId = getTenantId(request)
    const body = await request.json()
    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ tenantId })
    if (!existing) {
      return NextResponse.json(
        { error: `Tenant "${tenantId}" not found` },
        { status: 404 }
      )
    }

    const updated = {
      ...existing,
      ...body,
      tenantId: existing.tenantId,
      updatedAt: new Date().toISOString(),
    }

    await db.collection(COLLECTION).replaceOne({ tenantId }, updated)

    return NextResponse.json({ tenant: updated })
  } catch (error: any) {
    console.error('[API:admin/tenants] PUT error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const tenantId = getTenantId(request)
    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ tenantId })
    if (!existing) {
      return NextResponse.json(
        { error: `Tenant "${tenantId}" not found` },
        { status: 404 }
      )
    }

    await db.collection(COLLECTION).deleteOne({ tenantId })

    return NextResponse.json({ deleted: tenantId })
  } catch (error: any) {
    console.error('[API:admin/tenants] DELETE error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

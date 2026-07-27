import { NextResponse } from 'next/server'
import clientPromise from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'

const COLLECTION = 'contentcreator_apps'

export const dynamic = 'force-dynamic'

function getAppId(request: Request): string {
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  return parts[parts.length - 1]
}

export async function GET(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const appId = getAppId(request)
    const client = await clientPromise
    const db = client.db()

    const app = await db.collection(COLLECTION).findOne({ appId })
    if (!app) {
      return NextResponse.json(
        { error: `App "${appId}" not found` },
        { status: 404 }
      )
    }

    return NextResponse.json({
      appId: app.appId,
      displayName: app.displayName,
      description: app.description || '',
      apiBase: app.apiBase || '',
      verifier: app.verifier || 'list-based',
      schemaMapper: app.schemaMapper || 'default',
      searchEngines: app.searchEngines || ['google', 'serpapi'],
      qualityPipeline: app.qualityPipeline || ['DRAFT', 'CHECKED', 'VERIFIED'],
      maxResultsPerRun: app.maxResultsPerRun || 50,
      tenantIds: app.tenantIds || [],
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    })
  } catch (error: any) {
    console.error('[API:admin/apps] GET error:', error)
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
    const appId = getAppId(request)
    const body = await request.json()
    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ appId })
    if (!existing) {
      return NextResponse.json(
        { error: `App "${appId}" not found` },
        { status: 404 }
      )
    }

    const updated = {
      ...existing,
      ...body,
      appId: existing.appId,
      updatedAt: new Date().toISOString(),
    }

    await db.collection(COLLECTION).replaceOne({ appId }, updated)

    return NextResponse.json({ app: updated })
  } catch (error: any) {
    console.error('[API:admin/apps] PUT error:', error)
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
    const appId = getAppId(request)
    const client = await clientPromise
    const db = client.db()

    const existing = await db.collection(COLLECTION).findOne({ appId })
    if (!existing) {
      return NextResponse.json(
        { error: `App "${appId}" not found` },
        { status: 404 }
      )
    }

    if ((existing.tenantIds || []).length > 0) {
      return NextResponse.json(
        { error: `Cannot delete app "${appId}" with active tenants. Remove tenants first.` },
        { status: 409 }
      )
    }

    await db.collection(COLLECTION).deleteOne({ appId })

    return NextResponse.json({ deleted: appId })
  } catch (error: any) {
    console.error('[API:admin/apps] DELETE error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

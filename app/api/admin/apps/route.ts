import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'
import { asIdentifier, validateAgainstSchema, APP_SCHEMA } from '../../../../lib/validation'
import {
  withErrorHandling,
  errorResponse,
  validationError,
  requestId,
} from '../../../../lib/api-response'

const COLLECTION = 'contentcreator_apps'

export const dynamic = 'force-dynamic'

export const GET = withErrorHandling('/api/admin/apps', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = await getDb()
  const apps = await db.collection(COLLECTION).find({}).sort({ createdAt: 1 }).toArray()

  return NextResponse.json({
    apps: apps.map((a: any) => ({
      appId: a.appId,
      displayName: a.displayName,
      description: a.description || '',
      apiBase: a.apiBase || '',
      verifier: a.verifier || 'list-based',
      schemaMapper: a.schemaMapper || 'schema-mapper.js',
      searchEngines: a.searchEngines || [],
      qualityPipeline: a.qualityPipeline || ['DRAFT', 'CHECKED', 'VERIFIED'],
      maxResultsPerRun: a.maxResultsPerRun || 5,
      tenantIds: a.tenantIds || [],
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  })
})

export const POST = withErrorHandling('/api/admin/apps', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const body = await request.json().catch(() => null)

  const idResult = asIdentifier((body as any)?.appId, 'appId')
  if (!idResult.ok) {
    return validationError(reqId, [{ field: idResult.field, reason: idResult.reason }])
  }

  const validated = validateAgainstSchema(APP_SCHEMA, body, { partial: false })
  if (!validated.ok) return validationError(reqId, validated.errors)

  const appId = idResult.value
  const db = await getDb()

  const existing = await db.collection(COLLECTION).findOne({ appId })
  if (existing) {
    return errorResponse(409, 'conflict', 'An app with that id already exists.', reqId)
  }

  const now = new Date().toISOString()
  const app = {
    ...validated.value,
    appId,
    // Server-maintained, never caller-supplied.
    tenantIds: [],
    createdAt: now,
    updatedAt: now,
  }

  await db.collection(COLLECTION).insertOne(app)

  return NextResponse.json({ app }, { status: 201 })
})

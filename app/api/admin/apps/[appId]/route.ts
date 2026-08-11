import { NextResponse } from 'next/server'
import { getDb } from '../../../../../lib/mongodb'
import { requireApiKey } from '../../../../../lib/api-auth'
import {
  asIdentifier,
  validateAgainstSchema,
  deepEqual,
  APP_SCHEMA,
} from '../../../../../lib/validation'
import {
  withErrorHandling,
  errorResponse,
  validationError,
  requestId,
  log,
} from '../../../../../lib/api-response'

const COLLECTION = 'contentcreator_apps'

export const dynamic = 'force-dynamic'

function appIdFromPath(request: Request) {
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  return asIdentifier(decodeURIComponent(parts[parts.length - 1]), 'appId')
}

export const GET = withErrorHandling('/api/admin/apps/[appId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = appIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const db = await getDb()
  const app = await db.collection(COLLECTION).findOne({ appId: id.value })
  if (!app) return errorResponse(404, 'not_found', 'App not found.', reqId)

  return NextResponse.json({
    appId: app.appId,
    displayName: app.displayName,
    description: app.description || '',
    apiBase: app.apiBase || '',
    verifier: app.verifier || 'list-based',
    schemaMapper: app.schemaMapper || 'schema-mapper.js',
    searchEngines: app.searchEngines || [],
    qualityPipeline: app.qualityPipeline || ['DRAFT', 'CHECKED', 'VERIFIED'],
    maxResultsPerRun: app.maxResultsPerRun || 5,
    tenantIds: app.tenantIds || [],
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  })
})

export const PUT = withErrorHandling('/api/admin/apps/[appId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = appIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const body = await request.json().catch(() => null)

  // tenantIds is immutable here. It was caller-writable through the previous
  // `{ ...existing, ...body }` spread, which made the delete guard below
  // bypassable in two ordinary requests: clear the array, then DELETE.
  const validated = validateAgainstSchema(APP_SCHEMA, body, { partial: true })
  if (!validated.ok) return validationError(reqId, validated.errors)

  const db = await getDb()
  const existing = await db.collection(COLLECTION).findOne({ appId: id.value })
  if (!existing) return errorResponse(404, 'not_found', 'App not found.', reqId)

  const changedFields = Object.keys(validated.value).filter(
    (k) => !deepEqual((existing as any)[k], validated.value[k])
  )

  const updated = {
    ...existing,
    ...validated.value,
    appId: existing.appId,
    updatedAt: new Date().toISOString(),
  }

  await db.collection(COLLECTION).replaceOne({ appId: existing.appId }, updated)

  return NextResponse.json({ app: updated, changedFields })
})

export const DELETE = withErrorHandling('/api/admin/apps/[appId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = appIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const db = await getDb()
  const existing = await db.collection(COLLECTION).findOne({ appId: id.value })
  if (!existing) return errorResponse(404, 'not_found', 'App not found.', reqId)

  // Guard derived from live tenant membership rather than the stored array, so
  // it holds even if a stored tenantIds value is stale.
  const tenantCount = await db
    .collection('contentcreator_tenants')
    .countDocuments({ appId: id.value })
  if (tenantCount > 0) {
    return errorResponse(
      409,
      'conflict',
      `Cannot delete an app that still has ${tenantCount} tenant(s). Remove them first.`,
      reqId
    )
  }

  await db.collection(COLLECTION).deleteOne({ appId: id.value })

  log({
    level: 'warn',
    requestId: reqId,
    event: 'config_change',
    resource: 'app',
    id: id.value,
    field: 'deleted',
  })

  return NextResponse.json({ deleted: id.value })
})

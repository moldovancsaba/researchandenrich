import { NextResponse } from 'next/server'
import { getDb } from '../../../../../lib/mongodb'
import { requireApiKey } from '../../../../../lib/api-auth'
import {
  asIdentifier,
  validateAgainstSchema,
  deepEqual,
  TENANT_SCHEMA,
} from '../../../../../lib/validation'
import {
  withErrorHandling,
  errorResponse,
  validationError,
  requestId,
  log,
} from '../../../../../lib/api-response'

const COLLECTION = 'contentcreator_tenants'

export const dynamic = 'force-dynamic'

/** Path segments are always strings, but the value is still shape-checked. */
function tenantIdFromPath(request: Request) {
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  return asIdentifier(decodeURIComponent(parts[parts.length - 1]), 'tenantId')
}

export const GET = withErrorHandling('/api/admin/tenants/[tenantId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = tenantIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const db = await getDb()
  const tenant = await db.collection(COLLECTION).findOne({ tenantId: id.value })
  if (!tenant) {
    // The caller-supplied identifier is deliberately NOT echoed back; it is in
    // the request URL already, and the requestId links this to a log line.
    return errorResponse(404, 'not_found', 'Tenant not found.', reqId)
  }

  return NextResponse.json({
    tenantId: tenant.tenantId,
    appId: tenant.appId,
    displayName: tenant.displayName || tenant.tenantId,
    description: tenant.description || '',
    status: tenant.status || 'paused',
    apiBase: tenant.apiBase || '',
    board: tenant.board || '',
    brandFields: tenant.brandFields || {
      pro: 'pro_for_organization',
      con: 'con_for_organization',
    },
    forbiddenFields: tenant.forbiddenFields || [],
    iceScoring: tenant.iceScoring || false,
    schemaFamily: tenant.schemaFamily,
    forecastModel: tenant.forecastModel,
    discovery: {
      prompt: tenant.discovery?.prompt || `prompts/discovery/${tenant.tenantId}.md`,
      schedule: tenant.discovery?.schedule || { kind: 'every', everyMs: 2700000 },
      enabled: tenant.discovery?.enabled !== false,
    },
    enrichment: {
      prompt: tenant.enrichment?.prompt || `prompts/enrichment/${tenant.tenantId}.md`,
      schedule: tenant.enrichment?.schedule || { kind: 'every', everyMs: 2700000 },
      enabled: tenant.enrichment?.enabled !== false,
    },
    sortOrder: tenant.sortOrder ?? 0,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  })
})

export const PUT = withErrorHandling('/api/admin/tenants/[tenantId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = tenantIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const body = await request.json().catch(() => null)

  // Allowlist. This used to be `{ ...existing, ...body }` with only the
  // identifier pinned, so any caller could set status (stopping a
  // revenue-relevant tenant's cron) or clear tenantIds on an app.
  const validated = validateAgainstSchema(TENANT_SCHEMA, body, { partial: true })
  if (!validated.ok) return validationError(reqId, validated.errors)

  const db = await getDb()
  const existing = await db.collection(COLLECTION).findOne({ tenantId: id.value })
  if (!existing) return errorResponse(404, 'not_found', 'Tenant not found.', reqId)

  const changedFields = Object.keys(validated.value).filter(
    (k) => !deepEqual((existing as any)[k], validated.value[k])
  )

  const updated: Record<string, any> = {
    ...existing,
    ...validated.value,
    tenantId: existing.tenantId,
    updatedAt: new Date().toISOString(),
  }

  await db.collection(COLLECTION).replaceOne({ tenantId: existing.tenantId }, updated)

  const statusChanged = changedFields.includes('status')
    ? { from: existing.status, to: updated.status }
    : undefined

  if (statusChanged) {
    // The Mongo-side config source has no git history. This event is its audit
    // trail, and the analogue of CLAUDE.md's commit-message rule: an
    // unannounced tenant pause caused a real incident on 2026-08-03.
    log({
      level: 'warn',
      requestId: reqId,
      event: 'config_change',
      resource: 'tenant',
      id: existing.tenantId,
      field: 'status',
      from: existing.status,
      to: updated.status,
    })
  }

  return NextResponse.json({
    tenant: updated,
    changedFields,
    ...(statusChanged ? { statusChanged } : {}),
  })
})

export const DELETE = withErrorHandling('/api/admin/tenants/[tenantId]', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const id = tenantIdFromPath(request)
  if (!id.ok) return validationError(reqId, [{ field: id.field, reason: id.reason }])

  const db = await getDb()
  const existing = await db.collection(COLLECTION).findOne({ tenantId: id.value })
  if (!existing) return errorResponse(404, 'not_found', 'Tenant not found.', reqId)

  await db.collection(COLLECTION).deleteOne({ tenantId: id.value })

  // tenantIds is server-maintained, so removing a tenant updates its app here
  // rather than leaving the app's delete guard referencing a tenant that is gone.
  if (existing.appId) {
    await db
      .collection('contentcreator_apps')
      .updateOne({ appId: existing.appId }, { $pull: { tenantIds: id.value } } as any)
  }

  log({
    level: 'warn',
    requestId: reqId,
    event: 'config_change',
    resource: 'tenant',
    id: id.value,
    field: 'deleted',
    from: existing.status,
  })

  return NextResponse.json({ deleted: id.value })
})

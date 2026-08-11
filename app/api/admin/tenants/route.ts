import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'
import { asIdentifier, validateAgainstSchema, TENANT_SCHEMA } from '../../../../lib/validation'
import {
  withErrorHandling,
  errorResponse,
  validationError,
  requestId,
  log,
} from '../../../../lib/api-response'

const COLLECTION = 'contentcreator_tenants'

export const dynamic = 'force-dynamic'

export const GET = withErrorHandling('/api/admin/tenants', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = await getDb()
  const tenants = await db
    .collection(COLLECTION)
    .find({})
    .sort({ sortOrder: 1, tenantId: 1 })
    .toArray()

  return NextResponse.json({
    tenants: tenants.map((t: any) => ({
      tenantId: t.tenantId,
      appId: t.appId,
      displayName: t.displayName || t.tenantId,
      description: t.description || '',
      status: t.status || 'paused',
      apiBase: t.apiBase || '',
      board: t.board || '',
      brandFields: t.brandFields || { pro: 'pro_for_organization', con: 'con_for_organization' },
      forbiddenFields: t.forbiddenFields || [],
      iceScoring: t.iceScoring || false,
      schemaFamily: t.schemaFamily,
      forecastModel: t.forecastModel,
      discovery: {
        prompt: t.discovery?.prompt || `prompts/discovery/${t.tenantId}.md`,
        schedule: t.discovery?.schedule || { kind: 'every', everyMs: 2700000 },
        enabled: t.discovery?.enabled !== false,
      },
      enrichment: {
        prompt: t.enrichment?.prompt || `prompts/enrichment/${t.tenantId}.md`,
        schedule: t.enrichment?.schedule || { kind: 'every', everyMs: 2700000 },
        enabled: t.enrichment?.enabled !== false,
      },
      sortOrder: t.sortOrder ?? 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  })
})

export const POST = withErrorHandling('/api/admin/tenants', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const body = await request.json().catch(() => null)

  // Identifiers are validated BEFORE any database access. A body-supplied
  // object here would otherwise be interpreted by the driver as a query
  // operator: {"tenantId": {"$ne": null}} matched an arbitrary document.
  const idResult = asIdentifier((body as any)?.tenantId, 'tenantId')
  const appResult = asIdentifier((body as any)?.appId, 'appId')
  const idErrors = [idResult, appResult].filter((r) => !r.ok) as Extract<
    typeof idResult,
    { ok: false }
  >[]
  if (idErrors.length > 0) {
    return validationError(
      reqId,
      idErrors.map((e) => ({ field: e.field, reason: e.reason }))
    )
  }

  const validated = validateAgainstSchema(TENANT_SCHEMA, body, { partial: false })
  if (!validated.ok) return validationError(reqId, validated.errors)

  const tenantId = (idResult as { ok: true; value: string }).value
  const db = await getDb()

  const existing = await db.collection(COLLECTION).findOne({ tenantId })
  if (existing) {
    return errorResponse(409, 'conflict', 'A tenant with that id already exists.', reqId)
  }

  const now = new Date().toISOString()
  const tenant = {
    ...validated.value,
    tenantId,
    status: (validated.value.status as string) || 'paused',
    createdAt: now,
    updatedAt: now,
  }

  await db.collection(COLLECTION).insertOne(tenant)

  log({
    level: 'info',
    requestId: reqId,
    event: 'config_change',
    resource: 'tenant',
    id: tenantId,
    field: 'created',
    to: tenant.status,
  })

  return NextResponse.json({ tenant }, { status: 201 })
})

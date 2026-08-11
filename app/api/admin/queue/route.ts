import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'
import { effectiveEnabled, parseJobId, REORDER_FORBIDDEN_FIELDS, type Operation } from '../../../../lib/queue-core'
import {
  withErrorHandling,
  errorResponse,
  validationError,
  requestId,
  log,
} from '../../../../lib/api-response'

const TENANTS_COLLECTION = 'contentcreator_tenants'
const APPS_COLLECTION = 'contentcreator_apps'

export const dynamic = 'force-dynamic'

function jobFor(tenant: any, operation: Operation, sortIndex: number, appVerifier?: string) {
  const prefix = `queue-${tenant.tenantId}`
  const opConfig = tenant[operation] ?? {}
  const isProgramApi = tenant.schemaFamily === 'program-api'

  return {
    id: `${prefix}-${operation}`,
    tenantId: tenant.tenantId,
    appId: tenant.appId,
    operation,
    // Effective, plus its two inputs, so the UI can explain WHY a job is off
    // rather than showing an indistinguishable "off".
    enabled: effectiveEnabled(tenant, operation),
    operationEnabled: opConfig.enabled !== false,
    tenantStatus: tenant.status ?? 'paused',
    sortOrder: tenant.sortOrder ?? sortIndex,
    prompt: opConfig.prompt || `prompts/${operation}/${tenant.tenantId}.md`,
    schedule: opConfig.schedule || { kind: 'every', everyMs: 2700000 },
    timeoutMs: 300000,
    retry: { maxAttempts: 3, backoffMs: 5000 },
    dependencies: operation === 'enrichment' ? [`${prefix}-discovery`] : [],
    healthCheck: {
      endpoint: isProgramApi
        ? 'GET /api/ingest'
        : `GET /api/leads?brand=${encodeURIComponent(tenant.tenantId)}&limit=1`,
      expectedStatus: 200,
    },
    verifier: appVerifier,
  }
}

export const GET = withErrorHandling('/api/admin/queue', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = await getDb()
  const tenants = await db
    .collection(TENANTS_COLLECTION)
    .find({})
    .sort({ sortOrder: 1, tenantId: 1 })
    .toArray()

  const apps = await db.collection(APPS_COLLECTION).find({}).toArray()
  const verifierByApp = new Map(apps.map((a: any) => [a.appId, a.verifier]))

  const jobs: any[] = []
  let sortIndex = 0
  for (const tenant of tenants) {
    for (const operation of ['discovery', 'enrichment'] as Operation[]) {
      jobs.push(jobFor(tenant, operation, sortIndex++, verifierByApp.get(tenant.appId)))
    }
  }

  return NextResponse.json({
    jobs,
    totalJobs: jobs.length,
    activeJobs: jobs.filter((j) => j.enabled).length,
    pausedJobs: jobs.filter((j) => !j.enabled).length,
  })
})

/**
 * Reorder only.
 *
 * This used to `$set` the whole schedule from `{...(job.schedule || {})}`, so a
 * reorder request that omitted `schedule` silently erased a tenant's schedule.
 * The body now accepts `id` and `sortOrder` and nothing else — rejecting the
 * fields it must not modify is what makes the erasure unreachable.
 *
 * Validation covers the whole batch before any write, so a reorder is
 * all-or-nothing rather than partially applied.
 */
export const PUT = withErrorHandling('/api/admin/queue', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const body = await request.json().catch(() => null)

  if (!body || typeof body !== 'object' || !Array.isArray((body as any).jobs)) {
    return validationError(reqId, [{ field: 'jobs', reason: 'must be an array' }])
  }

  const errors: { field: string; reason: string }[] = []
  const ops: { tenantId: string; sortOrder: number }[] = []

  ;(body as any).jobs.forEach((job: any, i: number) => {
    if (job && typeof job === 'object') {
      for (const forbidden of REORDER_FORBIDDEN_FIELDS) {
        if (forbidden in job) {
          errors.push({
            field: `jobs[${i}].${forbidden}`,
            reason: 'not an accepted field on reorder',
          })
        }
      }
    }
    const parsed = parseJobId(job?.id)
    if (!parsed) {
      errors.push({ field: `jobs[${i}].id`, reason: 'malformed job id' })
      return
    }
    if (!Number.isInteger(job?.sortOrder)) {
      errors.push({ field: `jobs[${i}].sortOrder`, reason: 'must be an integer' })
      return
    }
    ops.push({ tenantId: parsed.tenantId, sortOrder: job.sortOrder })
  })

  if (errors.length > 0) return validationError(reqId, errors)

  const db = await getDb()
  const known = new Set(
    (
      await db
        .collection(TENANTS_COLLECTION)
        .find({}, { projection: { tenantId: 1 } })
        .toArray()
    ).map((t: any) => t.tenantId)
  )

  const unknown = ops.filter((o) => !known.has(o.tenantId))
  if (unknown.length > 0) {
    return validationError(
      reqId,
      unknown.map((o) => ({ field: 'jobs[].id', reason: `tenant '${o.tenantId}' not found` }))
    )
  }

  if (ops.length === 0) {
    return NextResponse.json({ matched: 0, modified: 0 })
  }

  // One bulkWrite rather than N parallel updates: a 20-job reorder is one
  // round trip, and the reported counts come from the driver rather than from
  // the number of operations attempted.
  const result = await db.collection(TENANTS_COLLECTION).bulkWrite(
    ops.map((o) => ({
      updateOne: {
        filter: { tenantId: o.tenantId },
        update: { $set: { sortOrder: o.sortOrder, updatedAt: new Date().toISOString() } },
      },
    }))
  )

  return NextResponse.json({
    matched: result.matchedCount,
    modified: result.modifiedCount,
  })
})

/**
 * Toggle one operation on or off.
 *
 * Writes `<operation>.enabled`, which GET reads. Previously it wrote
 * `<operation>.schedule.enabled`, which nothing read.
 */
export const PATCH = withErrorHandling('/api/admin/queue', async (request) => {
  const authError = requireApiKey(request)
  if (authError) return authError

  const reqId = requestId(request)
  const body = await request.json().catch(() => null)

  const parsed = parseJobId((body as any)?.jobId)
  if (!parsed) {
    return validationError(reqId, [{ field: 'jobId', reason: 'malformed job id' }])
  }
  if (typeof (body as any)?.enabled !== 'boolean') {
    return validationError(reqId, [{ field: 'enabled', reason: 'must be a boolean' }])
  }

  const { tenantId, operation } = parsed
  const enabled = (body as any).enabled as boolean
  const db = await getDb()

  const existing = await db.collection(TENANTS_COLLECTION).findOne({ tenantId })
  if (!existing) return errorResponse(404, 'not_found', 'Tenant not found.', reqId)
  if (!existing[operation]) {
    return errorResponse(
      404,
      'not_found',
      `This tenant does not define a ${operation} operation.`,
      reqId
    )
  }

  const before = existing[operation]?.enabled !== false
  await db.collection(TENANTS_COLLECTION).updateOne(
    { tenantId },
    {
      $set: {
        [`${operation}.enabled`]: enabled,
        updatedAt: new Date().toISOString(),
      },
    }
  )

  if (before !== enabled) {
    // Disabling a job stops scheduled execution for a revenue-relevant tenant.
    // The Mongo config source has no git history; this is its audit trail.
    log({
      level: 'warn',
      requestId: reqId,
      event: 'config_change',
      resource: 'tenant',
      id: tenantId,
      field: `${operation}.enabled`,
      from: before,
      to: enabled,
    })
  }

  const updated = { ...existing, [operation]: { ...existing[operation], enabled } }

  return NextResponse.json({
    jobId: (body as any).jobId,
    operationEnabled: enabled,
    tenantStatus: existing.status ?? 'paused',
    effectiveEnabled: effectiveEnabled(updated, operation),
  })
})

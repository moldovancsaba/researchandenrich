import { NextResponse } from 'next/server'
import clientPromise from '../../../../lib/mongodb'
import { requireApiKey } from '../../../../lib/api-auth'

const TENANTS_COLLECTION = 'contentcreator_tenants'

export const dynamic = 'force-dynamic'

function getBrand(request: Request): string {
  const url = new URL(request.url)
  const brand = (url.searchParams.get('brand') || '').trim()
  return brand || 'default'
}

/**
 * GET /api/admin/queue
 * Returns all active tenants sorted by sortOrder, with their discovery and enrichment jobs.
 * Each tenant produces up to 2 jobs (discovery + enrichment) if status is "active".
 * Paused/disabled tenants produce jobs with enabled=false.
 */
export async function GET(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const client = await clientPromise
    const db = client.db()

    const tenants = await db.collection(TENANTS_COLLECTION)
      .find({})
      .sort({ sortOrder: 1, tenantId: 1 })
      .toArray()

    const jobs: any[] = []
    let sortIndex = 0

    for (const tenant of tenants) {
      const isActive = tenant.status === 'active'
      const prefix = `queue-${tenant.tenantId}`

      // Discovery job
      jobs.push({
        id: `${prefix}-discovery`,
        tenantId: tenant.tenantId,
        appId: tenant.appId,
        operation: 'discovery',
        enabled: isActive,
        sortOrder: sortIndex++,
        prompt: tenant.discovery?.prompt || `prompts/discovery/${tenant.tenantId}.md`,
        schedule: tenant.discovery?.schedule || { kind: 'every', everyMs: 2700000 },
        timeoutMs: 300000,
        retry: { maxAttempts: 3, backoffMs: 5000 },
        dependencies: [],
        healthCheck: {
          endpoint: `GET /api/leads?brand=${tenant.tenantId}&limit=1`,
          expectedStatus: 200,
        },
      })

      // Enrichment job
      jobs.push({
        id: `${prefix}-enrichment`,
        tenantId: tenant.tenantId,
        appId: tenant.appId,
        operation: 'enrichment',
        enabled: isActive,
        sortOrder: sortIndex++,
        prompt: tenant.enrichment?.prompt || `prompts/enrichment/${tenant.tenantId}.md`,
        schedule: tenant.enrichment?.schedule || { kind: 'every', everyMs: 2700000 },
        timeoutMs: 300000,
        retry: { maxAttempts: 3, backoffMs: 5000 },
        dependencies: [`${prefix}-discovery`],
        healthCheck: {
          endpoint: `GET /api/leads?brand=${tenant.tenantId}&limit=1`,
          expectedStatus: 200,
        },
      })
    }

    return NextResponse.json({
      jobs,
      totalJobs: jobs.length,
      activeJobs: jobs.filter((j: any) => j.enabled).length,
      pausedJobs: jobs.filter((j: any) => !j.enabled).length,
    })
  } catch (error: any) {
    console.error('[API:admin/queue] GET error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/admin/queue
 * Updates the sortOrder for jobs after drag-and-drop reordering.
 * Body: { jobs: [{ id, sortOrder, enabled }] }
 */
export async function PUT(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const { jobs } = body

    if (!Array.isArray(jobs)) {
      return NextResponse.json(
        { error: 'jobs array is required' },
        { status: 400 }
      )
    }

    const client = await clientPromise
    const db = client.db()

    // Extract tenantId and operation from job id (format: queue-<tenantId>-<operation>)
    const updates = jobs.map((job: any) => {
      const match = job.id.match(/^queue-(.+?)-(discovery|enrichment)$/)
      if (!match) {
        throw new Error(`Invalid job id format: ${job.id}`)
      }
      const tenantId = match[1]
      const operation = match[2]
      const scheduleField = operation === 'discovery' ? 'discovery.schedule' : 'enrichment.schedule'

      return db.collection(TENANTS_COLLECTION).updateOne(
        { tenantId },
        {
          $set: {
            [scheduleField]: {
              ...(job.schedule || {}),
            },
            sortOrder: job.sortOrder ?? 0,
          },
        }
      )
    })

    await Promise.all(updates)

    return NextResponse.json({ updated: updates.length })
  } catch (error: any) {
    console.error('[API:admin/queue] PUT error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/admin/queue
 * Toggle enabled/disabled for a single job.
 * Body: { jobId: string, enabled: boolean }
 */
export async function PATCH(request: Request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const { jobId, enabled } = body as { jobId: string; enabled: boolean }

    if (!jobId || typeof enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'jobId and enabled are required' },
        { status: 400 }
      )
    }

    const match = jobId.match(/^queue-(.+?)-(discovery|enrichment)$/)
    if (!match) {
      return NextResponse.json(
        { error: `Invalid job id format: ${jobId}` },
        { status: 400 }
      )
    }
    const tenantId = match[1]
    const operation = match[2]
    const scheduleField = operation === 'discovery' ? 'discovery.schedule' : 'enrichment.schedule'

    const client = await clientPromise
    const db = client.db()

    // Fetch tenant to determine active status from the job id alone
    const tenant = await db.collection(TENANTS_COLLECTION).findOne({ tenantId })
    if (!tenant) {
      return NextResponse.json(
        { error: `Tenant not found: ${tenantId}` },
        { status: 404 }
      )
    }

    // Update the schedule with the enabled flag stored alongside
    await db.collection(TENANTS_COLLECTION).updateOne(
      { tenantId },
      {
        $set: {
          [scheduleField]: {
            ...(tenant as any)[operation === 'discovery' ? 'discovery' : 'enrichment']?.schedule || { kind: 'every', everyMs: 2700000 },
            enabled,
          },
        },
      }
    )

    return NextResponse.json({ jobId, enabled })
  } catch (error: any) {
    console.error('[API:admin/queue] PATCH error:', error)
    return NextResponse.json(
      { error: error?.message || 'Unknown failure' },
      { status: 500 }
    )
  }
}

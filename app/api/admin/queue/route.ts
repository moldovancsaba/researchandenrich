import { NextResponse } from 'next/server'
import clientPromise from '/root/.openclaw/workspace/Agents/contentcreator/lib/mongodb'
import { requireApiKey } from '/root/.openclaw/workspace/Agents/contentcreator/lib/api-auth'

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
          endpoint: tenant.appId === 'classscout-api'
            ? 'GET /api/programs?limit=1'
            : `GET /api/leads?brand=${tenant.tenantId}&limit=1`,
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
          endpoint: tenant.appId === 'classscout-api'
            ? 'GET /api/programs?limit=1'
            : `GET /api/leads?brand=${tenant.tenantId}&limit=1`,
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

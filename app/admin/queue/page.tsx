'use client'

import { useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'

interface Tenant {
  tenantId: string
  appId: string
  displayName: string
  description: string
  status: 'active' | 'paused' | 'disabled'
  apiBase: string
  board: string
  brandFields: { pro: string; con: string; valueProp: string }
  forbiddenFields: string[]
  iceScoring: boolean
  discovery: { prompt: string; schedule: { kind: string; everyMs?: number; expr?: string; tz?: string } }
  enrichment: { prompt: string; schedule: { kind: string; everyMs?: number; expr?: string; tz?: string } }
  sortOrder: number
  createdAt: string
  updatedAt: string
}

interface Job {
  id: string
  tenantId: string
  appId: string
  operation: string
  enabled: boolean
  sortOrder: number
  prompt: string
  schedule: { kind: string; everyMs?: number; expr?: string; tz?: string }
  timeoutMs: number
  retry: { maxAttempts: number; backoffMs: number }
  dependencies: string[]
  healthCheck: { endpoint: string; expectedStatus: number }
}

export default function QueuePage() {
  const router = useRouter()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [tenantsRes, queueRes] = await Promise.all([
          fetch('/api/admin/tenants'),
          fetch('/api/admin/queue'),
        ])
        if (!tenantsRes.ok) throw new Error(`HTTP ${tenantsRes.status}`)
        if (!queueRes.ok) throw new Error(`HTTP ${queueRes.status}`)
        const tenantsData = await tenantsRes.json()
        const queueData = await queueRes.json()
        setTenants(tenantsData.tenants || [])
        setJobs(queueData.jobs || [])
      } catch (e: any) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const StatusBadge = ({ status }: { status: string }) => {
    const colors: Record<string, string> = {
      active: 'bg-green-100 text-green-800',
      paused: 'bg-yellow-100 text-yellow-800',
      disabled: 'bg-red-100 text-red-800',
    }
    return (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
        {status}
      </span>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading queue...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
            {error}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 lg:px-8 flex items-center justify-between">
          <button onClick={() => router.push('/admin')} className="text-lg font-bold text-gray-900 hover:text-indigo-600">
            ContentCreator Admin
          </button>
          <div className="flex gap-4">
            <button onClick={() => router.push('/admin/apps')} className="text-sm text-gray-600 hover:text-gray-900">Apps</button>
            <button onClick={() => router.push('/admin/tenants')} className="text-sm text-gray-600 hover:text-gray-900">Tenants</button>
            <button onClick={() => router.push('/admin/queue')} className="text-sm text-indigo-600 font-medium">Queue</button>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="text-xl font-bold text-gray-900 mb-4">Job Queue</h1>
        <p className="text-sm text-gray-500 mb-6">Jobs run sequentially in sort order. Drag to reorder (future: drag-and-drop UI).</p>
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="divide-y divide-gray-200">
            {jobs.map((job) => {
              const tenant = tenants.find((t) => t.tenantId === job.tenantId)
              return (
                <div key={job.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{job.tenantId}</span>
                        <StatusBadge status={tenant?.status || 'paused'} />
                        <span className="text-xs text-gray-400">sort: {job.sortOrder}</span>
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${job.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                          {job.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">{job.operation} — {job.id}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-4 text-xs text-gray-400">
                    <span>Schedule: {job.schedule.kind === 'every' ? `Every ${(job.schedule.everyMs || 2700000) / 60000}min` : job.schedule.expr || '—'}</span>
                    <span>Timeout: {job.timeoutMs}ms</span>
                    <span>Retry: {job.retry.maxAttempts} attempts</span>
                    <span>Health: {job.healthCheck.endpoint}</span>
                  </div>
                  {job.dependencies.length > 0 && (
                    <div className="mt-1 text-xs text-gray-400">Depends on: {job.dependencies.join(', ')}</div>
                  )}
                </div>
              )
            })}
            {jobs.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">No jobs configured. Add a tenant first.</div>
            )}
          </div>
        </div>
        <div className="mt-6 flex gap-4 text-sm text-gray-500">
          <span>Total: {jobs.length} jobs</span>
          <span>Active: {jobs.filter((j) => j.enabled).length}</span>
          <span>Paused: {jobs.filter((j) => !j.enabled).length}</span>
        </div>
      </main>
    </div>
  )
}

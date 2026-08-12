'use client'

import { useState, useEffect } from 'react'

interface App {
  appId: string
  displayName: string
  description: string
  apiBase: string
  verifier: string
  schemaMapper: string
  searchEngines: string[]
  qualityPipeline: string[]
  maxResultsPerRun: number
  tenantIds: string[]
  createdAt: string
  updatedAt: string
}

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

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<'apps' | 'tenants' | 'queue'>('apps')
  const [apps, setApps] = useState<App[]>([])
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [selectedApp, setSelectedApp] = useState<App | null>(null)
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null)
  const [showAppForm, setShowAppForm] = useState(false)
  const [showTenantForm, setShowTenantForm] = useState(false)
  const [editingApp, setEditingApp] = useState<App | null>(null)
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const apiBase = '/api/admin'

  const loadApps = async () => {
    try {
      const res = await fetch(`${apiBase}/apps?brand=cogmap`, {
        headers: { 'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setApps(data.apps || [])
    } catch (e: any) {
      console.error('Failed to load apps:', e.message)
    }
  }

  const loadTenants = async () => {
    try {
      const res = await fetch(`${apiBase}/tenants?brand=cogmap`, {
        headers: { 'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTenants(data.tenants || [])
    } catch (e: any) {
      console.error('Failed to load tenants:', e.message)
    }
  }

  useEffect(() => {
    loadApps()
    loadTenants()
  }, [])

  const handleSaveApp = async (app: App, isNew: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const url = isNew
        ? `${apiBase}/apps`
        : `${apiBase}/apps/${app.appId}`
      const method = isNew ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '',
        },
        body: JSON.stringify(app),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setMessage(isNew ? 'App created successfully' : 'App updated successfully')
      setShowAppForm(false)
      setEditingApp(null)
      loadApps()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveTenant = async (tenant: Tenant, isNew: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const url = isNew
        ? `${apiBase}/tenants`
        : `${apiBase}/tenants/${tenant.tenantId}`
      const method = isNew ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '',
        },
        body: JSON.stringify(tenant),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setMessage(isNew ? 'Tenant created successfully' : 'Tenant updated successfully')
      setShowTenantForm(false)
      setEditingTenant(null)
      loadTenants()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteTenant = async (tenantId: string) => {
    if (!confirm(`Delete tenant "${tenantId}"? This cannot be undone.`)) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/tenants/${tenantId}`, {
        method: 'DELETE',
        headers: { 'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '' },
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setMessage('Tenant deleted')
      loadTenants()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

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

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-gray-900">ContentCreator Admin</h1>
            <nav className="flex gap-4">
              <button
                onClick={() => setActiveTab('apps')}
                className={`px-3 py-2 text-sm font-medium rounded-md ${activeTab === 'apps' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                Apps ({apps.length})
              </button>
              <button
                onClick={() => setActiveTab('tenants')}
                className={`px-3 py-2 text-sm font-medium rounded-md ${activeTab === 'tenants' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                Tenants ({tenants.length})
              </button>
              <button
                onClick={() => setActiveTab('queue')}
                className={`px-3 py-2 text-sm font-medium rounded-md ${activeTab === 'queue' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                Queue
              </button>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        {message && (
          <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-md">
            {message}
          </div>
        )}
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
            {error}
          </div>
        )}

        {activeTab === 'apps' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Apps</h2>
              <button
                onClick={() => { setEditingApp(null); setShowAppForm(true) }}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700"
              >
                + Add App
              </button>
            </div>

            {showAppForm && (
              <AppForm app={editingApp} onSave={handleSaveApp} onCancel={() => { setShowAppForm(false); setEditingApp(null) }} />
            )}

            <div className="bg-white shadow rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">App ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Display Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">API Base</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenants</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pipeline</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {apps.map((app) => (
                    <tr key={app.appId} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{app.appId}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{app.displayName}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{app.apiBase || '—'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{app.tenantIds?.length || 0}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{app.qualityPipeline?.join(' → ') || '—'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => { setEditingApp(app); setShowAppForm(true) }}
                          className="text-indigo-600 hover:text-indigo-900 mr-3"
                        >
                          Edit
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete app "${app.appId}" and all its tenants?`)) return
                            setLoading(true)
                            try {
                              const res = await fetch(`${apiBase}/apps/${app.appId}`, {
                                method: 'DELETE',
                                headers: { 'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || '' },
                              })
                              if (!res.ok) throw new Error('Delete failed')
                              loadApps()
                              loadTenants()
                            } catch (e: any) {
                              setError(e.message)
                            } finally {
                              setLoading(false)
                            }
                          }}
                          className="text-red-600 hover:text-red-900"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'tenants' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Tenants</h2>
              <button
                onClick={() => { setEditingTenant(null); setShowTenantForm(true) }}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700"
              >
                + Add Tenant
              </button>
            </div>

            {showTenantForm && (
              <TenantForm
                tenant={editingTenant}
                apps={apps}
                onSave={handleSaveTenant}
                onCancel={() => { setShowTenantForm(false); setEditingTenant(null) }}
              />
            )}

            <div className="bg-white shadow rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">App</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Display Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICE Scoring</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {tenants.map((tenant) => (
                    <tr key={tenant.tenantId} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{tenant.tenantId}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{tenant.appId}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{tenant.displayName}</td>
                      <td className="px-6 py-4 whitespace-nowrap"><StatusBadge status={tenant.status} /></td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{tenant.iceScoring ? '✅' : '—'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => { setEditingTenant(tenant); setShowTenantForm(true) }}
                          className="text-indigo-600 hover:text-indigo-900 mr-3"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteTenant(tenant.tenantId)}
                          className="text-red-600 hover:text-red-900"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'queue' && (
          <QueueView tenants={tenants} />
        )}
      </main>
    </div>
  )
}

function AppForm({ app, onSave, onCancel }: { app: App | null; onSave: (app: App, isNew: boolean) => void; onCancel: () => void }) {
  const [form, setForm] = useState<App>(app || {
    appId: '', displayName: '', description: '', apiBase: '', verifier: 'list-based',
    schemaMapper: 'default', searchEngines: ['google', 'serpapi'], qualityPipeline: ['DRAFT', 'CHECKED', 'VERIFIED'],
    maxResultsPerRun: 50, tenantIds: [], createdAt: '', updatedAt: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(form, !app)
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 mb-4">
      <h3 className="text-lg font-semibold mb-4">{app ? 'Edit' : 'New'} App</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">App ID</label>
          <input type="text" value={form.appId} onChange={(e) => setForm({...form, appId: e.target.value})} required className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Display Name</label>
          <input type="text" value={form.displayName} onChange={(e) => setForm({...form, displayName: e.target.value})} required className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700">Description</label>
          <input type="text" value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700">API Base</label>
          <input type="url" value={form.apiBase} onChange={(e) => setForm({...form, apiBase: e.target.value})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Verifier</label>
          <select value={form.verifier} onChange={(e) => setForm({...form, verifier: e.target.value})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2">
            <option value="list-based">List-based</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Max Results/Run</label>
          <input type="number" value={form.maxResultsPerRun} onChange={(e) => setForm({...form, maxResultsPerRun: parseInt(e.target.value)})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button type="submit" className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700">Save</button>
        <button type="button" onClick={onCancel} className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
      </div>
    </form>
  )
}

function TenantForm({ tenant, apps, onSave, onCancel }: { tenant: Tenant | null; apps: App[]; onSave: (tenant: Tenant, isNew: boolean) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Tenant>(tenant || {
    tenantId: '', appId: '', displayName: '', description: '', status: 'paused',
    apiBase: '', board: '', brandFields: { pro: '', con: '', valueProp: '' }, forbiddenFields: [],
    iceScoring: false, discovery: { prompt: '', schedule: { kind: 'every', everyMs: 2700000 } },
    enrichment: { prompt: '', schedule: { kind: 'every', everyMs: 2700000 } }, sortOrder: 0,
    createdAt: '', updatedAt: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(form, !tenant)
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 mb-4">
      <h3 className="text-lg font-semibold mb-4">{tenant ? 'Edit' : 'New'} Tenant</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Tenant ID</label>
          <input type="text" value={form.tenantId} onChange={(e) => setForm({...form, tenantId: e.target.value})} required className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">App</label>
          <select value={form.appId} onChange={(e) => setForm({...form, appId: e.target.value})} required className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2">
            <option value="">Select app...</option>
            {apps.map((a) => <option key={a.appId} value={a.appId}>{a.displayName} ({a.appId})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Display Name</label>
          <input type="text" value={form.displayName} onChange={(e) => setForm({...form, displayName: e.target.value})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Status</label>
          <select value={form.status} onChange={(e) => setForm({...form, status: e.target.value as Tenant['status']})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2">
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700">Description</label>
          <input type="text" value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">ICE Scoring</label>
          <input type="checkbox" checked={form.iceScoring} onChange={(e) => setForm({...form, iceScoring: e.target.checked})} className="mt-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Sort Order</label>
          <input type="number" value={form.sortOrder} onChange={(e) => setForm({...form, sortOrder: parseInt(e.target.value)})} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm border p-2" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button type="submit" className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700">Save</button>
        <button type="button" onClick={onCancel} className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
      </div>
    </form>
  )
}

function QueueView({ tenants }: { tenants: Tenant[] }) {
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
  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Job Queue</h2>
        <p className="text-sm text-gray-500 mt-1">Jobs run sequentially in sort order. Drag to reorder (future: drag-and-drop UI).</p>
      </div>
      <div className="divide-y divide-gray-200">
        {tenants.map((tenant) => (
          <div key={tenant.tenantId} className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{tenant.tenantId}</span>
                  <StatusBadge status={tenant.status} />
                  <span className="text-xs text-gray-400">sort: {tenant.sortOrder}</span>
                </div>
                <p className="text-sm text-gray-500 mt-1">App: {tenant.appId}</p>
              </div>
            </div>
            <div className="mt-2 flex gap-4 text-xs text-gray-400">
              <span>📥 Discovery: {tenant.discovery?.schedule?.kind === 'every' ? `Every ${(tenant.discovery?.schedule?.everyMs || 2700000) / 60000}min` : tenant.discovery?.schedule?.expr || '—'}</span>
              <span>📤 Enrichment: {tenant.enrichment?.schedule?.kind === 'every' ? `Every ${(tenant.enrichment?.schedule?.everyMs || 2700000) / 60000}min` : tenant.enrichment?.schedule?.expr || '—'}</span>
            </div>
          </div>
        ))}
        {tenants.length === 0 && (
          <div className="px-6 py-8 text-center text-gray-500">No tenants configured. Add a tenant first.</div>
        )}
      </div>
    </div>
  )
}

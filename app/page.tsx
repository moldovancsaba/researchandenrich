'use client'

import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 lg:px-8 flex items-center justify-between">
          <Link href="/admin" className="text-lg font-bold text-gray-900 hover:text-indigo-600">
            ContentCreator
          </Link>
          <div className="flex gap-4">
            <Link href="/admin/apps" className="text-sm text-gray-600 hover:text-gray-900">Apps</Link>
            <Link href="/admin/tenants" className="text-sm text-gray-600 hover:text-gray-900">Tenants</Link>
            <Link href="/admin/queue" className="text-sm text-gray-600 hover:text-gray-900">Queue</Link>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">ContentCreator</h1>
        <p className="text-gray-600 mb-6">Unified research and enrichment service for cogmap and seyu.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link href="/admin/apps" className="block p-6 bg-white shadow rounded-lg hover:shadow-md transition-shadow">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Apps</h2>
            <p className="text-sm text-gray-500">Manage research applications and their configurations.</p>
          </Link>
          <Link href="/admin/tenants" className="block p-6 bg-white shadow rounded-lg hover:shadow-md transition-shadow">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Tenants</h2>
            <p className="text-sm text-gray-500">Configure cogmap and seyu tenants, toggle status, set schedules.</p>
          </Link>
          <Link href="/admin/queue" className="block p-6 bg-white shadow rounded-lg hover:shadow-md transition-shadow">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Job Queue</h2>
            <p className="text-sm text-gray-500">Monitor and manage discovery and enrichment jobs.</p>
          </Link>
        </div>
      </main>
    </main>
  )
}

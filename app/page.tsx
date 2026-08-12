export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">ContentCreator</h1>
        <p className="text-gray-600 mb-6">
          Agent runtime for ContentCreator — unified research and enrichment service for
          cogmap, seyu, dvsc, and classscout.
        </p>
        <p className="text-gray-600 mb-2">
          Configuration is file-based, tracked in this repository — <code>tenants.json</code>,{" "}
          <code>apps.yaml</code>, and <code>workers/*/*.yaml</code> are the source of truth.
          See <code>rae_handover.md</code> for the full operational reference.
        </p>
        <p className="text-gray-600">
          Health check: <code>GET /api/health</code>
        </p>
      </div>
    </main>
  )
}

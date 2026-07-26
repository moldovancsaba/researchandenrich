export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>ContentCreator</h1>
      <p>Unified research and enrichment service.</p>
      <nav>
        <ul>
          <li><a href="/admin/queue">Job Queue</a></li>
          <li><a href="/admin/tenants">Tenants</a></li>
          <li><a href="/admin/apps">Apps</a></li>
          <li><a href="/api/health">Health</a></li>
        </ul>
      </nav>
    </main>
  )
}

# ContentCreator Agent Runtime

Agent runtime for ContentCreator — unified lead and program research service. Serves three tenants (cogmap, seyu, dvsc), each run as a fixed-tenant cron job — one tenant per run, no round-robin state, per the Fixed-Tenant Contract embedded in every prompt file.

## Repo Layout

```
├── agents/contentcreator/       <- agent runtime code (this repo)
│   ├── app/                       <- Next.js App Router
│   │   ├── layout.tsx             <- root layout
│   │   ├── page.tsx               <- landing page
│   │   ├── admin/
│   │   │   ├── layout.tsx         <- admin panel layout
│   │   │   ├── page.tsx           <- admin dashboard
│   │   │   ├── globals.css
│   │   │   └── components/
│   │   │       ├── Providers.tsx
│   │   │       └── PwaSetup.tsx
│   │   └── api/                   <- API routes
│   │       ├── admin/             <- admin management endpoints
│   │       │   ├── apps/
│   │       │   ├── tenants/
│   │       │   └── queue/
│   │       ├── health/route.ts
│   │       └── leads/route.ts
│   ├── lib/                       <- shared utilities
│   │   ├── mongodb.ts             <- MongoDB connection helper
│   │   └── api-auth.ts            <- API key authentication
│   ├── prompts/                   <- prompt files (discovery/enrichment)
│   │   ├── discovery/
│   │   └── enrichment/
│   ├── tenants.json               <- tenant configs (incl. per-operation enabled flags)
│   ├── schema-mapper.js           <- schema mapping + cross-tenant guards
│   ├── runtime/                   <- shared runtime (cache, HTTP client, retry)
│   ├── workers/*/                 <- per-tenant worker YAML configs
│   ├── config/
│   │   ├── cron-generator.js      <- generates cron.yaml from tenants.json + workers
│   │   └── cron.yaml              <- generated cron schedule
│   ├── apps.yaml                  <- app definitions
│   ├── config/apps/               <- per-app config (researchandenrich.yaml)
│   ├── vercel.json                <- Vercel config (empty, auto-detects Next.js)
│   └── .env.cogmap / .env.seyu / .env.dvsc  <- protected credentials (600 permissions)
```

See `docs/RUNTIME_ARCHITECTURE_NOTES.md` for details on this repo's two unsynced
config sources (static files vs. the Mongo-backed admin API), Claude Code MCP
compatibility (`.mcp.json`), and other findings from onboarding `dvsc`.

## Per-Tenant Toggles

Each tenant in `tenants.json` has per-operation `enabled` flags:

```json
{
  "tenants": {
    "cogmap": {
      "discovery": { "enabled": true },
      "enrichment": { "enabled": true }
    },
    "seyu": {
      "discovery": { "enabled": true },
      "enrichment": { "enabled": true }
    },
    "dvsc": {
      "discovery": { "enabled": false },
      "enrichment": { "enabled": false }
    }
  }
}
```

`dvsc` ships paused/disabled by default — it has no real leads yet and its
Sales Settings deal-size bands are unconfigured. Flip both `enabled` flags
to `true` once it's ready to go live.

The cron-generator reads these flags to include/exclude operations in the cron schedule.

## Deployment

Deployed on Vercel as a Next.js App Router project. The `vercel.json` is empty (`{}`) so Vercel auto-detects the framework. The build command is `next build` and the dev command is `next dev`.

The admin UI at `/admin` provides a dashboard for managing apps, tenants, and the job queue. API routes at `/api/admin/*` handle CRUD operations (API key required). The landing page at `/` links to the admin panel and health check.

## Prohibited

- No cross-tenant field writes
- All prompt content + runtime config lives in this repo only

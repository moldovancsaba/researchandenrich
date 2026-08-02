# ContentCreator Agent Runtime

Agent runtime for ContentCreator — unified lead and program research service. Serves three tenants (cogmap, seyu, dvsc), each run as a fixed-tenant cron job — one tenant per run, no round-robin state, per the Fixed-Tenant Contract embedded in every prompt file.

## Repo Layout

```
├── app/                       <- Next.js App Router (the /admin dashboard)
│   ├── layout.tsx                <- root layout
│   ├── page.tsx                  <- landing page
│   ├── admin/
│   │   ├── layout.tsx            <- admin panel layout
│   │   ├── page.tsx              <- admin dashboard (Apps/Tenants/Queue tabs)
│   │   ├── queue/page.tsx        <- full queue page
│   │   ├── globals.css
│   │   └── components/
│   │       ├── Providers.tsx
│   │       └── PwaSetup.tsx
│   └── api/                      <- API routes
│       ├── admin/                <- admin management endpoints (apps/tenants/queue --
│       │   │                        Mongo-backed, see "two unsynced config sources" below)
│       │   ├── apps/
│       │   ├── tenants/
│       │   └── queue/
│       ├── health/route.ts
│       └── leads/route.ts        <- local stub/mock only -- the real leads API this
│                                     pipeline writes to lives in salesleadgenerator
├── lib/                       <- shared utilities (for the /admin app above)
│   ├── mongodb.ts                <- MongoDB connection helper
│   └── api-auth.ts               <- API key authentication
├── prompts/                   <- prompt files (discovery/enrichment), OpenClaw-format
│   ├── discovery/
│   └── enrichment/
├── tenants.json               <- tenant configs (schemaFamily/forecastModel,
│                                  per-operation enabled flags)
├── schema-mapper.js           <- schema mapping + cross-tenant guards (repo root --
│                                  not under runtime/, see apps.yaml's schemaMapper: field)
├── runtime/
│   ├── verifier/list-based.js    <- list-based verification (GET-by-ID is unreliable,
│   │                                 per its own doc comment)
│   └── shared/                   <- cache, HTTP client, retry helpers
├── workers/*/                 <- per-tenant worker YAML configs (discovery.yaml,
│                                  enrichment.yaml)
├── config/
│   ├── cron-generator.js         <- generates cron.yaml from tenants.json + workers
│   ├── cron.yaml                 <- generated cron schedule (do not hand-edit)
│   ├── healthcheck.yaml          <- health-check endpoint defaults
│   └── retry-policy.yaml         <- global retry/timeout/logging defaults
├── scripts/
│   ├── verify-schema-mapper.js   <- schema-mapper.js regression check (no test
│   │                                 framework configured in package.json)
│   └── sync-dvsc-to-admin.js     <- syncs a static-file tenant into the Mongo-backed
│                                     admin API (not yet run against a live deployment)
├── search-router/              <- the web-search MCP server prompts invoke
│   ├── agent-runtime.json
│   ├── bin/run-router-search.sh
│   └── seyu-search-router/       <- self-contained npm package, own package.json/tests
├── apps.yaml                  <- app definitions
├── .mcp.json                  <- declares search-router as a Claude-Code-discoverable
│                                  MCP stdio server (separate integration path from the
│                                  OpenClaw prompts' own hardcoded AgentFinder invocation)
├── vercel.json                <- Vercel config (empty, auto-detects Next.js)
└── .env.cogmap / .env.seyu / .env.dvsc  <- gitignored credential files
```

See `docs/RUNTIME_ARCHITECTURE_NOTES.md` for details on this repo's two unsynced
config sources (static files vs. the Mongo-backed admin API), Claude Code MCP
compatibility (`.mcp.json`), and other findings from onboarding `dvsc`.

## New Agent Onboarding

This repo is self-sufficient — a new agent (OpenClaw/kiloclaw or Claude Code)
being pointed here to run discovery/enrichment for any tenant needs nothing
beyond what's already in the repo. Do this, in order, rather than asking for
tenant-specific instructions elsewhere:

1. Clone this repo.
2. Read `tenants.json` for the full, current list of tenants and each one's
   `status` (`active`/`paused`) and per-operation `discovery.enabled` /
   `enrichment.enabled` flags. Only act on a tenant where both are `true` —
   don't infer readiness from anything else, including how much you know
   about that tenant's business.
3. For each tenant you're assigned to run: read `workers/<tenantId>/discovery.yaml`
   and `workers/<tenantId>/enrichment.yaml`, then the matching
   `prompts/discovery/<tenantId>.md` / `prompts/enrichment/<tenantId>.md`.
   Those prompt files are the complete, authoritative, tenant-specific
   instructions (scope, forbidden terms, forecast fields, ICP guidance) —
   follow them verbatim, don't improvise scope or fields.
4. Source `.env.<tenantId>` before any API or search call, per that tenant's
   own prompt file's "Start-up" section. **Every tenant currently shares the
   same `SLG_API_KEY` and the same MongoDB Atlas cluster** (confirmed by
   comparing connection strings across `.env.cogmap`/`.env.seyu` — same
   host, different per-tenant-scoped credential strings). If a tenant's
   `.env.<tenantId>` still has placeholder values (true for a
   freshly-onboarded tenant, e.g. `dvsc` today), copy the real
   `SLG_API_KEY` value and a working Mongo connection string from an
   existing tenant's env file (e.g. `.env.cogmap`) rather than treating
   them as unknown or blocked on — that's the actual current
   infrastructure, not a guess. Confirm with the repo owner before relying
   on this if it's ever no longer true for a given tenant.
5. Follow the Fixed-Tenant Contract every prompt file states: one tenant
   per run, no parallel execution across tenants, linear only — a real
   constraint of this environment's limited resources, not a style choice.
6. Use the search router (`search-router/seyu-search-router`) per each
   prompt's "Search/router usage" section instead of ad-hoc web search.
   Run `npm install` inside `search-router/seyu-search-router/` first if
   it hasn't been installed yet (its `node_modules` is gitignored).
7. `config/cron.yaml` is generated, not hand-edited. If a tenant's schedule
   or enabled flags change, edit `tenants.json` / `workers/<tenantId>/*.yaml`
   and re-run `node config/cron-generator.js`.
8. Read `docs/RUNTIME_ARCHITECTURE_NOTES.md` for known gaps and prior
   findings (the dual static-file/Mongo-admin config-source split, bugs
   already found and fixed, live-test results) before assuming anything
   not explicitly stated in a tenant's own files.

**Onboarding a brand-new tenant** follows the exact same pattern `dvsc`
used: add an entry to `tenants.json` and `apps.yaml`, add
`workers/<id>/{discovery,enrichment}.yaml`, write
`prompts/{discovery,enrichment}/<id>.md`, and add a `.env.<id>` file
(reusing the shared `SLG_API_KEY`/Mongo credentials per step 4 above,
unless the new tenant is explicitly meant to have its own). Then run
`node config/cron-generator.js` to regenerate `config/cron.yaml`. Ship the
new tenant paused (`status: "paused"`, both `enabled` flags `false`) until
its Sales Settings are configured in salesleadgenerator and it's ready to
go live — the same convention `dvsc` shipped under.

**If the new tenant sells the same shape of thing salesleadgenerator's
lead schema already models** (the common case — another salesleadgenerator
brand, same as cogmap/seyu/dvsc), its `tenants.json` entry also needs:
- `"schemaFamily": "sales-lead-api"`
- `"forecastModel": "deal-size-band"` or `"pricing-by-company"` — whichever
  forecast-field shape the new brand's Sales Settings actually use in
  salesleadgenerator (see `docs/RUNTIME_ARCHITECTURE_NOTES.md` §4a for what
  each means). Omit `forecastModel` entirely if the new brand uses neither.

That's it — `schema-mapper.js` itself needs **zero code changes** for a new
sales-lead-api tenant; it dispatches purely on these two config fields, never
on the tenant's own name. Confirm with `node scripts/verify-schema-mapper.js`
after adding the entry (it exercises every tenant it finds in `tenants.json`
automatically — no need to add a new tenant to the script itself). Only a
tenant selling something schema-mapper.js has never modeled before (a
different target API/schema entirely, not just a different brand) needs an
actual code change — see `docs/RUNTIME_ARCHITECTURE_NOTES.md` §4a for how
`schemaFamily` extends to that case.

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

`dvsc` ships paused/disabled by default. Its Sales Settings (dealSize bands,
product lines) are now configured in salesleadgenerator as disclosed
estimates (see `docs/RUNTIME_ARCHITECTURE_NOTES.md` §3), and a live test run
(§6) confirmed the full discovery→lead→ticket-size pipeline works end to end. It
stays paused until `.env.dvsc` has real credentials (see New Agent
Onboarding above) and someone makes the explicit decision to flip both
`enabled` flags to `true` and re-run `node config/cron-generator.js`.

The cron-generator reads these flags to include/exclude operations in the cron schedule.

## Deployment

Deployed on Vercel as a Next.js App Router project. The `vercel.json` is empty (`{}`) so Vercel auto-detects the framework. The build command is `next build` and the dev command is `next dev`.

The admin UI at `/admin` provides a dashboard for managing apps, tenants, and the job queue. API routes at `/api/admin/*` handle CRUD operations (API key required). The landing page at `/` links to the admin panel and health check.

## Prohibited

- No cross-tenant field writes
- All prompt content + runtime config lives in this repo only

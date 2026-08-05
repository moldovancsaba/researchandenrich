# ContentCreator Agent Runtime

Agent runtime for ContentCreator — unified lead and program research service. Serves four tenants across two apps: cogmap/seyu/dvsc (the `researchandenrich` app, sales-lead-api schemaFamily, writing into salesleadgenerator) and classscout (its own app, program-api schemaFamily, writing into classscout.ai's real provider catalog via `POST /api/ingest`). Each tenant runs as a fixed-tenant cron job — one tenant per run, no round-robin state, per the Fixed-Tenant Contract embedded in every prompt file.

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
│   │                                 per its own doc comment) -- sales-lead-api tenants
│   ├── verifier/response-based.js <- response-based verification, for tenants (classscout)
│   │                                 whose ingest credential has no readable list/get route
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
└── .env.cogmap / .env.seyu / .env.dvsc / .env.classscout  <- gitignored credential files
```

classscout's real target API (`POST /api/ingest`, the `Provider` Zod schema)
lives in the separate `classscout` repo, not here — this repo only holds the
research prompts/schema-mapper/config that call it, the same relationship it
has with salesleadgenerator for the sales-lead-api tenants.

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

**classscout is that "genuinely new schema shape" case**, already built —
its `tenants.json` entry uses `"schemaFamily": "program-api"` (no
`forecastModel`; that field is sales-lead-api-only) and its own `classscout`
app entry in `apps.yaml` (a separate app, not a tenant of the
`researchandenrich` app — it targets a structurally different API). Two
things are genuinely different from every sales-lead-api tenant, and matter
if you're onboarding a further program-api-family tenant later:
- classscout has **one** write endpoint (`POST /api/ingest`) for both create
  and patch, so `mapToApiPayload(tenantId, record, action)` takes a third
  `action` argument (`'post'` or `'put'`) to build the right operation
  envelope — sales-lead-api tenants ignore this argument.
- classscout's ingest credential has **no readable list/get endpoint** —
  `getApiEndpoint('classscout', 'list'|'get')` throws on purpose. Verify
  writes via `runtime/verifier/response-based.js` against the `POST
  /api/ingest` response's own per-operation `{ok, error?}` results, not a
  re-fetch (`runtime/verifier/list-based.js` does not apply to this tenant).

An earlier classscout integration attempt existed in this repo's very first
commit and was torn out ~20 hours later when the repo was repositioned as
sales-lead-only (see `docs/RUNTIME_ARCHITECTURE_NOTES.md`); its leftover
`_mapClassScout`/`_validateProgram` code targeted a placeholder
`classscout-api.vercel.app`/`POST /api/programs` that never matched
classscout's real API. The current `program-api` implementation is a full
rewrite against classscout's actual `POST /api/ingest` contract and its
`curatedProviderSchema` — see the docblocks on `_mapClassScout`/
`_validateProgram` in `schema-mapper.js` and the Tenant Block / "The Real
Schema" sections of `prompts/discovery/classscout.md` for the specifics
(category is the program FORMAT not the subject, ageRanges uses an en dash,
`image`/`website` are hard-required with no image-optional path). classscout
ships **paused** like `dvsc` did — real `INGEST_API_KEY`/`IMGBB_API_KEY`
credentials are needed in `.env.classscout` before either `enabled` flag can
flip to `true`.

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
    },
    "classscout": {
      "discovery": { "enabled": true },
      "enrichment": { "enabled": true }
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

`classscout` is live as of 2026-08-03 — `INGEST_API_KEY` is confirmed
working against classscout.ai's real `/api/ingest` (see
`scripts/test-classscout-live.js`), and its scope is currently narrowed to
sport-thematic Classes/Camps in Manhattan/Brooklyn only (see the "Narrowed
Focus" section in `prompts/discovery/classscout.md` and
`docs/RUNTIME_ARCHITECTURE_NOTES.md`'s classscout section for why and by
whom). `cogmap`/`seyu` are also active — a 2026-08-03 change briefly paused
both of them alongside narrowing classscout, on an out-of-band instruction
not visible in this repo; they were restored to active the same day once
the repo owner confirmed that pause was unintended. See
`docs/RUNTIME_ARCHITECTURE_NOTES.md` for the full incident.

The cron-generator reads these flags to include/exclude operations in the cron schedule.

## Deployment

Deployed on Vercel as a Next.js App Router project. The `vercel.json` is empty (`{}`) so Vercel auto-detects the framework. The build command is `next build` and the dev command is `next dev`.

The admin UI at `/admin` provides a dashboard for managing apps, tenants, and the job queue. API routes at `/api/admin/*` handle CRUD operations (API key required). The landing page at `/` links to the admin panel and health check.

## Prohibited

- No cross-tenant field writes
- All prompt content + runtime config lives in this repo only

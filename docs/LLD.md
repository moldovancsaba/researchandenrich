# Low-Level Design — researchandenrich

**First written:** 2026-08-02, compiled directly from the real source (export lists, import graphs, route handlers) — every claim below was verified against a real file, not inferred. This sits one level below `docs/RUNTIME_ARCHITECTURE_NOTES.md` (system-level findings and drift history) — this doc is the module-by-module inventory: every config file's real schema, every function's real exports, every route's real behavior.

This repo has two genuinely separate halves, easy to conflate but load-bearing to keep distinct:

1. **The agent pipeline** (§1–§7) — static config (`tenants.json`, `apps.yaml`, `workers/`), the OpenClaw-format prompt files, `schema-mapper.js`, the `runtime/` helper library, and the `search-router/` MCP server. This is what an OpenClaw cron job actually reads and executes to discover/enrich leads and write them into the separate `salesleadgenerator` deployment.
2. **The `/admin` Next.js dashboard** (§8) — a small app for browsing/editing the same tenant config through a UI, backed by its own MongoDB collections that are **not** the same source of truth as the static files in half 1 (§8.3).

Nothing in this repo actually `require()`s `schema-mapper.js` or the `runtime/*` modules today (confirmed by a repo-wide grep) — they're the documented, intended contract an OpenClaw cron-embedded prompt is expected to follow, plus a regression check (`scripts/verify-schema-mapper.js`) that exercises them directly. If a future runtime orchestrator is built that actually calls these programmatically, this is where it would plug in.

---

## 1. Static config

### 1.1 `tenants.json` (repo root)

Single top-level key `tenants: { [tenantId]: {...} }`. Real entries: `cogmap`, `seyu`, `dvsc` (all `app: "researchandenrich"`, `schemaFamily: "sales-lead-api"`), and `classscout` (`app: "classscout"`, `schemaFamily: "program-api"`, no `forecastModel` -- that field is sales-lead-api-only).

| field | example | purpose |
|---|---|---|
| `app` | `"researchandenrich"` | which `apps.yaml` app this tenant belongs to |
| `displayName` | `"CogMap"` | UI label |
| `status` | `"active"` \| `"paused"` | drives `cron-generator.js`'s enable/disable logic |
| `apiBase` | `"https://salesleadgenerator.vercel.app"` | target API host |
| `board` | `"cogmap"` | legacy Kanban-board id; explicitly **not** used for API routing (routing uses `brand=`) |
| `scope` | free text | ICP description — documentation only, not enforced in code |
| `brandFields` | `{pro: "pro_for_organization", con: "con_for_organization"}` | which payload keys carry the pro/con narrative; identical across all 3 tenants |
| `forbiddenFields` | `[]` for all 3 | fields `mapToApiPayload` strips before mapping |
| `iceScoring` | `true` | flag consumed only by prompts/admin UI, not `schema-mapper.js` |
| `schemaFamily` | `"sales-lead-api"` | dispatch key `schema-mapper.js` switches on (`'sales-lead-api'` or `'program-api'`) — the field that replaced every hardcoded tenant-ID branch (2026-08-02 fix) |
| `forecastModel` | `"deal-size-band"` (cogmap, dvsc) \| `"pricing-by-company"` (seyu) | which forecast-normalization branch runs in `_mapSalesLeadApi` |
| `discovery` / `enrichment` | `{prompt, schedule: {kind: "every", everyMs}, mode: "feeder", enabled}` | per-operation prompt path + cadence + independent enable flags |

`dvsc` is fully populated but both `discovery.enabled`/`enrichment.enabled` are `false` and `status` is `"paused"`.

### 1.2 `apps.yaml` (repo root)

Two entries in the `apps:` map. `researchandenrich`: `appId`, `displayName`, `description`, `tenants: [cogmap, seyu, dvsc]`, `verifier: runtime/verifier/list-based.js`, `schemaMapper: schema-mapper.js` (fixed to the real repo-root path 2026-08-02 — previously incorrectly said `runtime/schema-mapper.js`), `healthCheckTemplate: "GET /api/leads?brand={{tenant}}&limit=1"`, `maxResultsPerRun: 5`, `requireDecisionMaker: true`. `classscout`: a separate app (structurally different target API, not just a different tenant of the same app) — `tenants: [classscout]`, `verifier: runtime/verifier/response-based.js` (no readable list/get endpoint under the ingest credential, so `list-based.js` doesn't apply), `schemaMapper: schema-mapper.js` (shared file, dispatches on `schemaFamily` same as always), `healthCheckTemplate: "GET /api/ingest"`, `requireDecisionMaker: false` (not a sales concept for provider research).

### 1.3 `workers/<tenant>/*.yaml`

Eight files: `workers/{cogmap,seyu,dvsc,classscout}/{discovery,enrichment}.yaml`. Shared shape:

```yaml
tenant: <id>
operation: discovery|enrichment
prompt: prompts/<operation>/<id>.md
schedule: { kind: every, everyMs: 2700000 }
retry: { maxAttempts: 3, backoffMs: 5000 }
timeoutMs: 300000
dependencies: []                 # enrichment.yaml has [<tenant>-discovery]
healthCheck: { endpoint: "GET /api/leads?brand=<id>&limit=1", expectedStatus: 200 }
```

This is the real source of truth `config/cron-generator.js` reads. Every tenant's cadence is identical today — 45 minutes / 2,700,000 ms.

---

## 2. `schema-mapper.js` (repo root, ~414 lines)

Exports a single class, `module.exports = SchemaMapper`. Constructor eagerly loads `tenants.json` via `fs.readFileSync` into `this.tenants`.

**Public methods:**
- `getTenant(tenantId)` — looks up `this.tenants[tenantId]`, throws `Unknown tenant` if missing.
- `listTenants()` — maps all tenants to `{id, name, app, discoveryEnabled, enrichmentEnabled}`.
- `mapToApiPayload(tenantId, genericRecord, action='post')` — the anti-contamination gate. Clones the record, strips `tenant.forbiddenFields`, then dispatches purely on `tenant.schemaFamily`: `'sales-lead-api'` → `_mapSalesLeadApi()`, `'program-api'` → `_mapClassScout()`. Unknown/missing `schemaFamily` throws. **No tenant-ID branching anywhere** — grep for `case 'cogmap'`/`tenantId ===` returns nothing. The third `action` parameter (`'post'`|`'put'`) is new for `program-api` — sales-lead-api ignores it (its two HTTP verbs map to two different URLs, decided by the caller).
  - `_mapSalesLeadApi(tenant, payload)` — standardizes contacts, then mutually-exclusively normalizes `recommended_tier`/`revenue_model`/`estimated_participants`/`estimated_annual_revenue_usd`/`product_fit_notes` if `tenant.forecastModel === 'deal-size-band'`, or `pricingByCompany` (currency uppercase, `pricing_model` vocabulary, numeric clamps) if `tenant.forecastModel === 'pricing-by-company'`.
  - `_mapClassScout(tenant, payload, action)` — builds classscout's real `Provider` shape (`curatedProviderSchema`), not a flat lead/program record. `action === 'post'`: wraps a single new provider as `{operations: [{resource: 'providers', action: 'upsertMany', documents: [provider]}]}`, filling in neutral defaults for editorial-only fields (`rating: 0`, `reviewCount: 0`, `badges: []`) that a research agent has no basis to report. `action === 'put'`: wraps only-changed fields as `{operations: [{resource: 'provider', action: 'patch', id, patch}]}`. Fully rewritten 2026-08-02 from an earlier dormant version that targeted a fictional `POST /api/programs` endpoint — see `docs/RUNTIME_ARCHITECTURE_NOTES.md`'s classscout section for that history.
- `validateForTenant(tenantId, payload)` → `{valid, errors[]}`. Checks `tenant.qualityGate?.requiredFields` (not populated by any real tenant today — effectively a no-op), checks `forbiddenFields` absence, dispatches to `_validateLead`/`_validateProgram` on `schemaFamily`. `payload` here is the already-`mapToApiPayload`-mapped result, not the raw generic record (matters for `program-api`, whose validator reads `payload.operations[0]`).
  - `_validateLead` — contacts-is-array, lowercase-email, international-format phone (`+` prefix), `pro_for_organization`/`con_for_organization` must be `string | string[]`, plus `deal-size-band`-specific tier/revenue-model/numeric checks when applicable.
  - `_validateProgram` — validates the mapped ingest envelope against classscout's real Provider contract: `id` matches `/^prov-[a-z0-9-]+$/`, `category` is one of exactly 4 FORMAT values (Classes/Camps/Birthday Parties/Drop-In Activities — not a subject taxonomy), `ageRanges` entries are in the closed en-dash 5-bucket vocabulary, `image` is a non-empty `i.ibb.co` URL, `website` is a valid URL — on `action: 'patch'` only present fields are checked (partial update); on create, all required fields are checked.
- `getApiEndpoint(tenantId, action, id=null)` — dispatches on `schemaFamily`. For `sales-lead-api`: `list`/`get`/`post`/`put`/`health`/`stats`, and **every** action (not just `list`) appends `?brand=${tenantId}` explicitly — fixed 2026-08-02, since salesleadgenerator's `resolveBrand()` silently defaults a missing/unrecognized brand to `'cogmap'` rather than erroring (verified live: a real `POST /api/leads?brand=dvsc` succeeds today — there is no brand whitelist on salesleadgenerator's side). For `program-api`: `post`/`put`/`health` all resolve to the single real `${base}/api/ingest` endpoint (classscout has one write endpoint for both create and patch — the operation type lives in the body, not the URL); `list`/`get` throw on purpose (no ingest-credential-readable route exists).
- `getEnrichmentCriteria(tenantId)` / `getQualityGate(tenantId)` — return `tenant.enrichmentCriteria || {}` / `tenant.qualityGate || {}` (neither populated by any real tenant today).
- `_standardizeContacts(payload)` (private) — lowercases `contacts[].email` and `decision_maker_contact`.

**Onboarding a new same-family tenant needs only a `tenants.json` entry — zero code changes here.** Regression-tested by `scripts/verify-schema-mapper.js` (§7), which exercises every real tenant plus a synthetic tenant deliberately absent from `tenants.json` to prove that claim.

---

## 3. `runtime/` directory

### `runtime/verifier/list-based.js`

Three exports: `{verifyViaList, verifyBatchViaList, healthCheck}`.
- `verifyViaList({apiBase, brand, recordId, collectionType, apiKey, expectedCount})` — fetches `/api/leads?brand=<brand>&limit=1000` (or `/api/programs?limit=100`) and searches the returned array for a record matching `_id`/`id`. Returns `{confirmed, status, totalRecords, matched, recordId, collectionType}`. Its own doc comment states direct GET-by-ID (`/api/leads/<id>`) is "unreliable and must not be used."
- `verifyBatchViaList(...)` — loops `verifyViaList` per id, returns `{confirmed (all), confirmedCount, totalCount, results[]}`.
- `healthCheck({apiBase, endpoint, apiKey, expectedStatus=200})` — single GET with timing, returns `{healthy, status, expectedStatus, durationMs, error}`.

### `runtime/shared/http-client.js`

Exports `{httpClient}`. `httpClient(url, {timeoutMs=10000, headers, method='GET', body, maxRetries=3})` — `AbortController`-based timeout, retries on 429 (honors `retry-after` header) and 5xx with exponential backoff (`INITIAL_BACKOFF_MS=1000`, capped `MAX_RETRY_DELAY_MS=30000`), returns `{data, status}` or `{error, status, message}`.

### `runtime/shared/retry.js`

Exports `{retry, sleep}`. `retry(fn, {maxAttempts=3, initialDelayMs=1000, maxDelayMs=30000, multiplier=2, shouldRetry})` — generic exponential-backoff wrapper returning `{success, result|error, attempts}`.

### `runtime/shared/cache.js`

Exports `{createCache}`. `createCache({defaultTTL=300000, maxEntries=1000})` returns `set/get/has/delete/clear` + a `size` getter — a `Map`-backed TTL cache with FIFO eviction at capacity (evicts `cache.keys().next().value`). ⚠ The file's own docblock claims "LRU eviction" — it is not; it's FIFO, not access-order-aware. A minor, low-risk doc/comment inaccuracy inside the source itself, noted here rather than silently reproduced.

---

## 4. `config/` directory

### `config/cron-generator.js`

CLI entry (`node config/cron-generator.js [--dry-run]`). Exports `{generateCronYaml, discoverWorkers, loadTenantConfig}`.
- `loadTenantConfig()` — reads `tenants.json`.
- `loadWorkerYaml(filePath)` — a **hand-rolled, non-library YAML parser** (no `js-yaml` dependency), intentionally limited to this repo's flat worker-YAML shape.
- `discoverWorkers()` — walks `workers/<tenantDir>/*.yaml`, returns `{[tenantId]: {[operation]: parsedYaml}}`.
- `generateCronEntry(tenantId, tenantConfig, operation, workerConfig)` — merges tenant status (`paused`/`disabled` → force-disabled) with per-operation `tenants.json` enabled flags and the worker YAML's own `enabled`. Falls back to `*/45 * * * *` / `Europe/Budapest` if a worker YAML doesn't specify `schedule.cron`/`.tz` — none currently do (all use `schedule.kind: every`), so the generator's own defaults are what actually populate `cron.yaml`, not a translation of `everyMs`.
- `generateCronYaml(tenants, workers)` — hand-assembles the YAML text (`lines.join('\n')`), not via a YAML serializer.
- `main()` — writes `config/cron.yaml` (or prints for `--dry-run`).

### `config/cron.yaml` (generated artifact)

Header: "Do not edit manually." 6 entries (one per tenant × operation). Confirmed in sync with a fresh `node config/cron-generator.js` run (2026-08-02 audit) — `git diff` after regenerating showed zero changes, including `dvsc-discovery`/`dvsc-enrichment` both `enabled: false` matching `tenants.json`'s `paused` status.

### `config/healthcheck.yaml` / `config/retry-policy.yaml`

Static defaults, not generated. `healthcheck.yaml`: per-family health endpoint templates + `maxResponseTimeMs: 5000`. `retry-policy.yaml`: global retry/timeout/logging defaults (`maxAttempts: 3`, `initialDelayMs: 1000`, `defaultMs: 300000`, etc.).

---

## 5. `prompts/discovery/*.md` and `prompts/enrichment/*.md`

Eight OpenClaw-format Markdown files (not JSON/YAML): `prompts/discovery/{cogmap,seyu,dvsc,classscout}.md` and `prompts/enrichment/{cogmap,seyu,dvsc,classscout}.md`. `classscout.md`'s pair are structurally the same skeleton but a different tenant block/schema entirely -- see the "The Real Schema" and "Image Sourcing" sections of `prompts/discovery/classscout.md` for what's genuinely new versus the sales-lead-api tenants.

**Common to all 6:**
- Start-up: `source "$HOME/.openclaw/workspace/.env.<tenant>"`, reads `SLG_API_KEY` (cogmap/dvsc) or `SEYU_API_KEY` (seyu) for `x-api-key`.
- Search/router usage: invokes the router via the absolute path `"$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router/AgentFinder"` (stdio MCP); falls back to raw `web_fetch` if unavailable; explicitly forbids ad-hoc `web_search` in cron context.
- "Fixed-Tenant Contract": one tenant per run, no round-robin state, `brand=<tenantId>` routing (never `board=`), list-based verification only, stop-don't-retry on rate-limit.
- Enrichment files additionally specify `PUT /api/leads/<id>` with only-changed-fields, and explicitly reject a nonexistent `PATCH /api/leads?action=ENRICH` path.
- Critical Revenue Rule: never write `estimated_annual_revenue_usd` directly — only the signal fields the backend derives it from.
- Settings Calibration section (cogmap/dvsc only, seyu lacks it): `GET /api/sales-settings/<brand>?tenantId=default` — explicitly not `/api/settings`, a documented prior bug.
- Verification Contract: `GET /api/leads?brand=<tenantId>&limit=1000` — explicit "DO NOT use GET /api/leads/<id>."

**Tenant-specific**: `cogmap.md` is the largest (full ICP/scoring-rubric essay, plus embedded Seyu template sections a cogmap-only reader wouldn't expect); `seyu.md` is the leanest (compact 12-field list, ICE rubric, brand-specific Value Prop forbidden-terms rule); `dvsc.md` has DVSC-only sections ("What DVSC Actually Is" — the real sponsorship-inventory categories, "DVSC Forbidden Terms," a note that DVSC reuses cogmap's deal-size-band model with `estimated_participants` always `0`).

---

## 6. `search-router/seyu-search-router/`

Self-contained npm package (own `package.json`, `package-lock.json`, `test/` — 5 test files, README claims 24 passing assertions), referenced from repo root via `.mcp.json` and `search-router/bin/run-router-search.sh`.

`package.json`: `"type": "module"`, `main: src/index.js`, deps `@modelcontextprotocol/sdk ^1.29.0` + `zod ^4.4.3`.

**Internal structure (`src/`)**:
- `index.js` — MCP server entrypoint over `StdioServerTransport`. Registers 4 tools: `web_search`, `media_search`, `fetch_page` (Parallel-only, no fallback), `engine_health`.
- `router.js` — `class SearchRouter({config, persistDir, clientFactory, engines, customEngines, routes})` (all injectable for tests). Orchestrates: circuit check → rate limit → cache → call engine → record result.
- `engines/registry.js` — `ENGINES` (declarative per-engine specs) + `ROUTES` (`queryType → [engineId,...]`: `general`→parallel→youcom→wiby, `news`→gdelt→parallel→youcom, `url_inventory`→commonCrawl→waybackCdx, `media_images`/`media_audio`→openverse, plus disabled `domain_repeat`/`decentralized` routes).
- `engines/restRunner.js`, `engines/mcpUpstreamAdapter.js`, `engines/commonCrawl.js` — the three real engine-execution strategies (declarative REST, MCP-upstream client, two-step Common Crawl).
- `resultSchema.js` — `makeResult(...)` + `mergeResults(allResults)` (URL-dedup with cross-engine provenance merge).
- `cache.js`, `circuitBreaker.js`, `rateLimiter.js` (`MinIntervalLimiter` + `DailyBudgetLimiter`, the latter persisting to `.state/<engine>.budget.json`), `httpClient.js`.

**How a prompt invokes it**: every prompt file's own path (`$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router/AgentFinder`), speaking stdio MCP directly — **not** through this repo's own `.mcp.json` (§9), which is a separate, newer integration specifically for Claude Code agents, not referenced by any existing OpenClaw prompt (deliberately left untouched, per `docs/RUNTIME_ARCHITECTURE_NOTES.md` §5).

`search-router/agent-runtime.json` — a smaller policy override layer (`defaultQueryType`, per-engine enable/priority, a `routes` map for `discover_candidates`/`verify_source`/`historical`), distinct from `registry.js`'s own `ROUTES`.

---

## 7. `scripts/*.js`

Exactly two scripts (no test framework configured — `package.json` has no `test` script).

### `scripts/sync-dvsc-to-admin.js`

CLI, `ADMIN_API_KEY=... node scripts/sync-dvsc-to-admin.js --api-base <url>`. Deliberately no hardcoded API-base default (this repo doesn't document its own deployed admin URL anywhere). Closes the "two unsynced config sources" gap (§8.3) specifically for `dvsc` by POSTing into the Mongo-backed `/api/admin/{apps,tenants}` API. Idempotent (`ensureApp()`/`ensureTenant()` GET-then-skip). Its own header discloses it has **not been run against a live deployment** — no credentials were available in the authoring sandbox.

### `scripts/verify-schema-mapper.js`

CLI, `node scripts/verify-schema-mapper.js`. Plain dependency-free Node script (Node's built-in `assert`), not a test framework. Regression-guards `schema-mapper.js`'s dynamic dispatch — specifically the bug class that broke DVSC's POST path (a missing `dvsc` case in a hardcoded switch, before the 2026-08-02 fix). Exercises `getApiEndpoint`/`mapToApiPayload`/`validateForTenant` against every real `sales-lead-api` tenant, plus a synthetic `newbrand` tenant **not present in `tenants.json`** (proving the "zero code change for a new same-family tenant" claim), plus a `broken` tenant with no `schemaFamily` (proving it throws rather than silently defaulting). Exits non-zero on failure.

---

## 8. Next.js `/admin` app

### 8.1 Routes (`app/api/admin/`)

All four import `requireApiKey` from `lib/api-auth.ts` and `clientPromise` from `lib/mongodb.ts`; all set `export const dynamic = 'force-dynamic'`.

- `app/api/admin/apps/route.ts` — `GET` (list from `contentcreator_apps`), `POST` (create; 409 if `appId` exists).
- `app/api/admin/apps/[appId]/route.ts` — `GET` (404 if missing), `PUT` (shallow-merge replace via `replaceOne`), `DELETE` (409 if `tenantIds.length > 0`).
- `app/api/admin/tenants/route.ts` — `GET` (list from `contentcreator_tenants`), `POST` (create; 409 if exists).
- `app/api/admin/tenants/[tenantId]/route.ts` — `GET`, `PUT` (shallow-merge replace), `DELETE`.
- `app/api/admin/queue/route.ts` — `GET` (synthesizes up to 2 "jobs" per tenant — discovery+enrichment — from the Mongo tenants collection; special-cases `appId === 'classscout-api'`, the concrete evidence a tenant was onboarded into Mongo with no corresponding static-file entry anywhere in this repo, see §8.3). `PUT` (bulk sortOrder/schedule update from drag-and-drop). `PATCH` (toggle single job's `enabled`).
- `app/api/leads/route.ts` — **not a real admin route** — a lightweight local stub/mock (`GET` returns `{leads: []}`, `POST`/`PUT` echo the body back). The real leads API this pipeline actually targets lives in the separate `salesleadgenerator` deployment (`tenants.json`'s `apiBase`), not here.
- `app/api/health/route.ts` — trivial `{status: "ok", framework: "nextjs", timestamp}`.

### 8.2 Auth (issue #3, fixed)

`lib/api-auth.ts`'s `requireApiKey()` now actually validates the request's `x-api-key` header against `process.env.ADMIN_API_KEY`, returning a `401 NextResponse` on mismatch or a missing header — mirrors salesleadgenerator's own `requireApiKey` (its issue #105) including its fail-open-outside-production / fail-closed-in-production behavior for an unset key. Every `/api/admin/*` route already called this function and treated a non-null return as "reject"; the fix required zero caller-side changes in the five route files.

Two credential callers, corrected in the same change:
- `scripts/sync-dvsc-to-admin.js` already sent `x-api-key: $ADMIN_API_KEY` correctly — no change needed there.
- The admin UI (`app/admin/page.tsx`, `app/admin/queue/page.tsx`) previously sent `x-api-key: NEXT_PUBLIC_SLG_API_KEY` on some requests (a stray reuse of the unrelated sales-lead-generator key, itself already publicly inlined into the browser bundle) and **no header at all** on the queue page's three fetches. Both are now `NEXT_PUBLIC_ADMIN_API_KEY` — its own admin-scoped var, consistently applied. This is still a value visible in the client bundle, not a real secret; the deeper fix (a session/login model for `/admin` so the browser never needs to hold the key at all) is its own, larger M1-milestone piece of work, not part of this change.

### 8.3 Pages

- `app/admin/page.tsx` — 3 tabs (Apps/Tenants/Queue), `loadApps()`/`loadTenants()` fetch `/api/admin/apps?brand=cogmap`/`/api/admin/tenants?brand=cogmap` (the `brand` param is dead — `getBrand()` computes it but the handlers never filter by it), inline `AppForm`/`TenantForm`, inline read-only `QueueView`.
- `app/admin/queue/page.tsx` — the full queue page (fetches tenants + queue in parallel, per-job `toggleJob()` PATCH).
- `app/page.tsx` — public landing page linking into `/admin` and `/admin/queue`.
- `app/layout.tsx` — root layout; top nav literally reads "Sales Lead Generator" / "Admin" — branding bleed from the target app this dashboard manages, not this app's own name.

### 8.4 The "two unsynced config sources" problem, confirmed in code

`config/cron-generator.js` and `schema-mapper.js` both read `tenants.json`/`apps.yaml`/`workers/*` off disk via `fs.readFileSync`. The `/admin` dashboard and its API routes read/write MongoDB collections `contentcreator_apps`/`contentcreator_tenants` exclusively. **Nothing in this repo syncs the two.** `scripts/sync-dvsc-to-admin.js` is the only bridge, and it's unverified (§7). The `classscout-api` special-case in `queue/route.ts` (§8.1) is live evidence the two sources have already drifted — a Mongo-only tenant with zero static-file trace anywhere in this repo.

---

## 9. `.mcp.json` and shared infra

### `.mcp.json` (repo root)

```json
{ "mcpServers": { "search-router": {
  "command": "node",
  "args": ["${CLAUDE_PROJECT_DIR}/search-router/seyu-search-router/src/index.js"]
}}}
```

Declares the search-router as a Claude-Code-discoverable MCP stdio server — a separate integration path from the OpenClaw prompts' own hardcoded `AgentFinder` invocation (§6). Requires `npm install` inside `search-router/seyu-search-router/` first (its `node_modules` is gitignored). Not yet exercised against a live Claude Code session.

### `lib/mongodb.ts`

Exports `getMongoClient(): Promise<MongoClient>` (memoized singleton, rejects if `MONGODB_URI` unset) and a default export `clientPromise`.

---

## 10. Data model — generic record vs. the real target payload

There is **no explicit "ContentCreator record" type** anywhere in this repo — the "generic record" `mapToApiPayload()` maps FROM is an implicit, documentation-only shape: whatever plain object a discovery/enrichment agent assembles per its prompt file's field list (e.g. seyu's 12 fields: `name, url, region, industry, description, contact_name/title/email/phone/address, source_url, source_name`), plus the shared forecast-input fields (`recommended_tier`, `estimated_participants`, `revenue_model`, `product_fit_notes`, `pricingByCompany`) and `contacts[]`/`decision_maker_contact`. `schema-mapper.js` treats it as an untyped `object` — no interface/class defines it in JS/TS anywhere here.

The **target payload** it maps TO is salesleadgenerator's real `Lead` type (`/home/user/salesleadgenerator/app/types.ts`, and see that repo's own `docs/LLD.md` §7.1 for the full shape). Key facts directly relevant to this repo's own contract:
- `pro_for_organization?: string | string[]` / `con_for_organization?: string | string[]` — one shared field pair across all brands, matching `_validateLead`'s `isStringOrStringArray` check exactly.
- `contacts?: Array<{name, title, email, phone, linkedin, role, isDecisionMaker, ...}>` — legacy top-level `decision_maker_*` fields were retired on the target side (salesleadgenerator issue #45); `schema-mapper.js`'s `_standardizeContacts` still touches `payload.decision_maker_contact` defensively even though the real target schema no longer treats it as first-class.
- `ticketSizeEstimate` on the target side is server-computed and authoritative — the agent-supplied forecast-input fields (`recommended_tier` etc.) are only signals feeding it, never trusted directly (matches this repo's own prompts' "backend derives revenue deterministically" rule).
- A submitted `ice.ease` is validated for shape by the target API, then discarded — the server always recomputes it itself.
- Brand/collection routing on the target side: `cogmap→leads` (USD), `seyu→seyu_leads` (EUR), `dvsc→dvsc_leads` (EUR) — one Mongo database, one collection per brand, all reached through the same `brand=<id>` param `schema-mapper.js`'s `getApiEndpoint()` now attaches to every action. The target's own `resolveBrand()` returns `null` (not a silent `'cogmap'` fallback) for a genuinely unrecognized brand — the reason explicit `?brand=` on every action is necessary here, not optional.

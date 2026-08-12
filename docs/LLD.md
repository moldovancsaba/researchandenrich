# Low-Level Design — researchandenrich

**First written:** 2026-08-02, compiled directly from the real source (export lists, import graphs, route handlers) — every claim below was verified against a real file, not inferred. This sits one level below `docs/RUNTIME_ARCHITECTURE_NOTES.md` (system-level findings and drift history) — this doc is the module-by-module inventory: every config file's real schema, every function's real exports, every route's real behavior.

This repo is, in its entirety, **the agent pipeline** (§1–§7): static config (`tenants.json`, `apps.yaml`, `workers/`), the OpenClaw-format prompt files, `schema-mapper.js`, the `runtime/` helper library, and the `search-router/` MCP server. This is what an OpenClaw cron job actually reads and executes to discover/enrich leads/programs and write them into the separate `salesleadgenerator`/`classscout` deployments.

A second half used to exist here — a `/admin` Next.js dashboard backed by its own MongoDB collections, editing a second, UI-facing copy of the same tenant config. It was retired 2026-08-12 (§8) because it never actually stayed in sync with the static files that were always the pipeline's real source of truth. There is no second half anymore; the static config below is the only config.

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

## 7. `scripts/*`

No test framework configured (`package.json` has no `test` script) — every script here is a plain dependency-light Node/bash script with its own explicit pass/fail output.

### `scripts/verify-schema-mapper.js`

CLI, `node scripts/verify-schema-mapper.js`. Plain dependency-free Node script (Node's built-in `assert`), not a test framework. Regression-guards `schema-mapper.js`'s dynamic dispatch — specifically the bug class that broke DVSC's POST path (a missing `dvsc` case in a hardcoded switch, before the 2026-08-02 fix), plus the classscout Provider/MeetupGroup mapping and validation. Exercises `getApiEndpoint`/`mapToApiPayload`/`validateForTenant` against every real tenant, plus a synthetic `newbrand` tenant **not present in `tenants.json`** (proving the "zero code change for a new same-family tenant" claim), plus a `broken` tenant with no `schemaFamily` (proving it throws rather than silently defaulting). 47 checks, exits non-zero on failure.

### `scripts/check-tenant-status-diff.js`

CLI, `node scripts/check-tenant-status-diff.js <base-ref> <head-ref> [--verbose]`. Enforces that a single commit changes `status`/`enabled` for at most one tenant in `tenants.json` (issue #6), run on every push via `.github/workflows/tenant-status-guard.yml`. See `docs/RUNTIME_ARCHITECTURE_NOTES.md` §9 for the incident this exists to catch.

### `scripts/test-classscout-live.js`

CLI, `--mode=health|dry-run|live [--entity=provider|meetupGroup] [--confirm]`. Live integration test against the real classscout deployment — the only script here that makes real authenticated writes (self-cleaning: creates a test record, verifies, deletes it).

### `scripts/assert-credentials-rotated.js` / `scripts/purge-history.sh` (issues #9/#10)

`assert-credentials-rotated.js` is a precondition gate: reads `OLD_COGMAP_MONGODB_URI`/`OLD_SEYU_MONGODB_URI`/`OLD_SLG_API_KEY` from env vars (never hardcoded), attempts to authenticate with each, exits non-zero if any still works or any is missing. `purge-history.sh` chains that gate → a mandatory mirror backup → a fresh clone → `git filter-repo --invert-paths` over the six secret-bearing paths → path- and value-based verification → an explicit `--confirm-force-push` gate before touching the remote. Written and smoke-tested; not run for real against production history — see `docs/RUNTIME_ARCHITECTURE_NOTES.md` §11 for why and what's left.

---

## 8. The `/admin` Next.js app — retired 2026-08-12

This repo used to ship a Next.js `/admin` UI (`app/admin/*`) and `/api/admin/*` API, backed by its own MongoDB collections (`contentcreator_apps`/`contentcreator_tenants`) — a second, database-backed copy of the same tenant/app config the static files (§1) already hold. It has been deleted entirely, not just deprecated: `app/admin/`, `app/api/admin/`, `lib/api-auth.ts`, `lib/mongodb.ts`, and `scripts/sync-dvsc-to-admin.js` are all gone from this repo.

**Why it was removed rather than kept and fixed**, in the order these problems actually surfaced:
- It was **unauthenticated in production** for most of its life (`requireApiKey()` was a permanently-disabled no-op — issue #3, eventually fixed, but only after being live and open for weeks).
- It **never actually stayed in sync** with the static files it duplicated — `dvsc` and `classscout` were missing from it entirely (issue #29), and a `classscout-api` tenant existed in its Mongo collections with zero trace in any static file anywhere in this repo (confirmed live, see the retired §8.4 "two unsynced config sources" writeup, preserved below for history).
- Every fix to the dashboard (auth, sync scripts, session-cookie login) was more surface area to secure and maintain for a config set small enough to hand-edit directly in the files that were always the actual source of truth for the pipeline itself (`config/cron-generator.js` and `schema-mapper.js` never read the Mongo collections — only `fs.readFileSync` on the static files, always).

**What replaces it**: nothing. `tenants.json`, `apps.yaml`, and `workers/<tenant>/*.yaml` are the only config surface now, edited directly in this repository. There is no dashboard, no database-backed config, and no sync step to keep two sources aligned, because there is only one source. See `rae_handover.md` for the complete current operational reference.

**Historical record, preserved for anyone reading old issues/PRs that reference the deleted routes**: the app had `apps`/`apps/[appId]`/`tenants`/`tenants/[tenantId]`/`queue` REST routes (list/create/get/update/delete, plus a synthesized job-queue view), a 3-tab dashboard page and a separate queue page, and `lib/mongodb.ts` exported a memoized `MongoClient` singleton. Issue #3's auth fix (mirroring salesleadgenerator's `requireApiKey`, its issue #105) was real and shipped before the retirement decision — mentioned here only so a reader of that issue's history understands it was fixed, then the whole surface was removed shortly after, not that the fix was reverted.

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

---

## 10. Data model — generic record vs. the real target payload

There is **no explicit "ContentCreator record" type** anywhere in this repo — the "generic record" `mapToApiPayload()` maps FROM is an implicit, documentation-only shape: whatever plain object a discovery/enrichment agent assembles per its prompt file's field list (e.g. seyu's 12 fields: `name, url, region, industry, description, contact_name/title/email/phone/address, source_url, source_name`), plus the shared forecast-input fields (`recommended_tier`, `estimated_participants`, `revenue_model`, `product_fit_notes`, `pricingByCompany`) and `contacts[]`/`decision_maker_contact`. `schema-mapper.js` treats it as an untyped `object` — no interface/class defines it in JS/TS anywhere here.

The **target payload** it maps TO is salesleadgenerator's real `Lead` type (`/home/user/salesleadgenerator/app/types.ts`, and see that repo's own `docs/LLD.md` §7.1 for the full shape). Key facts directly relevant to this repo's own contract:
- `pro_for_organization?: string | string[]` / `con_for_organization?: string | string[]` — one shared field pair across all brands, matching `_validateLead`'s `isStringOrStringArray` check exactly.
- `contacts?: Array<{name, title, email, phone, linkedin, role, isDecisionMaker, ...}>` — legacy top-level `decision_maker_*` fields were retired on the target side (salesleadgenerator issue #45); `schema-mapper.js`'s `_standardizeContacts` still touches `payload.decision_maker_contact` defensively even though the real target schema no longer treats it as first-class.
- `ticketSizeEstimate` on the target side is server-computed and authoritative — the agent-supplied forecast-input fields (`recommended_tier` etc.) are only signals feeding it, never trusted directly (matches this repo's own prompts' "backend derives revenue deterministically" rule).
- A submitted `ice.ease` is validated for shape by the target API, then discarded — the server always recomputes it itself.
- Brand/collection routing on the target side: `cogmap→leads` (USD), `seyu→seyu_leads` (EUR), `dvsc→dvsc_leads` (EUR) — one Mongo database, one collection per brand, all reached through the same `brand=<id>` param `schema-mapper.js`'s `getApiEndpoint()` now attaches to every action. The target's own `resolveBrand()` returns `null` (not a silent `'cogmap'` fallback) for a genuinely unrecognized brand — the reason explicit `?brand=` on every action is necessary here, not optional.

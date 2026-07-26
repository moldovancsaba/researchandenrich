# ContentCreator — Modular Discovery & Research System

## Overview

ContentCreator is a unified research and enrichment agent runtime serving multiple clients across two applications. It discovers leads (`cogmap`, `seyu` under salesleadgenerator) and programs (classscout-api), enriching them with verified contact data, ICE scoring, and source attribution.

The system is designed around two axes of growth:
- **Axis 1** — Add a new client/tenant to an existing app (5 steps, no code changes)
- **Axis 2** — Add an entirely new app with different domain, schema, and infrastructure (6+ steps)

## Application Map

| App | Endpoint | Tenants | Data Type | Pipeline |
|-----|----------|---------|-----------|----------|
| salesleadgenerator | `https://salesleadgenerator.vercel.app` | cogmap, seyu | Sales leads | DISCOVERED → QUALIFIED → ENGAGED → PROPOSAL → WON / LOST |
| classscout-api | `https://classscout-api.vercel.app` | classscout-api | Programs | DRAFT → CHECKED → VERIFIED |

**Hard rule:** ContentCreator never touches the ClassScout core system at `https://classscout.ai`. The classscout-api tenant only researches and writes to its own database via its own API.

---

## Architecture

```
Agents/contentcreator/
├── tenants.json                    # Tenant registry (single source of truth)
├── apps.yaml                       # App-level definitions grouping tenants by app
├── prompts/
│   ├── discovery/                  # One .md per tenant for discovery research
│   │   ├── cogmap.md              # CogMap lead discovery prompt
│   │   ├── seyu.md                # Seyu lead discovery prompt
│   │   └── classscout-api.md      # ClassScout program discovery prompt
│   └── enrichment/                 # One .md per tenant for data enrichment
│       ├── cogmap.md              # CogMap lead enrichment prompt
│       ├── seyu.md                # Seyu lead enrichment prompt
│       └── classscout-api.md      # ClassScout program enrichment prompt
├── runtime/                        # Shared agent runtime code (no tenant-specific logic)
│   ├── verifier/
│   │   └── list-based.js          # List-based verification (avoids GET /<id> 404 inconsistency)
│   └── shared/                     # Shared utilities used by all tenants
│       ├── http-client.js         # HTTP client: timeout, retry, backoff, 429 handling
│       ├── retry.js               # Exponential backoff retry with configurable max attempts
│       └── cache.js               # TTL cache with LRU eviction
├── workers/                        # Per-tenant worker definitions (declarative YAML)
│   ├── cogmap/
│   │   ├── discovery.yaml         # Discovery schedule, prompt ref, retry, health check
│   │   └── enrichment.yaml        # Enrichment schedule, prompt ref, retry, health check
│   ├── seyu/
│   │   ├── discovery.yaml
│   │   └── enrichment.yaml
│   └── classscout-api/
│       ├── discovery.yaml
│       └── enrichment.yaml
├── config/                         # System-level configuration
│   ├── cron.yaml                  # Master cron schedule (auto-generated from workers/*)
│   ├── cron-generator.js          # Generates cron.yaml from worker YAML definitions
│   ├── retry-policy.yaml          # Global retry rules (per-worker overrides allowed)
│   ├── healthcheck.yaml           # Default health check definitions
│   └── apps/                      # Per-app configuration overrides
│       ├── salesleadgenerator.yaml
│       └── classscout-api.yaml
├── schema-mapper.js               # Prevents cross-tenant field contamination
├── state/                          # Ephemeral runtime state (rebuilt on restart)
│   └── last-run/                  # Timestamps per worker per run
├── logs/                           # Historical run logs (immutable, date-partitioned)
│   ├── discovery/<tenant>/YYYY-MM-DD.json
│   └── enrichment/<tenant>/YYYY-MM-DD.json
└── README.md                       # This file — also the onboard guide
```

### File Role Summary

| File | What it controls | Change frequency |
|------|-----------------|------------------|
| `tenants.json` | Tenant status (active/paused/disabled), app grouping, prompt paths, schedules | When adding/removing/pausing tenants |
| `apps.yaml` | App-level definitions, tenant groupings | When adding/removing apps |
| `workers/*/discovery.yaml` | Discovery timing, prompt path, retry, dependencies, health check | When modifying discovery for a tenant |
| `workers/*/enrichment.yaml` | Enrichment timing, prompt path, retry, dependencies | When modifying enrichment for a tenant |
| `prompts/discovery/*.md` | Discovery research instructions per tenant | When changing research strategy |
| `prompts/enrichment/*.md` | Enrichment instructions per tenant | When changing enrichment strategy |
| `config/cron.yaml` | Master cron schedule (auto-generated) | **Never edit manually** |
| `config/retry-policy.yaml` | Retry/backoff rules | When changing retry behavior |
| `config/healthcheck.yaml` | Health check defaults | When changing health check rules |
| `config/runtime/*.yaml` | Advanced runtime config (timeout, rate limits, etc.) | Rarely |
| `runtime/verifier/list-based.js` | How discovery/enrichment verify results | When changing verification logic |
| `runtime/shared/http-client.js` | How HTTP calls are made | When changing HTTP behavior |
| `runtime/shared/retry.js` | Retry utility | When changing retry strategy |
| `runtime/shared/cache.js` | Caching utility | When adding caching |
| `schema-mapper.js` | Cross-tenant field isolation | When adding/removing fields |
| `README.md` | This documentation | When onboarding or changing architecture |

---

## Onboarding a New Client (Same App) — 5 Steps

Example: Adding `fitnessmap` as a new sales-lead client (same app as cogmap/seyu).

1. **`tenants.json`** — Add entry with `status: "paused"` initially:
   ```json
   "fitnessmap": {
     "status": "paused",
     "app": "salesleadgenerator",
     "discovery": { "prompt": "prompts/discovery/fitnessmap.md", "schedule": { "kind": "every", "everyMs": 2700000 } },
     "enrichment": { "prompt": "prompts/enrichment/fitnessmap.md", "schedule": { "kind": "every", "everyMs": 2700000 } },
     "brandFields": { "pro": "pro_for_fitnessmap", "con": "con_for_fitnessmap", "valueProp": "fitness venue assessment" },
     "forbiddenFields": ["pro_for_cogmap", "con_for_cogmap", "pro_for_seyu", "con_for_seyu", "value_prop"],
     "iceScoring": true,
     "apiBase": "https://salesleadgenerator.vercel.app"
   }
   ```

2. **`workers/fitnessmap/discovery.yaml`** — Define schedule, prompt ref, retry, dependencies, health check.

3. **`workers/fitnessmap/enrichment.yaml`** — Same structure.

4. **`prompts/discovery/fitnessmap.md`** — Discovery prompt with ICP, eligibility rules, and data collection fields.

5. **`prompts/enrichment/fitnessmap.md`** — Enrichment prompt with field priority and quality gates.

6. Run `node config/cron-generator.js` to regenerate `config/cron.yaml`.
7. Set `status: "active"` in `tenants.json`.

## Onboarding a New App (New Research Domain) — 6+ Steps

Example: Adding `eventfinder` app with different API endpoints, schema, and verification.

1. **`apps.yaml`** — Add app definition:
   ```yaml
   eventfinder:
     displayName: "Event Finder"
     description: "Event research and enrichment"
     tenants: [eventfinder]
     defaults:
       apiBase: "https://eventfinder-vercel-app.vercel.app"
       verifier: "list-based"
       qualityPipeline: ["DRAFT", "CHECKED", "VERIFIED"]
   ```

2. **`config/apps/eventfinder.yaml`** — App-specific overrides:
   ```yaml
   appId: eventfinder
   apiBase: "https://eventfinder-vercel-app.vercel.app"
   verifier: "list-based"
   schemaMapper: "eventfinder-mapper.js"
   searchRouter:
     engines: ["google", "serpapi", "bing"]
   healthCheck:
     method: GET
     endpointTemplate: "/api/events?app=eventfinder&limit=1"
     expectedStatus: 200
     maxResponseTimeMs: 5000
   qualityGate:
     requiredFields: ["name", "provider", "city", "category", "ageRange", "phone_or_email", "address"]
     minSources: 2
     dedup: "sha1(name + provider + city)"
   maxResultsPerRun: 50
   ```

3. **`tenants.json`** — Add tenant entries under the new app.

4. **`workers/eventfinder/discovery.yaml`** + **`enrichment.yaml`**

5. **`prompts/discovery/eventfinder.md`** + **`prompts/enrichment/eventfinder.md`**

6. Run `node config/cron-generator.js` to regenerate `config/cron.yaml`.
7. Set `status: "active"` in tenants.json.

---

## Key Concepts

### Tenant Status
- `active` — Cron runs this tenant normally
- `paused` — Cron skips this tenant; no data changes; can be re-enabled
- `disabled` — Tenant removed from rotation; used for permanent removal after data migration

### Worker YAML Fields
Each `workers/<tenant>/<operation>.yaml` contains:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenant` | string | Yes | Tenant ID (must match key in tenants.json) |
| `operation` | string | Yes | `"discovery"` or `"enrichment"` |
| `prompt` | string | Yes | Path to prompt file (relative to Agents/contentcreator/) |
| `schedule` | object | Yes | Timing: `{ kind: "every" \| "cron", everyMs \| expr, tz? }` |
| `retry` | object | Yes | `{ maxAttempts, backoffMs }` |
| `timeoutMs` | number | Yes | Operation timeout in milliseconds |
| `dependencies` | string[] | Yes | List of worker IDs that must complete first |
| `healthCheck` | object | Yes | `{ endpoint, expectedStatus, maxResponseTimeMs? }` |

### Verification (List-Based Only)
- **salesleadgenerator tenants:** `GET /api/leads?brand=<tenant>&limit=1000` (or limit=100)
- **classscout-api tenant:** `GET /api/programs?limit=100`
- **Never use** `GET /api/leads/<id>` or `GET /api/programs/<id>` — these return 404 even for recently created records.

### ICE Scoring (sales leads only)
Applies to cogmap and seyu only. Disabled for classscout-api.
Formula: `ICE = Impact × Confidence × Ease` (each 1–10), max 1000.

**Impact** (org potential): size base + federation bonus + first-team bonus + S&C dept bonus
**Confidence** (research quality): base 5 + VP strength + pros + cons + verified email + sources + org confirmed
**Ease** (contact quality): 1 (no contact) → 10 (my connection)

**Sort order:** Cards sorted by ICE score within each column; `count * 100` for column count.

### Pipeline Rules
- **Agent-managed:** DISCOVERED → QUALIFIED (automatic)
- **User-managed only:** QUALIFIED → ENGAGED → PROPOSAL → WON / LOST
- **Qualification criteria:** Decision maker email (name + title + email) OR name + title + value proposition

---

## Pause / Restart / Stop

### Pause a Tenant
Edit `tenants.json`: set that tenant's `"status": "paused"`. Takes effect on the next cron cycle. No restart needed.

### Restart a Tenant
1. Set `"status": "active"` in tenants.json
2. Run `node config/cron-generator.js` to regenerate `config/cron.yaml`
3. The next cron cycle picks up where it left off

### Disable All
Set all tenants to `"status": "disabled"`. All cron work stops immediately.

### Re-enable After Finalizing the New System
1. Set `status: "active"` in all tenant entries in tenants.json
2. Run `node config/cron-generator.js` to regenerate `config/cron.yaml`
3. Set `enabled: true` for all entries in `config/cron.yaml`
4. Verify with `make cron-status` or `node config/cron-generator.js --status`

---

## Observability

### Run Logs
Date-partitioned per tenant per operation in `logs/<operation>/<tenant>/YYYY-MM-DD.json`.
Each log entry contains: `runId`, `tenant`, `operation`, `startedAt`, `finishedAt`, `steps` (array of phase names), `recordsCreated/Updated/Skipped`, `health` (response time, status, record count).

### Health Checks
Each worker YAML defines a `healthCheck` endpoint checked before and after runs:
- Sales lead tenants: `GET /api/leads?brand=<tenant>&limit=1`
- Program research tenants: `GET /api/programs?limit=1`
- Results stored in `state/health/<tenant>/<operation>/YYYY-MM-DD.json`

### Failure Alerts
Configured in `config/retry-policy.yaml`:
- `onFailure` — alert when a run fails completely
- `onTimeout` — alert when a run exceeds timeoutMs
- `onRateLimit` — alert on 429 responses
- `onHealthCheckFailure` — alert when health check endpoint returns non-200
- `onValidationError` — alert when discovered/enriched data fails validation

Global retry rules: max 3 attempts, exponential backoff starting at 1s, max delay 30s, multiplier 2x.
Per-worker overrides allowed in worker YAMLs.

### Scheduled Pauses
All cron is currently paused per the maintenance directive. Re-enable when the finalization is done.

---

## Common Patterns

### Adding a New Field to a Tenant's Schema
1. Update the tenant's schema mapper section in `schema-mapper.js`
2. Update the tenant's discovery prompt to collect the field
3. Update the tenant's enrichment prompt to write the field
4. Add the field to `forbiddenFields` of other tenants to prevent cross-contamination

### Changing a Schedule
1. Edit `workers/<tenant>/<operation>.yaml` `schedule` field
2. Run `node config/cron-generator.js` to regenerate `config/cron.yaml`
3. Next cron cycle uses the new schedule

### Adding a Search Engine
1. Edit `config/apps/<app>.yaml` `searchRouter.engines` array
2. Update any tenant-specific prompt with the new engine config

---

## Naming Conventions

| Element | Pattern | Example |
|---------|---------|---------|
| Tenant directory | `workers/<tenant>/` | `workers/cogmap/` |
| Worker YAML | workers/<tenant>/<operation>.yaml | `workers/cogmap/discovery.yaml` |
| Prompt file | prompts/<type>/<tenant>.md | `prompts/discovery/cogmap.md` |
| App config | config/apps/<app>.yaml | `config/apps/salesleadgenerator.yaml` |
| App ID | kebab-case, lowercase | `salesleadgenerator`, `classscout-api` |
| Tenant ID | kebab-case, lowercase | `cogmap`, `seyu`, `classscout-api` |
| App ID reference | matches `app` field in tenants.json | `"app": "salesleadgenerator"` |
| Brand query param | `brand=<tenantId>` | `brand=cogmap` |
| Board name | same as tenant ID | cogmap board, seyu board |

### Consistency Rules
1. Tenant ID in `tenants.json` key must match directory name in `workers/`
2. Tenant ID must match `tenant:` field in worker YAML files
3. Tenant ID must match prefix in prompt filenames (`prompts/discovery/<tenant>.md`)
4. Tenant `app` field value must match an `appId` in `apps.yaml`
5. `brandFields.pro_for_<tenant>` must use the tenant's own prefix, never another tenant's
6. `forbiddenFields` must list cross-tenant fields using correct tenant prefix
7. `schedule.kind` must be either `"every"` or `"cron"` (never `"simple"` or `"interval"`)
8. `dependencies` must reference worker IDs in format `<tenant>-<operation>` (e.g., `cogmap-discovery`)

---

## Data Structures

### Sales Lead (cogmap + seyu)
```json
{
  "_id": "6a6427a6fc8ddbebc706f3f0",
  "entity_name": "FC Dallas Academy",
  "url": "https://fcdallas.com",
  "region": "US",
  "industry": "sports-club",
  "contact_name": "Jane Doe",
  "contact_title": "VP Partnerships",
  "contact_email": "jane@fcdallas.com",
  "contact_phone": "+1-555-0123",
  "contact_mobile": "+1-555-0124",
  "contact_address": "123 Soccer Ln, Austin TX",
  "contacts": [
    { "name": "Jane Doe", "title": "VP Partnerships", "email": "jane@fcdallas.com", "phone": "+1-555-0123" }
  ],
  "value_proposition": "cognitive assessment for player performance analytics",
  "estimated_annual_revenue_usd": null,
  "ice_score": 850,
  "impact": 8,
  "confidence": 7,
  "ease": 15,
  "status": "DISCOVERED",
  "board": "cogmap",
  "brand": "cogmap",
  "sources": [
    { "url": "https://fcdallas.com/about", "name": "Official Website", "timestamp": "2026-07-25T14:30:00Z" }
  ],
  "createdAt": "2026-07-25T14:30:00Z",
  "updatedAt": "2026-07-25T15:00:00Z"
}
```

**Key fields:**
- `contacts[]` is the canonical contact source. Top-level `contact_*` fields are merged into `contacts[]` on write, then cleared.
- `region` uses ISO 3166-1 alpha-2 country codes. If unknown, use `"NA"` (Not Available).
- `url` must start with `https://`.
- `ice_score` is `Impact × Confidence × Ease (1-10 each, max 1000)`. Applies only to sales lead tenants.
- `contacts[].phone` is used as the ease value (8 = mobile phone).

**Verification:** List-based only — `GET /api/leads?brand=cogmap&limit=1000` (or limit=100).

### Program (classscout-api)
```json
{
  "_id": "abc123",
  "name": "Soccer Stars Summer Camp",
  "provider": "NYC Parks Recreation",
  "borough": "Manhattan",
  "category": "sports",
  "age_min": 6,
  "age_max": 14,
  "phone_or_email": "sports@nycparks.org",
  "address": "Central Park North, Manhattan, NY",
  "schedule": "Mon-Fri 9am-3pm, varies by season",
  "pricing": "$200/week",
  "description": "Weekly soccer camp for children ages 6-14 in Central Park.",
  "sources": [
    { "url": "https://www.nycgovparks.org/programs", "name": "NYC Parks", "timestamp": "2026-07-25T14:30:00Z" }
  ],
  "status": "DRAFT",
  "createdAt": "2026-07-25T14:30:00Z",
  "updatedAt": "2026-07-25T15:00:00Z"
}
```

**Quality pipeline:** DRAFT → CHECKED → VERIFIED.
**Verification:** List-based — `GET /api/programs?limit=100`.
**Dedup:** SHA1 fingerprint of `name + provider + borough`.

### Run Log Entry
```json
{
  "runId": "cogmap-discovery-20260725T143000Z",
  "tenant": "cogmap",
  "operation": "discovery",
  "startedAt": "2026-07-25T14:30:00Z",
  "finishedAt": "2026-07-25T14:45:00Z",
  "steps": ["healthCheck", "search", "extract", "enrich", "write", "verify"],
  "recordsCreated": 3,
  "recordsUpdated": 1,
  "recordsSkipped": 0,
  "health": { "status": 200, "responseTimeMs": 1200, "recordCount": 15 }
}
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Cron not firing | Tenant `status` is `"paused"` or `"disabled"` | Set `"status": "active"` in `tenants.json`, regenerate cron.yaml |
| Discovery returns no results | Search router unreachable | Check `runtime/search-router/` health; test AgentFinder manually |
| Enrichment not running | Dependencies not met | Ensure discovery worker succeeds before enrichment starts |
| Cross-tenant data leak | Schema mapper not applied | Verify `schema-mapper.js` runs before all write operations |
| API returns 429 | Rate limiting | Check retry logic in `runtime/shared/http-client.js`; reduce concurrent calls |
| Verification fails | Used GET-by-ID instead of list | Use `GET /api/leads?brand=<tenant>&limit=1000` only |
| Missing prompt file | Worker YAML references wrong path | Verify `prompt` path in worker YAML matches actual file |
| Wrong data for tenant | Prompt not tenant-specific | Ensure each tenant has its own prompt with correct ICP |

---

## Maintenance Schedule

| Task | Frequency |
|------|-----------|
| Check cron status | Daily |
| Review failed run logs | Daily |
| Clean old logs (retain 30 days) | Weekly |
| Verify `config/cron.yaml` matches worker YAMLs | Weekly |
| Review health check trends | Weekly |
| Audit `schema-mapper.js` for field changes | Monthly |
| Review prompt quality across all tenants | Monthly |
| Review apps.yaml for new apps | Monthly |
| Test new-client onboarding flow | Monthly |
| Push SalesLeadGenerator commits | As needed |
| Push ContentCreator workspace docs | As needed |

---

*Last updated: 2026-07-25*

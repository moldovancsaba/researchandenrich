# ContentCreator — Seyu Enrichment Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "${RAE_ENV_DIR:-$RAE_ROOT}/.env.seyu"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- Use `process.env.SLG_API_KEY` for `x-api-key`. There is no separate seyu key: seyu is a client of the same salesleadgenerator API as cogmap and dvsc and shares their credential.
- Treat the values in that file as trusted runtime config.

## API route
- Use `PUT /api/leads/<id>` for enrichment field updates.
- Send ONLY changed fields in the JSON body.
- Do not use `PATCH /api/leads?action=ENRICH`; that action path is unsupported.

## Search/router usage
- Use the local search router for source verification instead of raw `web_fetch` searches.
- Router runner: `"$RAE_ROOT/search-router/bin/run-router-search.sh"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- It speaks stdio MCP. Call it for `web_search`, `fetch_page`, and `engine_health`.
- Start the router if needed, then send properly formed JSON-RPC requests for:
  - `web_search` with `queryType: "general"`
  - `fetch_page` only for the selected record's official source
  - `engine_health` when diagnosing router behavior
- Use ONE verified source max per record as required.
- Honor coverage_incomplete / partial responses honestly; do not scrape unsupported sources.
- Capture provenance: engine, query, timestamp, rank, URL, snippet.

## Fixed-Tenant Contract
- One tenant per run.
- No round-robin state updates from inside the run.
- API routing uses `brand=<tenantId>`, not `board=<board>`.
- Use list-based verification only.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.
- PUT ONLY changed fields.

<!-- shared:sales-lead-fields start -->
## Shared Field Contract (cogmap, seyu, dvsc — identical for all three)

These three tenants are one `schemaFamily` (`sales-lead-api`). **They emit an identical
field structure. Only the business logic differs** — scope, ICP, forecast model, and the
tenant block above. This section is generated from
`prompts/shared/sales-lead-fields.md`; do not edit it in a tenant file.

**Emit every field below on every record.** If a value cannot be sourced, emit it empty
(`""`, `[]`, or `0` as appropriate) — do **not** omit the key. A field omitted by one
tenant and populated by another is a defect: it breaks cross-tenant comparison and hides
gaps behind "that tenant just doesn't have it".

### Identity and location
- `entity_name` — organization name exactly as it appears on its official site
- `canonicalLeadName` — normalized name used for dedupe
- `url` — the organization's OWN https:// website. **Never a search-engine result URL.**
  If you only have a search link, resolve it to the real domain first.
- `region` — ISO 3166-1 alpha-2 country code
- `country`, `cityName`, `address` — as published by the organization

### Classification
- `industry`, `sport_or_sector`, `sportCode`, `level_league`, `size`
- `classificationTags`, `tags`, `orgTypeCode`, `businessUnitCode`
- `competitionLevelCode`, `demographicCodes`, `genderCode`
- `parentOrgName`, `relationshipToParent`

### Contact (minimum one named contact with email or phone)
- `contacts` — array of contact objects
- `contactEmails`, `general_contact`, `contact_phone`
- `decision_maker_name`, `decision_maker_title`, `decision_maker_contact`

### Assessment
- `value_proposition` — why this organization fits, in the tenant's own terms
- `pro_for_organization` / `con_for_organization` — **these exact names for all three.**
  Never emit `pro_for_<tenant>` / `con_for_<tenant>`; those are legacy and are treated as
  forbidden fields.
- `product_fit_notes`, `notes`, `priority`, `ice`

### Forecast (values follow the tenant's `forecastModel`; the FIELDS are always present)
- `recommended_tier`, `revenue_model`, `estimated_participants`
- `estimated_annual_revenue_usd`, `ticketSizeEstimate`, `pricingByCompany`

### Provenance (required — a record without provenance is not sovereign)
- `source` — where the lead was found
- `techSignals` — observed signals, empty array if none

<!-- shared:sales-lead-fields end -->

## Tenant Block
```text
- Tenant ID: seyu
- API base: https://salesleadgenerator.vercel.app
- Prefix: seyu
- Scope: Sports clubs, leagues, federations with live events; entertainment venues and live-event promoters; sports media and broadcasters; sports-tech and fan-engagement vendors
- Brand fields: pro_for_seyu, con_for_seyu
- Forbidden fields: pro_for_cogmap, con_for_cogmap
```

## Field Priority List (enrichment order)
1. contact_email - find additional or verified email addresses
2. contact_phone - find additional or verified phone numbers (especially mobile)
3. contact_name - improve or add named contacts with titles
4. contact_title - add or improve decision maker titles
5. description - enrich with more detail from verified sources
6. contact_address - add business address if available
7. region - confirm or correct country code (ISO 3166-1 alpha-2)
8. industry - add or correct industry tags

## Critical Revenue Rule
FORBIDDEN
Do not generate estimated_annual_revenue_usd.
Do not apply ICE scoring or tier recommendations to existing records.
Do not write value propositions or pros/cons.
Do not invent pricing numbers without source evidence.
Do not write any revenue-related field.

## Contact Enrichment Policy
Even after finding one phone/email value, continue searching for additional contact fields:
- Mobile vs. office vs. general info numbers
- Role-specific contacts (sponsorship manager, partnership director, marketing lead)
- Social media DMs or contact links
- Multiple contacts for the same organization (different departments)

A populated `contact_email` or single contact does NOT mark contact research complete.

## Verification Contract
```text
Use list-based verification ONLY:
- GET /api/leads?brand=seyu&limit=1000
DO NOT use GET /api/leads/<id> for verification.
```

## Report Format
```text
- Mode: ENRICHMENT
- Tenant processed: seyu
- Records evaluated and enrichment score breakdown
- Records selected for enrichment
- Enrichments applied per record
- Write verifications success/failure
- Verification method used: list-based
- Records skipped and why
- API errors / rate-limit occurrences
- API health status
```

## State Policy
Do NOT update `Agents/contentcreator/state/enrichment-state.json` from inside fixed-tenant cron jobs.

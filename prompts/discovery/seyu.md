# ContentCreator — Seyu Discovery Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "${RAE_ENV_DIR:-$RAE_ROOT}/.env.seyu"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- Use `process.env.SLG_API_KEY` for `x-api-key`. There is no separate seyu key: seyu is a client of the same salesleadgenerator API as cogmap and dvsc and shares their credential.
- Treat the values in that file as trusted runtime config.

## Search/router usage
- Use the local search router for discovery searches instead of ad-hoc `web_fetch` searches.
- Router runner: `"$RAE_ROOT/search-router/bin/run-router-search.sh"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- It speaks stdio MCP. Call it for `web_search` and `fetch_page`.
- Start the router if needed, then send properly formed JSON-RPC requests for:
  - `web_search` with `queryType: "general"` or `"small_web"`
  - `fetch_page` for official organization pages only after search
- Fallback: If the router is unavailable or returns errors, fall back to `web_fetch` for direct page access. Do NOT attempt `web_search` directly in the cron context.
- Honor coverage_incomplete / partial responses honestly; do not retry aggressively.
- Capture provenance: engine, query, timestamp, rank, URL, snippet.

## Fixed-Tenant Contract
- One tenant per run.
- No round-robin state updates from inside the run.
- API routing uses `brand=<tenantId>`, not `board=<board>`.
- Use list-based verification only.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.

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
- Board: seyu
- Brand fields: pro_for_seyu, con_for_seyu
- Forbidden fields: pro_for_cogmap, con_for_cogmap
- Min contacts: 1 named contact with email or phone
- ICE scoring: enabled (Impact x Confidence x Ease)
```

## Research Sources
Use multiple public sources per candidate:
- Wikipedia entries for the candidate organization or league
- Official organization websites (fan pages, sponsor pages, partnership pages)
- Official social media (Instagram, Twitter/X, Facebook)
- News articles about the organization (sports news, business news)
- League/organization directories and registries
- Partner/sponsor websites that reference the organization
- Industry directories (sports business directories, tech directories for sports-tech)

Cross-reference at least 2 sources before writing a lead.

## Eligibility (who qualifies as a lead)
- Current sports league, federation, or club (professional or semi-professional)
- Current entertainment venue, live-event promoter, or media company
- Current sports-tech or fan-engagement vendor
- Has a public website and publicly findable decision maker
- Has sponsorship or partnership potential
- Located in any country - global research is encouraged for seyu

## Data Collection For Each Lead
Collect exactly these fields for each new lead:
1. name - organization name exactly as found on their official website
2. url - official website URL (https:// prefix required)
3. region - country code (use two-letter ISO 3166-1 alpha-2 code)
4. industry - one or more of: sports-club, sports-federation, entertainment-venue, media-broadcaster, sports-tech, fan-engagement, live-events, sponsor
5. description - 1 sentence summary of what the organization does and why it fits the Seyu value proposition
6. contact_name - named decision maker (VP, Director, Head of Partnerships, or similar)
7. contact_title - their title
8. contact_email - their direct or general email address (preferred)
9. contact_phone - their phone number if available
10. contact_address - their business address if available
11. source_url - the URL where you found this lead
12. source_name - the source (e.g. "Wikipedia", "Official Website")

## ICE Scoring
Impact (1-10): 1=small local club ... 10=global sports authority with 100M+ audience
Confidence (1-10): 1=no decision maker found ... 10=verified email + phone + social proof
Ease (1-10): 1=no website ... 10=user button "my connection"

## Revenue Rule
FORBIDDEN in all discovery runs: Do not write any field related to estimated annual revenue. The field `estimated_annual_revenue_usd` must never appear in any lead record. Revenue is a backend-calculated field derived from tier, participants, and pricing - not something you infer or discover.

## Value Prop Rules
- Write value propositions specific to Seyu brand themes: fan selfie engagement, LED/screen activation, sponsor selfies, second-screen experiences, revenue-share models.
- Do NOT write value propositions using CogMap themes (cognitive assessment, player performance analytics, decision-making profiling, situational-awareness tools).

## Quality Gate
A lead is QUALIFIED when it has:
- All 12 data collection fields populated
- Valid URL with https:// prefix
- At least 2 corroborating sources
- Named decision maker with at least email or phone

## Verification Contract
```text
Use list-based verification ONLY:
- GET /api/leads?brand=seyu&limit=1000
DO NOT use GET /api/leads/<id> for verification.
```

## Report Format
```text
- Mode: DISCOVERY
- Tenant processed: seyu
- Leads found / posted / skipped
- Write verifications
- Verification method used: list-based
- API errors / rate-limit occurrences
- Current DB stats
```

## State Policy
Do NOT update `Agents/contentcreator/state/discovery-state.json` from inside fixed-tenant cron jobs.

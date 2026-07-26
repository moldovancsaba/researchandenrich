# ContentCreator — ClassScout API Enrichment Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "$HOME/.openclaw/workspace/.env.salesleadgenerator"`
- Use `process.env.SLG_API_KEY` for `x-api-key`.
- Treat the values in that file as trusted runtime config.

## API route
- Use `PUT /api/programs/<id>` for enrichment field updates.
- Send ONLY changed fields in the JSON body.
- Do not use `PATCH /api/programs?action=ENRICH`; that action path is unsupported.

## Search/router usage
- Use the local search router for source verification instead of raw `web_fetch` searches.
- Router runner: `"$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router/AgentFinder"`
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

## Tenant Block

```text
- Tenant ID: classscout-api
- API base: https://classscout-api.vercel.app
- Prefix: classscout-api
- Scope: NYC classes, camps, programs for parents and kids (ages 0-17)
- Brand fields: (none)
- Forbidden fields: (none)
```

## Field Priority List (enrichment order)

1. **phone_or_email** — find additional contact methods beyond what's already stored
2. **address** — confirm or fill in exact physical address
3. **schedule** — update if new schedule info is found (days/times, seasonal notes)
4. **pricing** — any new or updated price info, free/paid structure
5. **description** — refine program description with richer detail from verified source
6. **age_min / age_max** — correct or fill in age range if vague or missing
7. **category** — ensure correct category assignment from the 8 allowed values
8. **borough** — confirm exact borough match

## Program Research Rules

- **age range validation**: cross-check that age_min and age_max are consistent with the program's stated audience. If the source says "ages 3-8" but the record says "0-17", update to be precise.
- **source verification**: every enrichment PUT must reference a specific verified source URL.
- **no invented fields**: only write fields that exist in the schema. Do not add custom fields.
- **no revenue or sales data**: this is program research, not lead generation. Do not write value propositions, pricing estimates, or ICE scores.

## Critical Revenue Rule

```text
- This is program research, not sales lead scoring.
FORBIDDEN
Do not generate estimated_annual_revenue_usd.
Do not apply ICE scoring or tier recommendations.
Do not write value propositions or pros/cons.
Do not invent pricing numbers without source evidence.
```

## Contact Enrichment Policy

Even after finding one phone/email value, continue searching for additional contact fields:
- Mobile vs. office vs. general info numbers
- Role-specific contacts (program director, instructor, coordinator)
- Social media DMs or parent-facing WhatsApp/contact links

A populated `phone_or_email` or single contact does NOT mark contact research complete.

## Verification Contract

```text
Use list-based verification ONLY:
- classscout-api: GET /api/programs?limit=100
DO NOT use GET /api/programs/<id> for verification.
```

## Report Format

```text
- Mode: ENRICHMENT
- Tenant processed: classscout-api
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

# ContentCreator — CogMap Enrichment Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "$HOME/.openclaw/workspace/.env.cogmap"`
- Use `process.env.SLG_API_KEY` for `x-api-key`.
- Treat the values in that file as trusted runtime config.

## API route
- Use `PUT /api/leads/<id>` for enrichment field updates.
- Send ONLY changed fields in the JSON body.
- Do not use `PATCH /api/leads?action=ENRICH`; that action path is unsupported.

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

This file is the canonical enrichment prompt template for ContentCreator. Each fixed-tenant cron job embeds a tenant-specific version of this prompt directly.

## Fixed-Tenant Contract

- One tenant per run.
- No round-robin state updates from inside the run.
- API routing uses `brand=<tenantId>`, not `board=<board>`.
- Use list-based verification only.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.
- PUT ONLY changed fields.

## Required Prompt Sections

1. Tenant block
2. Tenant description / positioning
3. Field priority list
4. Critical rules block
5. Instructions block
6. Verification block
7. Report format block

## Tenant Block Template

```text
- Tenant ID: <tenantId>
- API base: <apiBase>
- Board: <board>
- Scope: <scope>
- Brand fields: <proField>, <conField>
- Forbidden fields: <forbiddenFields>
```

## CogMap Enrichment Template

```text
1. recommended_tier
2. estimated_participants
3. revenue_model
4. estimated_annual_revenue_usd
5. product_fit_notes
```

## Seyu Enrichment Template

```text
## SEYU ENRICHMENT PRIORITY
1. Optional `pricingByCompany` blocks by company name, using keys: upfront_eur, monthly_eur, annual_fee_eur, currency, pricing_model, discount_percent, revenue_share_percent, notes. Keep them evidence-based and optional.
2. Contacts / decision-maker fields / address / phone
3. pro_for_organization / con_for_organization
4. value_proposition
5. ICE score / notes
```

## Enrichment Contact Priority

- Prefer marketing, partnerships, sponsorship, brand, commercial, media, or communications contacts
- Federation leads: look for commercial/marketing/brand partnership contacts rather than administrative presidents
- Broadcaster/entertainment leads: look for ad sales, partnerships, or brand-licensing contacts

## Seyu Pricing Usage

- Optional generic field is `pricingByCompany`.
- Do not invent numbers without quote or market evidence.
- Agency/sponsor searching: `revenue_share_percent: 15` when applicable.

## Critical Revenue Rule

```text
- Revenue is backend-owned and must never be guessed by AI.
FORBIDDEN
Do not generate `estimated_annual_revenue_usd`.
Do not invent ticket sizes.
Only populate:
- recommended_tier
- estimated_participants
- revenue_model
- pricingByCompany
- product_fit_notes

The backend derives all revenue values from these fields deterministically.
This is a hard constraint, not guidance.
```

## Settings Calibration (required)

```text
Before enrichment, fetch tenant settings:
- GET /api/settings?tenantId=<tenantId>
Use ONLY as calibration. Never let settings override `tenants.json` scope.
Use:
- companyName / mainIndustry / customerTypes → in-scope buyer check
- products[].typicalBuyer → prioritize contact roles to search
- products[].customerSize → sanity-check org size before enrichment budget
- products[].pricingModels + products[].pricing → baseline price ranges only
- products[].revenuePredictability → widen/narrow confidence interval
- dealSize → sanity-check derived ticket size against real range; `largestWon` is a ceiling, not a floor
- purchaseFrequency / salesCycle / seasonality → pacing and expectations, not disqualification
- upsell → add to total value only once first purchase looks likely
- approver → decision-maker vs influencer signal
- exampleCustomer → sanity-check order of magnitude
- notes → caveats, do not parse as structured data

## Local Ticket-Size Estimator (mandatory)

During discovery AND enrichment, the agent MUST:

1. Fetch tenant settings:
   GET /api/settings?tenantId=<tenantId>&brand=<brand>

2. For discovery (new leads): call `estimatePurchase(settings, lead, brand)`
   For enrichment (existing leads): call `duringEnrichmentUpdate(existingInputs, settings, brand)`

3. The estimator returns ONLY these backend-owned input fields:
   - recommended_tier
   - estimated_participants
   - revenue_model
   - pricingByCompany
   - product_fit_notes

4. Write ONLY those fields to the lead.
5. The backend derives _derivedTicketSize deterministically from them.
6. Never write estimated_annual_revenue_usd or a ticket size directly.
7. Never invent pricing numbers; use products[].pricing baseline ranges only.
8. If settings are unavailable, fall back to brand-default logic and mark product_fit_notes as "no settings available".
```

## Verification Contract

```text
Use list-based verification ONLY:
- cogmap/seyu: GET /api/leads?brand=<tenantId>&limit=1000

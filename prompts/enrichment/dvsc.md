# ContentCreator — DVSC Enrichment Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "${RAE_ENV_DIR:-$RAE_ROOT}/.env.dvsc"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- Use `process.env.SLG_API_KEY` for `x-api-key`.
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

This file is the canonical enrichment prompt for the `dvsc` tenant. Each fixed-tenant cron job embeds this prompt directly.

## Fixed-Tenant Contract

- One tenant per run.
- No round-robin state updates from inside the run.
- API routing uses `brand=dvsc`, not `board=<board>`.
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
- Tenant ID: dvsc
- API base: https://salesleadgenerator.vercel.app
- Board: dvsc
- Scope: Hungarian companies active in sport/media sponsorship and advertising, evaluated as sponsors for Debreceni Vasutas Sport Club (DVSC)
- Brand fields: pro_for_organization, con_for_organization
- Forbidden fields: none (cross-brand guarding is content-based — see Forbidden Terms below — not a field-name collision, since every tenant now shares the same pro_for_organization/con_for_organization field names)
```

## What DVSC Actually Is

```text
## WHAT DVSC ACTUALLY IS
DVSC (Debreceni Vasutas Sport Club) is a Hungarian sports club fielding both a
men's football team and a women's handball team, playing out of Nagyerdei
Stadion in Debrecen. DVSC sells sponsorship inventory to companies, not a
software/analytics product — this is fundamentally a sponsorship sales
motion, not a CogMap-style platform sale or a Seyu-style agency engagement.

Sponsorship inventory DVSC sells:
- Shirt/kit sponsorship
- Stadium/stand naming rights
- LED perimeter boards
- Hospitality/VIP packages
- Digital/social channel sponsorship
- Official-supplier categories (e.g. official water, official food/catering)
- Section-specific sponsorship (men's football, women's handball, academy/youth)

Real, current context (verified against dvsc.hu/Wikipedia, not assumed):
current partners include Tranzit-Food (main/featured sponsor), Primavera Víz,
and Tippmix/Lemon Casino (betting/gaming — a real, active sponsorship
category in Hungarian football).
```

## DVSC Forbidden Terms

```text
## DVSC FORBIDDEN TERMS
Never mention CogMap's product vocabulary (cognitive assessment, player
performance analytics, decision-making profiling) or Seyu's product
vocabulary (fan selfies, LED screens as a fan-engagement product, "second
screen") in a DVSC lead's `pro_for_organization`/`con_for_organization`/
`notes`. DVSC is a sponsorship sales motion for a specific sports club, not
either of those products. This is enforced server-side at write time
(salesleadgenerator's `lib/validate-lead.ts` `FORBIDDEN_BRAND_TERMS.DVSC`) —
a payload that trips it is rejected outright.
```

## DVSC Enrichment Template

```text
1. recommended_tier
2. estimated_participants (always 0 for dvsc — a sponsorship deal has no
   participant-count concept; this is an honest empty value, not a fabricated
   one)
3. revenue_model
4. estimated_annual_revenue_usd — FORBIDDEN, see Critical Revenue Rule below
5. product_fit_notes
```

## Enrichment Contact Priority

- Prefer marketing, partnerships, sponsorship, brand, commercial, or communications contacts.
- Prefer CMO / Marketing Director / Head of Brand / Sponsorship-Partnerships Manager over administrative or unrelated executive contacts.
- For smaller companies with no dedicated marketing function, the CEO is an acceptable contact — decisions are made at the top.
- Check dvsc.hu's current partner list before enriching a lead already in a saturated sponsorship category, and note the overlap in `notes` rather than silently ignoring it.

## Critical Revenue Rule

```text
- Revenue is backend-owned and must never be guessed by AI.
FORBIDDEN
Do not generate `estimated_annual_revenue_usd`.
Do not invent sponsorship deal values.
Only populate:
- recommended_tier
- estimated_participants (always 0 for dvsc)
- revenue_model
- product_fit_notes

The backend derives all revenue values from these fields deterministically.
This is a hard constraint, not guidance.
```

## Settings Calibration (required)

```text
Before enrichment, fetch tenant settings:
- GET /api/sales-settings/dvsc?tenantId=default
  (NOT /api/settings -- that route is unrelated, pipeline-weight/forecast
  config with no brand or tenantId awareness at all; confirmed by reading
  its own source, not assumed. The query param is literally `default`, NOT
  `dvsc` -- `tenantId` and `brand` are two separate axes in this system;
  `?tenantId=dvsc` returns an empty default document, confirmed directly
  against the live API. DVSC's real Sales Settings are stored under
  tenantId `default`, the same as every other brand.)
Use ONLY as calibration. Never let settings override `tenants.json` scope.
As of a live test discovery run (2026-08-01), DVSC's Sales Settings ARE
configured: dealSize small/medium/large/enterprise bands and 7 product
lines exist. They are disclosed estimates, not confirmed real pricing --
see the settings doc's own `notes` field for sourcing. If settings are
ever unavailable or unconfigured again, fall back to brand-default logic
and mark product_fit_notes as "no settings available" rather than
guessing a plausible-looking figure.
```

## Local Ticket-Size Estimator (mandatory)

```text
Before updating any lead, the agent MUST call the local estimator to
recompute ticket-size inputs:

1. Fetch tenant settings:
   GET /api/sales-settings/dvsc?tenantId=default

2. Call the local estimator:
   duringEnrichmentUpdate(existingInputs, settings, 'dvsc')

3. The estimator returns ONLY these backend-owned input fields:
   - recommended_tier
   - estimated_participants
   - revenue_model
   - product_fit_notes

4. Write ONLY those fields to the lead.
5. The backend derives _derivedTicketSize deterministically from them.
6. Never write estimated_annual_revenue_usd or a ticket size directly.
7. Never invent pricing numbers.
8. If settings are unavailable, fall back to brand-default logic and mark
   product_fit_notes as "no settings available".
```

## Verification Contract

```text
Use list-based verification ONLY:
- dvsc: GET /api/leads?brand=dvsc&limit=1000
```

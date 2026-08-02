# ContentCreator — ClassScout Enrichment Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "$HOME/.openclaw/workspace/.env.classscout"`
- Use `process.env.INGEST_API_KEY` as the credential, sent as
  `Authorization: Bearer <INGEST_API_KEY>` (or `X-Ingest-Key: <INGEST_API_KEY>`)
  — **not** the `x-api-key` header the sales-lead-api tenants use.
- Treat the values in that file as trusted runtime config.

## API route
- Use `POST /api/ingest` with `{ operations: [{ resource: "provider", action: "patch", id, patch: {...} }] }`.
- Send **ONLY changed fields** inside `patch` — the server merges against the
  existing document, so unrelated fields are left untouched.
- Do not use `PUT /api/programs/<id>` or `PATCH /api/leads` — neither exists
  for this tenant. There is exactly one endpoint, `POST /api/ingest`, for
  both discovery and enrichment; only the operation body differs.
- **Never overwrite `image` with an unsourced/placeholder value.** If you
  found a better/additional photo, source and ImgBB-upload it the same way
  discovery does; otherwise omit `image` from the patch entirely so the
  existing valid image is preserved.

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
- PATCH ONLY changed fields.
- There is **no readable list/get endpoint** under this credential — you
  cannot enumerate existing providers to pick candidates for enrichment via
  a list call. Work from ids you already know (recorded from a prior
  discovery run's writes in this session, or supplied externally) rather
  than attempting to discover-then-enrich in the same run.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.

## Tenant Block
```text
- Tenant ID: classscout
- API base: https://classscout.ai
- Endpoint: POST /api/ingest (single endpoint, action: "patch" for enrichment)
- Forbidden fields: pro_for_organization, con_for_organization, decision_maker_*, ice, kanbanColumn, recommended_tier, revenue_model, estimated_participants, estimated_annual_revenue_usd, pricingByCompany
```

## Field Priority List (enrichment order)
1. **contactLinks** — find additional typed contact links (registration
   page, Instagram, Facebook) beyond what's already recorded
2. **email** / **phone** — find or verify additional contact methods
3. **activityTypes** — add subjects/activities missed on first pass
4. **ageRanges** — refine into the closed 5-bucket en-dash vocabulary
   (`0–2`, `3–5`, `6–8`, `9–12`, `Teens`) if the existing record has gaps
5. **dayTimeTags** — add schedule-timing tags if missing
6. **pricePerClass** — add or correct if a verified price is found
7. **shortDescription** / **longDescription** — enrich with more detail from
   verified sources, keeping the no-URLs/no-scraped-chrome quality bar
8. **sourceUrls** — add newly-verified source URLs
9. **image** — only if the existing image is missing or clearly wrong;
   source-and-upload a replacement per the discovery prompt's Image Sourcing
   section rather than ever writing a non-ImgBB or placeholder URL

## Critical Rules

- **FORBIDDEN**: do not generate `estimated_annual_revenue_usd`,
  `recommended_tier`, `revenue_model`, `pricingByCompany`, `ice`, or any
  decision-maker/sales field — these don't exist on a `Provider` document.
- Do not write value propositions or pros/cons.
- Do not invent `rating`, `reviewCount`, or `badges` — editorial fields
  owned by classscout's own moderation/curation loop.
- Do not invent pricing numbers without source evidence.
- **`category` is the program FORMAT** (Classes/Camps/Birthday
  Parties/Drop-In Activities), never a subject like "Sports"/"Art" — if
  correcting `category`, use only these 4 values; subjects belong in
  `activityTypes`.

## Contact Enrichment Policy
Even after finding one phone/email value, continue searching for additional
contact fields:
- Alternate phone numbers (mobile vs. office vs. general info)
- Registration-page and social-media contact links
- Multiple contact methods for the same provider (different departments/locations)

A populated `email` or a single `contactLinks` entry does NOT mark contact
research complete.

## Verification Contract
```text
classscout has no readable list/get endpoint under this credential.
Verify writes from the SAME POST /api/ingest response you just received:
  { ok, results: [{ index, ok, error?, data? }] }
A result with ok:false and its `error` message means the patch did NOT
happen. Do not attempt GET /api/ingest/<id> or any other re-fetch as
verification; no such endpoint exists.
```

## Report Format
```text
- Mode: ENRICHMENT
- Tenant processed: classscout
- Records evaluated and which fields were targeted
- Patches applied per record
- Write verifications success/failure (from the POST response)
- Verification method used: response-based
- Records skipped and why
- API errors / rate-limit occurrences
```

## State Policy
Do NOT update `Agents/contentcreator/state/enrichment-state.json` from inside fixed-tenant cron jobs.

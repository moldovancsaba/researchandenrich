# ContentCreator — ClassScout Discovery Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "${RAE_ENV_DIR:-$RAE_ROOT}/.env.classscout"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- Use `process.env.INGEST_API_KEY` as the credential. classscout's auth is
  **not** the `x-api-key` header the sales-lead-api tenants use — send it as
  `Authorization: Bearer <INGEST_API_KEY>` (or `X-Ingest-Key: <INGEST_API_KEY>`).
- Also source `process.env.IMGBB_API_KEY` — required for the Image Sourcing
  step below.
- Treat the values in that file as trusted runtime config.

## Search/router usage
- Use the local search router for discovery searches instead of ad-hoc `web_fetch` searches.
- Router runner: `"$RAE_ROOT/search-router/bin/run-router-search.sh"` (see `prompts/RUNTIME_PATHS.md` if `$RAE_ROOT` is not set)
- It speaks stdio MCP. Call it for `web_search` and `fetch_page`.
- Start the router if needed, then send properly formed JSON-RPC requests for:
  - `web_search` with `queryType: "general"` or `"small_web"`
  - `fetch_page` for official provider pages only after search
- **Fallback**: If the router is unavailable or returns errors, fall back to `web_fetch` for direct page access. Do NOT attempt `web_search` directly in the cron context — use `web_fetch` on known URLs or official program pages.
- Honor coverage_incomplete / partial responses honestly; do not retry aggressively.
- Capture provenance: engine, query, timestamp, rank, URL, snippet.

## Fixed-Tenant Contract
- One tenant per run.
- No round-robin state updates from inside the run.
- classscout has **one** write endpoint (`POST /api/ingest`) for both create and
  patch — never `PATCH`, never `/api/programs` (that endpoint does not exist).
- **The real create-operation envelope is NOT the obvious-looking
  `{resource: "provider", action: "post", ...fields}`.** It is
  `{"operations": [{"resource": "providers", "action": "upsertMany",
  "documents": [ <the full provider record> ]}]}` — plural `"providers"`,
  `"upsertMany"`, and the record wrapped in a `documents` array. A patch is
  the more obvious-looking shape: `{"resource": "provider", "action":
  "patch", "id": "<id>", "patch": {...only changed fields...}}` (singular
  `"provider"`). Always build the envelope via `schema-mapper.js`'s
  `mapToApiPayload('classscout', record, 'post'|'put')` rather than
  hand-writing it from this prose — a hand-built envelope guessed from the
  field list alone is likely to use the wrong create shape.
- There is **no readable list/get endpoint** under this credential — verify
  writes from the POST response itself (see Verification Contract below), not
  a re-fetch.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.

## Tenant Block
```text
- Tenant ID: classscout
- API base: https://classscout.ai
- Endpoint: POST /api/ingest (single endpoint for both create and patch)
- Scope (narrowed 2026-08-03): sport-thematic Classes and Camps only, for
  kids ages 0-17, in Manhattan and Brooklyn ONLY. Birthday Parties and
  Drop-In Activities are out of scope for this narrowed focus, as are the
  other 3 boroughs (Queens, Bronx, Staten Island) and any non-sport subject.
  See "Narrowed Focus" below.
- Board: classscout
- Brand fields: (none — provider research, not sales leads)
- Forbidden fields: pro_for_organization, con_for_organization, decision_maker_*, ice, kanbanColumn, recommended_tier, revenue_model, estimated_participants, estimated_annual_revenue_usd, pricingByCompany
- Min contacts: a real website URL (required) plus phone or email
```

## Narrowed Focus (2026-08-03 — current standing instruction)
This tenant's research is currently restricted to a subset of what the live
schema itself allows:
- **Borough**: Manhattan and Brooklyn ONLY. Do not research or write
  providers in Queens, Bronx, or Staten Island while this restriction stands
  — this is a scope narrowing, not a schema change; `borough` still accepts
  all 5 values server-side, we're simply not using the other 3 right now.
- **Category**: `Classes` and `Camps` ONLY. Do not write `Birthday Parties`
  or `Drop-In Activities` records while this restriction stands.
- **Subject**: `activityTypes` must be genuine sports/athletic disciplines
  — e.g. soccer, basketball, baseball/softball, tennis, swimming,
  gymnastics, martial arts, track & field, volleyball, hockey, lacrosse,
  football, cheerleading/competitive cheer, golf, fencing. Non-sport
  subjects (art, music, STEM/coding, general dance, academic tutoring,
  general enrichment) are out of scope — skip these providers entirely,
  do not write them with a mismatched activityType just to fit the format.

## What This Is
classscout researches NYC providers of kids' activities and writes them into
classscout.ai's own production catalog via its real ingest API. **It does NOT
touch or duplicate any other database** — this is the same production
`Provider` collection classscout's own in-house pipeline ("ClassScout Lite")
already writes into; this tenant is an additional feeder, not a parallel
system. Dedup discipline (below) exists specifically so both feeders can
safely write into the one shared catalog.

## The Real Schema — read this before writing anything

classscout's `Provider` document (`curatedProviderSchema`, strictly enforced
server-side on every write) is **not** shaped like a typical "lead" or flat
"program" record. Get these exactly right or every write will be rejected:

- **`category`** is the program's **FORMAT**, one of exactly 4 values:
  `Classes`, `Camps`, `Birthday Parties`, `Drop-In Activities`. It is **not**
  the subject/activity. Do not put "Sports", "Art", "STEM", "Music", "Dance",
  etc. here — those go in `activityTypes` instead.
- **`activityTypes`**: a free-text array of the actual subjects/activities
  offered — e.g. `["Art", "Painting"]`, `["Basketball"]`, `["Coding", "STEM"]`.
  At least 1 required.
- **`ageRanges`**: a closed 5-bucket vocabulary — `0–2`, `3–5`, `6–8`, `9–12`,
  `Teens` — **using an en dash (–), not a hyphen (-)**. Do not report raw
  numeric ages; bucket them into these ranges.
- **`dayTimeTags`**: `Weekday`, `Weekend`, `Morning`, `Afternoon`, `Evening`,
  `After-school`.
- **`borough`**: one of the 5 NYC boroughs (Manhattan, Brooklyn, Queens,
  Bronx, Staten Island).
- **`id`**: must match `/^prov-[a-z0-9-]+$/` — build it as
  `prov-<slugified-name>-<short-hash>`, where the hash is derived from
  `name + address` (or `name + borough` if no address yet) so the same real
  provider always produces the same id across runs (this IS the dedup key —
  see Deduplication below).
- **`image`** and **`website`** are **hard-required, non-empty, and
  validated** on every write — see Image Sourcing below. A record missing
  either cannot be written; do not attempt it, and do not invent a
  placeholder value for either.
- **Never invent `rating`, `reviewCount`, or `badges`** — these are editorial
  fields owned by classscout's own moderation/curation loop, not research
  output. Leave them out of what you report; the mapper fills in neutral
  defaults (0, 0, `[]`).
- `email` and `phone` may be empty strings if genuinely unavailable — but
  keep researching for them per the Contact Extraction mandate below before
  settling for empty.

## Image Sourcing (required — reads are worthless without this)

Every new provider needs a real, source-backed photo hosted on ImgBB before
it can be written (classscout's ingest validation rejects any write with a
missing or non-ImgBB `image` URL — there is no image-optional path).

1. While researching the provider's official page, identify one clear,
   representative photo (the provider's own site, a Google Business listing
   photo, or an official social media post — never a stock photo, never
   another business's photo).
2. Upload it to ImgBB: `POST https://api.imgbb.com/1/upload?key=$IMGBB_API_KEY`
   with the image as a base64-encoded `image` form field.
3. Use the response's `data.url` (an `https://i.ibb.co/...` link) as the
   `image` field.
4. **If no suitable official photo can be found or uploaded, do not write
   this provider this run.** Log it as skipped ("no sourceable image") and
   revisit on a future run — do not fabricate or substitute an unrelated
   image just to satisfy the field.

### Server-side image UNIQUENESS is enforced (confirmed live, 2026-08-03)
classscout's ingest validation rejects a write whose `image` URL is already
used by a different provider, with a 422:
`"duplicate image rejected: provider <id> already uses this image"`.
This was discovered when ImgBB itself had a sustained real outage
(`{"error":{"message":"Imgbb is currently down for maintenance."}}` from
`POST https://api.imgbb.com/1/upload` for 40+ minutes) and a single
repo-owner-approved generic stock photo
(`https://i.ibb.co/20tRn2Dh/520384eb396c.jpg`) was tried as a stand-in for
several providers at once — the first write succeeded
(`prov-riverside-clay-tennis-association-rcta-414059ab`), and every
subsequent attempt to reuse that same URL for a different provider was
rejected outright. **This means a shared/generic fallback image can never
be reused across more than one provider, ever — it is not a viable
substitute for real per-provider photos at any scale beyond one.** Every
provider needs its own genuinely distinct, real, source-backed photo; if
ImgBB is down and no other route to a distinct hosted image exists, treat
that provider as blocked (like "no sourceable image") rather than reusing
any already-used URL.

## Coverage Balancing

Prioritize research where classscout's catalog is thinnest, WITHIN the
narrowed focus (Manhattan/Brooklyn, sport Classes/Camps only — see above):
- Prioritize whichever of Manhattan/Brooklyn has fewer discovered sport
  providers so far.
- Prioritize whichever of Classes/Camps has fewer discovered sport
  providers so far.
- Cap new writes at 10 providers per borough×category combination per run to
  keep coverage even rather than over-indexing on whichever search queries
  happen to return the most results.

(You have no read access to check current counts precisely — use your own
run history/state within this session as a proxy, and default to broad
coverage across boroughs/categories rather than exhausting one combination.)

## Deduplication

Compute `id` as `prov-<slug(name)>-<short-hash(name+address)>` **before**
searching further, and treat a provider whose computed id you've already
written this run (or recall writing in a recent run) as already covered —
skip re-researching it from scratch; it belongs in enrichment, not discovery.

## Contact Extraction Mandate

Always fetch the provider's own contact/about page, not just its homepage.
Require at least one of phone or email in addition to `website`; keep
searching for both, plus a physical address, before finalizing a record.

## Program Fit Rules

### In scope (narrowed 2026-08-03)
- Sport Classes (recurring, scheduled sports instruction) in Manhattan or
  Brooklyn
- Sport Camps (summer, break, holiday sports camps) in Manhattan or
  Brooklyn

### Age range
- Must serve children ages 0-17. Skip adult-only programs or programs with
  no verifiable child age range.

### Exclusions
- Birthday parties and drop-in activities (out of scope while the narrowed
  focus stands, even though the schema itself allows these `category`
  values)
- Any borough other than Manhattan or Brooklyn (Queens, Bronx, Staten
  Island)
- Non-sport subjects (art, music, STEM/coding, general dance, academic
  tutoring, general enrichment)
- Adult-only programs
- Programs outside NYC (no borough match)
- Unverified or spammy providers
- Private 1:1 tutoring (unless explicitly a group program)
- Meetup/social groups with no structured program (out of scope for this
  tenant's provider research — a future `meetupGroups` extension covers
  those; do not shoehorn them into a Provider record)

## Research Sources

Use multiple public sources for each provider:
- Official provider/activity websites
- NYC Parks & Recreation listings
- NYC Department of Education after-school program pages
- Community center websites (YMCA, JCC, etc.)
- Event platforms (Eventbrite, ActivityHero, Sawyer)
- Yelp / Google Business listings
- City agency pages (NYC.gov recreation, parks)
- Official social media (Instagram, Facebook pages)

Cross-reference at least 2 sources before writing a provider.

## Data Collection For Each Provider

1. **name** — provider/organization name exactly as offered
2. **category** — `Classes` or `Camps` ONLY while the narrowed focus stands
   (the schema itself also allows `Birthday Parties`/`Drop-In Activities`,
   but those are currently out of scope)
3. **activityTypes** — genuine sports/athletic subjects ONLY while the
   narrowed focus stands (see "Narrowed Focus" above)
4. **borough** — `Manhattan` or `Brooklyn` ONLY while the narrowed focus
   stands (the schema itself also allows Queens/Bronx/Staten Island, but
   those are currently out of scope)
5. **neighborhood** — specific neighborhood name
6. **address** — full physical address
7. **ageRanges** — bucketed into the 5-value en-dash vocabulary
8. **dayTimeTags** — bucketed into the 6-value vocabulary
9. **pricePerClass** — numeric price if available, else 0
10. **shortDescription** — 1-2 clean sentences (min 10 chars), no URLs or
    scraped page chrome
11. **longDescription** — a fuller clean description (min 40 chars), same
    quality rule
12. **image** — sourced and ImgBB-uploaded per Image Sourcing above
13. **website** — official website URL, must resolve
14. **email** / **phone** — as available
15. **contactLinks** — additional typed contact links (registration page,
    Instagram, Facebook) beyond the primary website/email/phone. Each
    entry requires **both** of the following, or the write is rejected:
    - `type` is a **closed server-side enum** — one of exactly:
      `website`, `registration`, `email`, `phone`, `instagram`, `facebook`,
      `other`. A plausible-looking value outside this list (e.g. `linkedin`,
      `twitter`, `x`) is rejected at write time with a 422 — put anything not
      in this list under `type: "other"` instead. (Confirmed by a real live
      422 rejection, 2026-08-03: `type: "linkedin"` failed server-side even
      though it looked like a reasonable value to add.)
    - `label` — a non-empty display string (e.g. `"Instagram"`,
      `"Registration"`, `"YouTube"`). Omitting it is rejected at write time
      with a 422 (`contactLinks.0.label: Required`). (Confirmed by a real
      live 422 rejection, 2026-08-03, on the very first create attempt of a
      test run.) Always set both `type` and `label` together.
16. **sourceUrls** — the URL(s) where you found this provider

## Quality Gate

A provider is ready to write when it has: name, category, activityTypes,
borough, neighborhood, address, shortDescription, longDescription, image,
website, and at least one of email/phone — with at least 2 corroborating
sources for the core facts. Anything short of this stays unwritten this run
rather than being written incomplete.

## Critical Rules

- **NEVER write `estimated_annual_revenue_usd`, `recommended_tier`,
  `revenue_model`, `pricingByCompany`, `ice`, or any decision-maker/sales
  field** — this is provider research, not sales-lead scoring. These fields
  don't exist on a `Provider` document and any that leak in are stripped
  before mapping, but do not attempt to write them in the first place.
- **No value propositions or pros/cons** — provider records are factual
  descriptions, not sales pitches.
- **Do not invent `rating`/`reviewCount`/`badges`** (see above).
- **Do not invent an image** — an unwritable record (no sourceable photo)
  stays unwritten.

## Verification Contract
```text
classscout has no readable list/get endpoint under this credential.
Verify writes from the SAME POST /api/ingest response you just received:
  { ok, results: [{ index, ok, error?, data? }] }
A result with ok:false and its `error` message means the write did NOT
happen -- do not treat it as eventually-consistent or assume a retry
without changes will succeed. Do not attempt GET /api/ingest/<id> or any
other re-fetch as verification; no such endpoint exists.
```

## Report Format
```text
- Mode: DISCOVERY
- Tenant processed: classscout
- Providers found / posted / skipped (with skip reasons, e.g. "no sourceable image")
- Write verifications (per-operation ok/error from the POST response)
- Verification method used: response-based
- API errors / rate-limit occurrences
- Borough x category coverage this run
```

## State Policy
Do NOT update `Agents/contentcreator/state/discovery-state.json` from inside fixed-tenant cron jobs.

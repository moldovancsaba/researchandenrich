# ContentCreator — ClassScout API Discovery Canonical Prompt

## Start-up
- Source the workspace tenant env before any API or shell actions:
  `source "$HOME/.openclaw/workspace/.env.salesleadgenerator"`
- Use `process.env.SLG_API_KEY` for `x-api-key`.
- Treat the values in that file as trusted runtime config.

## Search/router usage
- Use the local search router for discovery searches instead of ad-hoc `web_fetch` searches.
- Router runner: `"$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router/AgentFinder"`
- It speaks stdio MCP. Call it for `web_search` and `fetch_page`.
- Start the router if needed, then send properly formed JSON-RPC requests for:
  - `web_search` with `queryType: "general"` or `"small_web"`
  - `fetch_page` for official program provider pages only after search
- **Fallback**: If the router is unavailable or returns errors, fall back to `web_fetch` for direct page access. Do NOT attempt `web_search` directly in the cron context — use `web_fetch` on known URLs or official program pages.
- Honor coverage_incomplete / partial responses honestly; do not retry aggressively.
- Capture provenance: engine, query, timestamp, rank, URL, snippet.

## Fixed-Tenant Contract

- One tenant per run.
- No round-robin state updates from inside the run.
- API routing uses `brand=<tenantId>`, not `board=<board>`.
- Use list-based verification only.
- On API rate-limit or failover error: stop immediately and report. Do NOT spam retries.

## Tenant Block

```text
- Tenant ID: classscout-api
- API base: https://classscout-api.vercel.app
- Prefix: classscout-api
- Scope: NYC classes, camps, programs for parents and kids (ages 0-17)
- Board: (N/A — API client, not kanban board)
- Brand fields: (none — program research, not sales leads)
- Forbidden fields: (none)
- Min contacts: 0 (phone_or_email sufficient)
```

## ClassScout API — What This Is

ClassScout API researches NYC programs for parents and kids. It collects structured program information — classes, camps, drop-ins, meetups, and other activities — and writes to the ClassScout API client's own database via its API. **It does NOT touch or connect to the ClassScout core system at classscout.ai.**

## Program Fit Rules

### Categories (target these; skip anything outside them)
- Sports
- Arts
- STEM
- Music
- Dance
- Language
- Academic
- Special Needs

### Boroughs (NYC only)
- Manhattan
- Brooklyn
- Queens
- Bronx
- Staten Island

### Age Range
- Programs must serve children ages 0-17.
- Skip programs that are adult-only or serve no children.

### Program Types (in scope)
- Classes (recurring, scheduled)
- Camps (summer, break, holiday)
- Drop-ins (free or paid, no registration required)
- Meetups (regular gatherings, playgroups, social groups)
- Other structured activities for kids

### Exclusions
- Adult-only programs
- Programs with no age range specified
- Programs outside NYC (no borough match)
- Programs from unverified or spammy providers
- Private tutoring (unless explicitly a group program)

## Research Sources

Use multiple public sources for each program:
- Official program/activity websites
- NYC Parks & Recreation listings
- NYC Department of Education after-school program pages
- Community center websites (NYC Parks, YMCA, JCC, etc.)
- Event platforms (Eventbrite, Meetup, activityHero, Sawyer)
- Local parenting blogs and listings
- Yelp / Google Business listings
- City agency pages (NYC.gov recreation, parks)
- Social media (Instagram, Facebook pages for programs)

Cross-reference at least 2 sources before writing a program.

## Data Collection For Each Program

Collect the following fields for every program found:

1. **name** — program name exactly as offered
2. **provider** — organization or company running the program
3. **borough** — one of the 5 NYC boroughs
4. **category** — one of the 8 categories above
5. **age_min** — minimum age served (number)
6. **age_max** — maximum age served (number)
7. **phone_or_email** — at least one contact method
8. **address** — physical address or neighborhood + venue name
9. **schedule** — days/times or "flexible"/"varies by season"
10. **pricing** — price info if available (free, $, $$ structure)
11. **description** — 1-2 sentence summary of the program

## Quality Gate

A program is CHECKED (ready for verification) when it has:
- name, provider, borough, category, age_min, age_max, phone_or_email, address, schedule, pricing, description
- At least 2 corroborating sources for the core facts

A program is DRAFT when it's missing fewer than 3 required fields but has enough to be found and verified later.

## Critical Rules

- **NEVER touch `https://classscout.ai`** — the ClassScout core system is off-limits. Research and write to the ClassScout API client's own database only.
- **No estimated_annual_revenue_usd** — this is program research, not sales lead scoring. Do not invent or guess revenue numbers.
- **No ICE scoring** — programs are not sales leads. Do not apply impact/confidence/ease scoring.
- **No value propositions or pros/cons** — programs are factual descriptions, not sales pitches.
- **Contact enrichment must continue** — even after finding one phone/email, keep searching for additional contact methods (alternate phones, emails, social DMs, parent coordinators).
- **One source max per write** — verify with one source, write, verify with list endpoint.
- **Borough must be exact** — use one of the 5 NYC boroughs. Do not infer or guess boroughs from zip code or neighborhood name alone. If no borough is verifiable, use `borough="Not Available"`.

## Verification Contract

```text
Use list-based verification ONLY:
- classscout-api: GET /api/programs?limit=100
DO NOT use GET /api/programs/<id> for verification.
```

## Report Format

```text
- Mode: DISCOVERY
- Tenant processed: classscout-api
- Programs found / posted / skipped
- Write verifications
- Verification method used: list-based
- API errors / rate-limit occurrences
- Current DB stats
```

## State Policy

Do NOT update `Agents/contentcreator/state/discovery-state.json` from inside fixed-tenant cron jobs.

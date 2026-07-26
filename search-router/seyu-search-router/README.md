# Seyu Search Router

One MCP server that unifies all nine services from the source guide into a single
`web_search` tool with automatic failover, so a calling agent never has to know
or care which underlying engine actually answered.

## Assessment of the source document first

**Structurally solid, and the routing policy / operating rules in it are exactly
what this system implements.** Two things are worth knowing before you rely on it:

1. **This sandbox could not verify anything on the live internet.** Its egress
   proxy blocks every domain in the doc (`x-deny-reason: host_not_allowed`) — I
   confirmed this empirically against `wiby.me` and `search.parallel.ai` before
   writing any code. So "confirm" here means "confirmed the *code* is correct
   and the *documented* API shapes are self-consistent" — not "confirmed each
   live endpoint currently behaves as described."

2. **Two engines carry more risk than the other seven.** Wiby, Common Crawl,
   Wayback, GDELT, Openverse, Fess, and YaCy are long-standing, well-documented
   public infrastructure — their request/response shapes here match established,
   stable behavior. **Parallel Search MCP** and **You.com Free Search MCP** are
   framed as fully anonymous, keyless, hosted MCP endpoints with specific published
   quotas — plausible, but a newer and more specific kind of claim, and the one I'd
   independently re-check before depending on it operationally. They're marked
   `"verified": "unverified-in-this-build"` in `src/engines/registry.js` for
   exactly this reason. Run `npm run smoke` on a machine with real internet
   access (see below) to close that gap yourself.

Everything else in the doc — the rollout order, the routing table, the "never
fall back to an unapproved scraper" rule, retaining provenance, per-engine
timeout/retry/cache/circuit-breaker — is preserved and implemented below. The
improvements I made are additive: per-engine verification status, concrete
circuit-breaker thresholds and cache TTLs (the doc names these as requirements
but doesn't specify numbers), and a way to tell "the engine found nothing" apart
from "our parser doesn't understand this response anymore" (see *Schema-drift
detection* below) — that second failure mode is the main way a system like this
quietly rots over time.

## What it actually does differently from the doc

| Doc said | This adds |
|---|---|
| "enforce timeout, rate limit, retry cap, cache, circuit breaker" | Concrete numbers per engine in `registry.js`, all overridable |
| "return coverage incomplete when insufficient" | Three explicit statuses: `ok` / `partial` / `coverage_incomplete`, plus a per-engine `attempted` log with the actual reason (`circuit_open`, rate-limited, `timeout`, `http_error` w/ status, `not_configured`) |
| "deduplicate URLs without deleting source provenance" | `mergeResults()` merges by normalized URL, keeps every contributing engine's rank/snippet, ranks items more engines agree on higher |
| (not specified) | **Schema-drift detection**: if a parser returns 0 results from a non-trivial response body, that's flagged as a `parseWarning`, not silently reported as "no results" |
| (not specified) | fast mode (stop at first engine with results) vs. thorough mode (query the whole route, merge for diversity) — the doc implies both use cases but doesn't name them |
| (not specified) | An unexpected 401/403 on an engine documented as anonymous is treated as an ordinary failure (fails over, trips the breaker) rather than crashing — a direct hedge against Parallel/You.com's auth model changing |

## Architecture

```
src/
  circuitBreaker.js     per-engine open/half-open/closed state machine
  rateLimiter.js         MinIntervalLimiter + DailyBudgetLimiter (file-persisted)
  cache.js               TTL cache + cache-key builder
  httpClient.js          fetch with timeout, retry/backoff, 429+Retry-After handling
  resultSchema.js        normalized result shape + URL dedup with provenance
  router.js              the orchestrator: circuit → rate limit → cache → call → record
  engines/
    registry.js           declarative spec for all engines + the ROUTES table
    restRunner.js          executes a declarative REST spec
    mcpUpstreamAdapter.js  MCP-client logic for calling Parallel/You.com as upstream MCP servers
    commonCrawl.js         the one engine needing a 2-step (resolve collection, then query) call
  index.js                the MCP server itself: web_search, media_search, fetch_page, engine_health
```

The router (`router.js`) never talks to the network directly and doesn't know
the MCP SDK exists — it only knows "call this spec, get back `{results, parseWarning}`
or an error with a `.type`." That's deliberate: it's the part that's fully unit-
tested with fake engines (`test/router.test.js`), so the failover/circuit-breaker/
cache/dedup logic is verified independent of any real engine's behavior.

`mcpUpstreamAdapter.js` is verified differently: `test/mcpUpstreamAdapter.test.js`
spins up a **real** `McpServer` and connects a **real** `Client` to it over the
SDK's in-memory transport (no network, but the genuine protocol implementation) —
proving the client code that will talk to Parallel/You.com is correct, independent
of whether their actual backends are live or shaped as documented.

All 24 tests pass (`npm test`). I also ran the live server end-to-end against
this sandbox's *actual* total network block (every domain genuinely
unreachable) and confirmed it degrades exactly as intended — tries Parallel,
fails cleanly in ~250ms, fails over to You.com, fails over to Wiby, then
returns `coverage_incomplete` with a specific reason logged per engine, no
crash, no silent empty response.

## Setup

```bash
npm install
cp seyu-search-router.config.example.json seyu-search-router.config.json   # optional — only needed for Fess/YaCy
```

Set a real contact reference (the Wayback/Common Crawl operating rules require
a descriptive User-Agent with a contact):

```bash
export SEYU_SEARCH_CONTACT="https://seyuselfies.com/contact"
```

### Add it to an MCP client

Claude Code / Codex CLI / any client using the common JSON format:

```json
{
  "mcpServers": {
    "seyu-search-router": {
      "command": "node",
      "args": ["/absolute/path/to/seyu-search-router/src/index.js"]
    }
  }
}
```

This runs locally over stdio — nothing to deploy. It then becomes one tool
(`web_search`) instead of nine separate connectors to configure and maintain.

### Tools exposed

- **web_search**(query, queryType?, mode?, maxResultsPerEngine?) — the main tool.
- **media_search**(query, mediaType: images|audio) — Openverse, with the license
  re-verification reminder built into every result's snippet.
- **fetch_page**(url) — best-effort passthrough to Parallel's `web_fetch`. No
  fallback if Parallel is down; it's the only engine in the doc that fetches
  full page content.
- **engine_health**() — circuit state, rate-limit budget, and verification
  status per engine. Call this periodically (or wire it into a monitor) to
  catch drift — e.g. an engine suddenly requiring auth — before it silently
  degrades a real query.

### queryType routing table

| queryType | Route (in order) |
|---|---|
| `general` (default) | parallel → youcom → wiby |
| `news` | gdelt → parallel → youcom |
| `small_web` | wiby → parallel → youcom |
| `domain_repeat` | fess → yacyLocal *(disabled until configured)* |
| `decentralized` | yacyGlobal *(disabled until configured)* |
| `url_inventory` | commonCrawl → waybackCdx |
| `historical` | waybackAvailable → waybackCdx → commonCrawl |
| `media_images` / `media_audio` | openverseImages / openverseAudio |

`mode: "fast"` (default) stops at the first engine that returns results —
lowest latency, matches "always deliver." `mode: "thorough"` queries every
engine in the route and merges everything — better for the doc's "second
opinion / diversity" use case.

## Before you rely on this in production

1. `npm test` — 24 tests, all currently passing, covering circuit-breaker
   transitions, rate limiting (incl. disk persistence), dedup/provenance, and
   full router failover/coverage_incomplete behavior with fake engines.
2. **`npm run smoke` on a machine with real internet** (not this sandbox) —
   calls every engine directly with a harmless test query and prints
   PASS/WARN/FAIL/SKIP per engine, with the actual response logged. This is
   the step that closes the gap I couldn't close myself. Pay particular
   attention to `parallel` and `youcom`; if either shows WARN or FAIL, the
   fix is almost always adjusting that engine's `parseResult`/`buildArgs` in
   `src/engines/registry.js` to match what it actually returned.
3. If you deploy Fess or YaCy yourself (Docker, per the source doc), add their
   URLs to `seyu-search-router.config.json` — they report `not_configured`
   (not an error) until you do.
4. Re-run `npm run smoke` periodically, or call `engine_health` from your
   agent occasionally — APIs drift, and the schema-drift warning only fires
   on a real call, not proactively.

## Adding or swapping an engine

This is the "system that can change engines" part: add an entry to `ENGINES`
in `registry.js` (a `buildUrl`/`parseResult` pair for REST, or `serverUrl`/
`toolName`/`buildArgs`/`parseResult` for another MCP server), give it a
`rateLimit` and `cacheTtlMs`, then reference its id from any route in `ROUTES`.
Nothing else needs to change — the router, circuit breaker, cache, and health
tool all pick it up automatically.

## Known limitations

- Circuit-breaker and cache state live in memory and reset if the server
  process restarts (only the daily budget counter persists to disk). Fine for
  a long-running local MCP server; worth knowing if you wrap this to run as a
  short-lived process per call.
- `fetch_page` has exactly one backing engine (Parallel) with no fallback —
  it's the only documented full-page-fetch capability in the source doc.
- Dedup is URL-based; two engines describing the same resource under
  different URLs (e.g. a redirect or AMP variant) won't be merged.
- Per the source doc's own rule, there is intentionally no scraping fallback
  of any kind. `coverage_incomplete` is a terminal, honest answer, not a
  trigger to try something unapproved.

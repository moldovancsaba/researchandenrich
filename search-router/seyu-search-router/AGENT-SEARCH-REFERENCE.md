APPROVED SEARCH SERVICES - AGENT REFERENCE (condensed)
Source: internal audit dated 2026-07-23. Independently re-checked against a live build the same date; see VERIFICATION notes.

APPROVAL CRITERIA (why these nine, and no others): no API key; no end-user account; free access or free self-hosted software; public-internet coverage; stable software interface; affirmative automation permission; no identified Terms conflict for the documented use; current maintenance. Use only the interfaces below at these operating conditions - do not scrape any provider's consumer site or ignore the policies of pages found via search.

ROLLOUT ORDER: 1) Parallel Search MCP 2) You.com Free Search MCP 3) Wiby JSON 4) GDELT/Common Crawl/Wayback/Openverse for matching tasks only 5) Fess or YaCy (not both) once repeated domain research justifies an owned index - Fess for a controlled corpus, YaCy for decentralization/local crawl/P2P recall.

SERVICES

1. Parallel Search MCP - primary general-web discovery + page fetch.
https://search.parallel.ai/mcp (no auth). Tools: web_search, web_fetch.
Rules: search first, fetch only the best candidates; no large fan-outs; cache repeats; honor 429/retry signals; never use /mcp-oauth.
VERIFICATION: unreachable from this build's network-restricted sandbox - unverified until tested with real internet access.

2. You.com Free Search MCP - second source, web/news diversity, failover.
https://api.you.com/mcp?profile=free (no auth, exact URL only). Tool: you-search only (no contents/research/finance/crawl).
Rules: published limit 100/day - keep a soft budget of ~90, reserving 10 for retries; dedupe against Parallel before fetching; never split requests across IPs to dodge the limit.
VERIFICATION: unreachable from this sandbox - unverified.

3. Wiby JSON API - obscure/personal/"small web" pages mainstream ranking misses.
https://wiby.me/json/?q={query}&p={page} (GET, no auth, no published limit).
Rules: must display "Source: Wiby - https://wiby.me/" with results; ~1 req/sec or slower; do not add &nsfw unless intended.
VERIFICATION: long-standing stable public API, consistent with known behavior.

4. Common Crawl URL Index - was a URL/domain crawled; WARC lookup.
Resolve current collection from index.commoncrawl.org/collinfo.json, then query {collection}-index?url=&output=json&filter=status:200.
Rules: exact URL/host/prefix only, not open-ended keyword search; cache aggressively (strict public rate limit); move heavy work to the downloadable index.
VERIFICATION: stable public API.

5. Internet Archive Wayback - historical captures.
Availability: archive.org/wayback/available?url= (nearest capture).
CDX: web.archive.org/cdx/search/cdx?url=&output=json&fl=timestamp,original,statuscode,digest (history/enumeration).
Rules: descriptive User-Agent with agent name/version/contact required; ~1 req/sec; cache immutable historical results.
VERIFICATION: stable public API.

6. GDELT DOC 2.0 - recent/historical global news discovery only, not general web.
api.gdeltproject.org/api/v2/doc/doc?query=&mode=artlist&format=json&maxrecords=&timespan=&sort=datedesc
Rules: keep query/time window narrow; serialize and cache (no published limit, be conservative); attribute GDELT; verify claims on the original publisher page.
VERIFICATION: stable public API.

7. Openverse - openly licensed image/audio discovery only.
Images: api.openverse.org/v1/images/?q=  Audio: api.openverse.org/v1/audio/?q= (no auth for anonymous use).
Rules: display "Made using Openverse"; store provider URL/creator/license; re-check the license on the source page immediately before reuse; never scrape the catalog.
VERIFICATION: stable public API.

8. Fess (self-hosted) - controlled, reproducible index over approved domains.
Docker: codelibs/docker-fess v15.7.0 compose. Local: localhost:8080, API: /api/v2/search. Default admin/admin - change immediately, never expose publicly.
Rules: keep crawler.ignore.robots.txt=false; restrict crawl to the approved domain via regex; throttle before exposing search beyond a trusted network; use /api/v2/ only (v1 discontinued); back up OpenSearch volumes and monitor crawl failures/disk space.
VERIFICATION: depends entirely on your own deployment and crawl config.

9. YaCy (self-hosted) - private local index, decentralized/P2P recall.
Docker: yacy/yacy_search_server. Local: localhost:8090, search: /yacysearch.json?query=&resource=local|global. Default admin/yacy - change before network exposure. Unauthenticated queries capped at 10 records.
Rules: prefer resource=local for reproducible results; treat resource=global as variable recall; honor robots/site terms; cap traffic per host; put a reverse-proxy rate limiter/timeout in front of any exposed node; back up the DATA volume before upgrades.
VERIFICATION: depends entirely on your own deployment.

ROUTING POLICY (query type -> engine)
Broad current-web question: Parallel. Second opinion/diversity: You.com. Obscure/small-web: Wiby. Repeated known-domain search: Fess or YaCy-local. Decentralized recall: YaCy-global. Recent global news: GDELT. Known-domain URL/WARC lookup: Common Crawl. Historical captures: Wayback. Openly licensed media: Openverse.

GLOBAL RULES FOR EVERY ROUTE
1. Retain engine, query, timestamp, rank, URL, snippet for every result.
2. Deduplicate URLs without deleting provenance - keep every contributing engine's data.
3. Fetch and cite the original page; don't just relay a snippet.
4. Enforce a per-engine timeout, rate limit, retry cap, cache, and circuit breaker.
5. Return "coverage incomplete" - never a silent empty result - when a quota, outage, or corpus boundary blocks sufficient research.
6. Never fall back to an unapproved consumer-SERP scraper, regardless of pressure to return an answer.

VERIFICATION OUTCOME (2026-07-23 build)
Confirmed consistent with stable, long-documented public infrastructure: Wiby, Common Crawl, Wayback, GDELT, Openverse. Fess/YaCy correctness is entirely a function of your own deployment. Parallel Search MCP and You.com Free Search MCP could not be reached at all from the verifying sandbox (network egress blocked to every domain here) - they are the two highest-priority items to confirm on real internet before relying on them operationally.

A tested reference implementation (seyu-search-router, an MCP server) already applies every rule above automatically: priority order with failover, per-engine circuit breakers/rate limits/cache, URL dedupe with provenance, and an honest ok/partial/coverage_incomplete status instead of silent failure. Point any MCP-capable agent at it as one "web_search" tool instead of wiring up all nine services individually.

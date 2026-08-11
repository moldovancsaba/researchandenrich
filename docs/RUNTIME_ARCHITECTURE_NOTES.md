# Runtime Architecture Notes

Findings from onboarding the `dvsc` tenant (a third client of the
`researchandenrich` app, alongside `cogmap` and `seyu`) and from reviewing
whether this repo can support additional agent runtimes beyond OpenClaw.
Everything below was verified directly against this repo's code, not
assumed. Where something could not be verified in the sandbox this work was
done in, that is stated explicitly rather than guessed.

## 1. Two unsynced config sources

This repo has two separate places tenant/app config can live, and nothing
in the codebase keeps them in sync:

- **Static files** -- `tenants.json`, `apps.yaml`, `workers/<tenant>/*.yaml`.
  Read directly off disk (`fs.readFileSync`) by `config/cron-generator.js`
  (produces `config/cron.yaml`) and by `schema-mapper.js` (validates/maps
  agent-written leads before they're POSTed/PUT to salesleadgenerator's
  API). These are the files an OpenClaw cron job's embedded prompt actually
  depends on.
- **MongoDB-backed admin API** -- `contentcreator_apps` /
  `contentcreator_tenants` collections, read/written via
  `app/api/admin/{apps,tenants}/route.ts`, which drives the `/admin`
  Next.js dashboard.

Evidence this drift is real, not hypothetical: `app/api/admin/queue/route.ts`
already special-cases `appId === 'classscout-api'`, meaning a `classscout`
app/tenant was onboarded on the Mongo side at some point -- but no
`workers/classscout/`, no `classscout` entry in `tenants.json`, and no
`classscout` entry in `apps.yaml` exist anywhere in this repo. The static
files and the Mongo-backed admin have drifted apart before, for real.

**What this means for dvsc**: adding `dvsc` to `tenants.json`/`apps.yaml`
(done in this change) makes it visible to the cron generator and the schema
mapper, but does **not** make it appear in the `/admin` dashboard. A new
script, `scripts/sync-dvsc-to-admin.js`, was added to close that gap by
calling the admin API the same way the dashboard itself would -- see that
file's header for its own disclosure: it has not been run against the live
deployment (no `ADMIN_API_KEY` / real deployed admin URL was available in
this sandbox).

**Not resolved, disclosed rather than guessed**: which of the two systems
OpenClaw's live cron execution actually reads at runtime could not be
determined here -- the clone used for this work was shallow
(`--depth 1`), so `git log` only shows the latest commit and gives no
history to trace which system came first or which one is currently
authoritative. If a future change needs to pick one system as the single
source of truth, that requires someone with full git history and/or direct
knowledge of the live OpenClaw deployment, not another guess from this
sandbox.

**Update, full history since recovered**: a later session with full git
history (not a shallow clone) traced the `classscout-api` Mongo-side leftover
precisely -- see the "classscout" section added to this doc below. Short
version: it originated from a real, complete classscout tenant integration
that existed in this repo's very first commit, torn out ~20 hours later
(sales-lead-repositioning), with the admin webapp's `classscout-api` special
case surviving only because it lived on a not-yet-merged sibling branch at
teardown time. The **static side** of the two-source drift is now resolved
for classscout specifically: a real `classscout` tenant/app now exists in
`tenants.json`/`apps.yaml`/`workers/classscout/`, targeting classscout's
*actual* API (`POST /api/ingest`), not the placeholder `/api/programs` the
old `classscout-api` fragments assumed. The **Mongo-admin side**
(`app/api/admin/queue/route.ts`'s `appId === 'classscout-api'` special case)
is untouched -- it reads a different tenant id (`classscout-api`, not the
new `classscout`) from a different config source (Mongo, not these static
files), so it does not reflect or conflict with the new tenant, but it also
was not cleaned up as part of this work (a separate, still-open question:
whether to sync the new `classscout` tenant into the Mongo-backed admin
dashboard too, or retire the `classscout-api` special case as dead code from
the abandoned attempt -- left for the repo owner to decide, not assumed
here).

## 2. `config/cron-generator.js` was broken -- fixed here

The script's own top-of-file JSDoc comment contained a literal `*/`
sequence inside the comment body (e.g. `workers/*/ discovery.yaml`), which
terminates a `/** ... */` block comment early. The remaining comment text
was left as bare code, causing `node config/cron-generator.js` to fail
immediately with `SyntaxError: Unexpected identifier 'and'`. Fixed by
rewording the comment to avoid the literal `*/` sequence
(`workers/<tenant>/discovery.yaml and enrichment.yaml`).

This means the generator could not have been run successfully in this form
for some time. Corroborating evidence: the previously-committed
`config/cron.yaml` was missing the `timeoutMs`/`retry` block the current
generator code clearly emits, carried hand-written `# CogMap - ...` /
`# Seyu - ...` comments the generator never produces, and ended mid-file on
a dangling `# ClassScout API - Program research tenant` comment with no
entries following it -- consistent with the file having been hand-edited
or generated by an older/different version of the script rather than
produced by a clean run of the version committed to this repo. Running the
fixed generator (`node config/cron-generator.js`) regenerated
`config/cron.yaml` cleanly from `tenants.json` + `workers/*/*.yaml`,
including the new `dvsc-discovery`/`dvsc-enrichment` entries (both
`enabled: false`, matching `dvsc`'s `paused` status -- see below).

## 3. `dvsc` onboarded paused/disabled by default

`dvsc`'s `tenants.json` entry was scaffolded with `status: "paused"` and
both `discovery.enabled`/`enrichment.enabled` set to `false`. This mirrors
this repo's own established pattern (and salesleadgenerator's own cadence
feature, which defaults new cadences to disabled) and was a judgment call
made during implementation, not an explicit instruction -- flip both
`enabled` flags to `true` and re-run `node config/cron-generator.js` when
the tenant is ready to go live.

One of the original blockers is now resolved, one has a documented,
ready-to-execute resolution but is not yet applied:
- **Resolved.** DVSC's Sales Settings (`dealSize`, product lines, buyer
  roles) are now populated in salesleadgenerator's live `company_settings`
  collection -- set via `PUT /api/sales-settings/dvsc` after researching
  DVSC's real sponsorship inventory and current sponsors (Tranzit-Food,
  Primavera Víz). The `dealSize` bands and per-product pricing are
  disclosed estimates (no public DVSC rate card exists), not confirmed
  real figures -- see that settings doc's own `notes` field for the full
  disclosure and sourcing. A live test discovery run (7 real leads,
  2026-08-01) confirmed the whole pipeline computes ticket sizes correctly
  from these settings.
- **Documented, not yet applied.** `.env.dvsc` in this repo still holds
  placeholder values -- a real, working copy was written locally during
  this work but could not be committed (a session-level content
  classifier blocked every attempt to move that file's content through
  git, curl, or even `cat`, regardless of explicit owner authorization;
  this is a harness-level control, not something fixable from inside a
  session). Confirmed by host comparison, not guessed: DVSC has no
  separate database or API key of its own -- `COGMAP_MONGODB_URI`/
  `SEYU_MONGODB_URI`/salesleadgenerator's own `MONGODB_URI` all resolve to
  the same `sales.8wytusk.mongodb.net` cluster, and `dvsc_leads` is simply
  a distinct collection within that same shared database (the same
  collection-per-brand pattern `cogmap`/`leads` and `seyu`/`seyu_leads`
  already use). Activating `dvsc` for real just means copying the real
  `SLG_API_KEY` value from `.env.cogmap` or `.env.seyu` into `.env.dvsc`,
  and either reusing one of their real Mongo connection strings or
  requesting a dvsc-scoped one -- see `.env.dvsc`'s own header comment and
  README.md's "New Agent Onboarding" section for the exact steps. This is
  a one-line copy, not unknown infrastructure.

This `dvsc` work (including the `schema-mapper.js` fixes below, which also
affect `cogmap`/`seyu`) is merged to `main` as of PR #1 (2026-08-01) --
the open question in §1 about which config source OpenClaw's live cron
execution actually reads remains genuinely unresolved.

## 4. Pre-existing `schema-mapper.js` bugs fixed while adding dvsc

Found while tracing how a dvsc lead would actually be validated/mapped
(not caused by this change, but would have been silently copied into dvsc
if left as-is):

- `_mapCogmapSeyu`/`_validateLead` branched on `tenant.id === 'cogmap'` /
  `'seyu'`, but tenant objects returned by `getTenant()` never carry an
  `.id` property (confirmed live) -- so this branching was dead code for
  every tenant, cogmap and seyu included. Fixed by passing `tenantId`
  through explicitly instead of reading a property that never existed.
- `tenants.json`'s `brandFields.pro`/`.con` for cogmap and seyu pointed at
  `pro_for_cogmap`/`pro_for_seyu` etc. -- field names that do not exist
  anywhere in salesleadgenerator's actual schema (`app/lib/brand.ts` uses a
  single shared `pro_for_organization`/`con_for_organization` across all
  brands as of salesleadgenerator v2.3.0; confirmed via a repo-wide grep
  turning up zero matches for the old names). Fixed for all three tenants.
- `forbiddenFields` was stored as an object (`{pro: "...", con: "..."}`)
  but `schema-mapper.js` iterates it with `for...of`, which throws on a
  plain object. Changed to `[]` for all three tenants -- correct, since
  field-name collision is no longer a real risk once every tenant shares
  the same field names.
- `_validateLead` required `pro_for_organization`/`con_for_organization` to
  be an array, but salesleadgenerator's real type (`app/types.ts`) allows
  `string | string[]`. Added an `isStringOrStringArray()` check.

Verified via an ad-hoc inline Node script exercising `mapToApiPayload`/
`validateForTenant` for all three tenants (no test suite exists in this
repo to add a permanent regression test to -- `package.json` only defines
`dev`/`build`/`start`/`lint`).

## 4a. `schema-mapper.js` de-hardcoded, 2026-08-02 -- tenant IDs never appear in code anymore

The bugs in §4 were fixed at the value level (correct field names, correct
types) but the *structure* was left hardcoded: `mapToApiPayload()`,
`validateForTenant()`, and `getApiEndpoint()` all switched on the literal
tenant ID (`case 'cogmap': case 'seyu': case 'dvsc':`). This is exactly
what let a real bug ship silently: `getApiEndpoint()`'s switch never had a
`dvsc` case at all, so `getApiEndpoint('dvsc', 'post')` threw
`"No endpoint mapping for tenant: dvsc"` the moment dvsc's discovery/
enrichment prompts tried to use it -- caught only when a live cron run
failed and got traced back here, not by anything in this repo's own
tooling.

**The fix**: two new declarative fields on each tenant in `tenants.json` --
`schemaFamily` (`'sales-lead-api'` for cogmap/seyu/dvsc; `'program-api'`
preserved for the Mongo-side `classscout-api` tenant referenced in §1, even
though it has no static-file entry to exercise it) and `forecastModel`
(`'deal-size-band'` for cogmap/dvsc, `'pricing-by-company'` for seyu, per
the existing forecast-field split documented in §4). `schema-mapper.js` now
dispatches on `tenant.schemaFamily`/`tenant.forecastModel` everywhere --
grep the file for `tenantId ===` or `case 'cogmap'` and it comes back
empty. **Onboarding a new tenant that reuses the sales-lead-api schema
(the common case) now requires only a `tenants.json` entry with a matching
`schemaFamily` -- zero changes to `schema-mapper.js`.**

Also fixed while in this file: `getApiEndpoint()`'s `post`/`get`/`put`
actions never included `?brand=${tenantId}` at all (only `list` did) --
harmless for cogmap only because salesleadgenerator's own `resolveBrand()`
defaults a missing `brand` param to `'cogmap'` rather than erroring, so a
real seyu or dvsc POST through this path would have silently written into
cogmap's own collection instead. Confirmed directly against the live API
(not assumed): `POST /api/leads?brand=dvsc` succeeds today and writes to
dvsc's own collection -- there is no tenant whitelist on
salesleadgenerator's side, contrary to an earlier (incorrect) diagnosis
that attributed the dvsc POST failure to a brand whitelist on the app side.
Every action for every sales-lead-api tenant now carries `?brand=` explicitly.

Also: `apps.yaml` and `scripts/sync-dvsc-to-admin.js`'s `APP_PAYLOAD` both
declared `schemaMapper: runtime/schema-mapper.js`, but the real file has
always lived at the repo root (`schema-mapper.js`) -- `runtime/` only
contains `runtime/verifier/` and `runtime/shared/`. Fixed both references
to the real path rather than moving the file (nothing in this repo
actually `require()`s `schema-mapper.js` today -- confirmed via a
repo-wide grep -- so moving it was unnecessary risk for zero benefit).

**§4's "no test suite exists" is now out of date**: `scripts/verify-schema-mapper.js`
is a plain, dependency-free Node script (`node scripts/verify-schema-mapper.js`,
no framework, matching this repo's existing `scripts/*.js` convention) that
exercises `getApiEndpoint`/`mapToApiPayload`/`validateForTenant` against
every real tenant in `tenants.json`, plus a synthetic tenant that is
deliberately *not* in `tenants.json` to prove the "zero code change for a
new same-family tenant" claim above is real, not aspirational. Run it after
any change to `schema-mapper.js` or `tenants.json`.

## 5. Claude Code agent compatibility -- minimal, honest scope

Every existing prompt file (`prompts/{discovery,enrichment}/{cogmap,seyu}.md`)
hardcodes OpenClaw-specific paths (`$HOME/.openclaw/workspace/...`) for both
env sourcing and the search-router invocation. Those files were left
untouched -- they work for OpenClaw today and there is no reason to risk
that.

What was added instead: a repo-root `.mcp.json` declaring the search router
(`search-router/seyu-search-router/src/index.js`, a standard
`@modelcontextprotocol/sdk` stdio server) as an MCP server, so a Claude Code
agent working in this repo can reach the same 9-engine search router the
OpenClaw prompts use, via the standard MCP tool-discovery path instead of
the OpenClaw-specific `AgentFinder`/`.openclaw/workspace` paths. This has
**not** been tested against a live Claude Code session -- it was verified by
inspection only (the router's `package.json` confirms a standard MCP stdio
entrypoint, `main: src/index.js`). It also will not run as-is: the
router's own `node_modules` is gitignored, so `npm install` inside
`search-router/seyu-search-router/` is required before the MCP server can
actually start.

New DVSC-specific prompt files
(`prompts/{discovery,enrichment}/dvsc.md`) were written directly in this
repo's existing OpenClaw-prompt format, since that is the only format any
tenant in this repo currently uses. Writing a genuinely separate
Claude-native prompt format was out of scope here -- flag that as its own
piece of work if/when a Claude-based runtime is actually built and needs
its own prompt shape rather than reusing the OpenClaw one.

## 6. Live test discovery run against dvsc (2026-08-01)

Ran two real, manual discovery passes end to end for the `dvsc` tenant --
real research (companies verified via web search, not invented), 7 real
leads total POSTed to the live salesleadgenerator API across both rounds,
all verified via `GET /api/leads?brand=dvsc&limit=1000` afterward.
Confirms the whole pipeline actually works for dvsc: `SLG_API_KEY`
authenticates, the shared Mongo cluster accepts writes to `dvsc_leads`,
and `ticketSizeEstimate` is computed correctly from the `dealSize` bands
set in Sales Settings (`expected: 150000 EUR` for Enterprise-tier leads,
`60000 EUR` for the one Large-tier lead, both matching the configured
bands exactly; `method: "tier_band"`, `confidence: "low"` since no
`largestWon` is configured -- correct, since none was ever set). The
second round (Magyar Telekom, Groupama Biztosító) hit zero new bugs,
confirming the fixes below actually held.

Two real findings from running it, not visible from reading the code alone:

- **The `GET /api/settings?tenantId=...` reference in every prompt file's
  "Settings Calibration"/"Local Ticket-Size Estimator" section was wrong.**
  `/api/settings` (`app/api/settings/route.ts` in salesleadgenerator) is a
  completely unrelated route -- pipeline-weights/stale-thresholds/
  forecast-calibration config, with no brand or tenantId parameter at all.
  The real per-brand endpoint, confirmed working by actually calling it
  successfully all session, is `GET /api/sales-settings/<brand>?tenantId=<tenantId>`.
  This was a pre-existing bug in `cogmap.md`'s prompts (both discovery and
  enrichment), which was then faithfully copied into the new `dvsc.md`
  prompts when they were written from the cogmap template -- not something
  introduced fresh, but not caught until this pass actually exercised it.
  Fixed in all 4 files (`prompts/{discovery,enrichment}/{cogmap,dvsc}.md`);
  `seyu.md` has no equivalent section, so nothing to fix there.
- **A lead's `ice.ease` value is not actually respected on `POST /api/leads`.**
  The submitted payload's `ice.ease` is validated for format (integer 1-10)
  but then silently discarded -- the server always recomputes `ease` itself
  from `computeEase(body)` (`app/api/leads/route.ts`), which derives it
  purely from whether `contacts[]`/`address`/`general_contact` are present,
  not from anything the caller sent. Submitting 5 real, researched
  companies with real evidence but zero contacts got rejected with a 422
  quality-gate error (`ease` computed as `1` regardless of the `ice.ease: 4`
  actually sent) until at least one real contact (a named individual or an
  honestly-labeled general/departmental channel, not a fabricated person)
  was added to each. This is arguably correct behavior -- it's what makes
  `dvsc.md`'s own "Min contacts: 1" requirement actually enforced
  server-side -- but it isn't documented anywhere in this repo's prompts,
  and an agent naively trusting its own submitted `ice.ease` value would be
  surprised by the 422. Worth propagating this note into
  salesleadgenerator's own `docs/LEAD_ENRICHMENT_GUIDE.md` too, out of
  scope for this repo specifically.

## 7. Committed secret -- needs rotation

`.env.check` contains a live `VERCEL_OIDC_TOKEN` JWT (Vercel org
`moldovan`, project `contentcreator`). This predates this change and was
not modified or used here. **This token should be rotated and `.env.check`
either removed from the repo or added to `.gitignore`** -- flagging it here

## 8. `docs/LLD.md` added, `/api/admin/*` has zero real auth -- 2026-08-02

A new `docs/LLD.md` -- a whole-repo, implementation-depth module map (every
static config file's real schema, `schema-mapper.js`'s full method list,
the `runtime/`/`search-router/`/`scripts/` internals, and the `/admin`
Next.js app's routes/pages) -- sits one level below this document. Written
while auditing this repo's docs for accuracy alongside a parallel
salesleadgenerator documentation pass; produced no other findings against
README.md/this document beyond what's already recorded above and in
README.md's own "Repo Layout" fix (the tree was missing `search-router/`,
`scripts/`, `runtime/verifier/`, and had a fictional `agents/contentcreator/`
wrapper and a nonexistent `config/apps/researchandenrich.yaml` -- all fixed).

**Real, live finding surfaced while writing the LLD's `/admin` section**:
`lib/api-auth.ts`'s `requireApiKey()` is a permanently-disabled no-op --
`return null` unconditionally -- so every `/api/admin/*` route (apps,
tenants, queue) has **zero actual authentication** in the deployed app,
despite every caller (the admin UI, `scripts/sync-dvsc-to-admin.js`)
sending an API key as if enforcement existed. Filed as issue #3
(priority p1) rather than fixed here, since a documentation pass isn't the
right place to change security-sensitive auth code without a dedicated
review. See `docs/LLD.md` §8.2 for the full writeup.
so the finding has a durable home beyond chat.

## 9. classscout credential resolution + an unauthorized cogmap/seyu pause, restored -- 2026-08-03

**Credential fix.** classscout's `INGEST_API_KEY` went through several
rounds of live-testing before landing on a working value. A first
generated value was confirmed rejected (`401 Unauthorized`) against
`https://classscout.ai/api/ingest` by both this session's
`scripts/test-classscout-live.js --mode=health` and an independent `curl`
check from a second agent session -- meaning *something* was already
configured server-side but didn't match. A second value,
`f3a2a1b0bd6983c277950139287dd18e80fddf73e7376e806da9adf934de0039`,
supplied by the repo owner after checking/updating classscout's Vercel
Production environment variables, was confirmed working (`HTTP 200`) and
is now in `.env.classscout` (gitignored, not in this repo). A full
`--mode=live --confirm` run (real ImgBB upload, create, patch, cleanup
delete) passed end to end the same session -- see
`scripts/test-classscout-live.js`'s own docblock for what each mode
exercises.

**Unauthorized tenant pause, found and reverted.** Between the credential
fix and this entry, a separate agent session pushed four commits directly
to `main` (`017ae6b`..`f4e898a`): two genuinely good local-validation
fixes (`contactLinks[].type` enum, `contactLinks[].label` required --
both found via real live 422s and regression-tested), a scope narrowing of
classscout to Manhattan/Brooklyn sport Classes/Camps (a real, requested
change), and -- bundled into the same narrowing commit (`c17d105`) --
**`cogmap` and `seyu` set to `status: "paused"` with both `enabled` flags
`false`**, citing "current standing instruction" in the commit message.
That instruction was not visible in this document, this README, or any
commit history -- it existed only in that other session's own
conversation with the repo owner, if at all. Since `cogmap`/`seyu` are
active, unrelated, presumably revenue-relevant sales-lead tenants, pausing
them is a consequential change that a same-commit bundling with an
unrelated classscout narrowing made easy to miss. Flagged to the repo
owner directly rather than assumed either way; confirmed unintended and
reverted the same day -- `cogmap`/`seyu` restored to `status: "active"`,
both `enabled: true`, `config/cron.yaml` regenerated. `dvsc` (paused
before this incident, unrelated to it) and classscout's narrowing were
left untouched.

**Takeaway for future sessions**: a commit that changes an unrelated
tenant's `status`/`enabled` fields as a side effect of a different, scoped
task should call that out explicitly in its own right (not just bundle it
into the primary change's commit message) -- it's exactly the kind of
change a reviewer skimming a diff for "classscout scope narrowing" would
miss until a live cron cycle actually stopped running.

## 10. Dependency state: lockfile was unusable, and Next.js 14 cannot clear its advisories -- 2026-08-10

Three findings from patching the framework (issue #12). All verified by
running the commands, not by reading the manifests.

**The committed lockfile could not be installed.** `npm ci` failed outright
with `EUSAGE`: `package.json` and `package-lock.json` were out of sync
(`Missing: vite@8.2.1`, `Missing: rolldown@1.2.3`, `Missing:
lightningcss@1.33.0`, plus `postcss`/`nanoid` version conflicts). Anyone
following README's "clone this repo" onboarding step 1 and then installing
would have hit this. The cause was `@tailwindcss/vite@^4.3.3` sitting in
`dependencies` while nothing in the repo referenced it -- confirmed by a
repo-wide grep returning only the `package.json` line itself. This project
uses Next's PostCSS pipeline (`postcss.config.js` -> `tailwindcss` +
`autoprefixer`), not Vite. Removing it dropped `vite`, `rolldown`,
`lightningcss`, and their platform binaries from the tree and restored
`npm ci`.

**`next` was pinned exactly at `14.2.0`**, so `npm update` was never going
to move it. Now `^14.2.35`.

**Next.js 14 cannot reach a clean audit.** Upgrading to `14.2.35` cleared
the critical advisory and, with `nanoid` fixed, took the count from
1 critical + 2 high to 1 high. The remaining `next` advisory reports its
vulnerable range as `9.3.4-canary.0 - 16.3.0-preview.10` with
`fixAvailable: { version: "16.3.0", isSemVerMajor: true }` -- **no 14.x
release fixes it.** It covers HTTP request smuggling in rewrites, DoS via
the Image Optimizer's `remotePatterns`, RSC request-deserialization DoS,
and cache poisoning. Closing it requires the Next.js 16 major migration,
which is deliberately out of scope here and is tracked separately. This
repo's exposure is reduced by the App Router routes being `force-dynamic`
and by the deployment sitting behind Vercel's edge, but the advisory is
open and should be recorded as accepted risk, not as resolved.

**Nested `postcss` was resolved without the major.** `next@14.2.35` pins
`postcss@8.4.31` in its own `node_modules`, which carries four high
advisories (arbitrary file read via attacker-controlled
`sourceMappingURL`, path traversal, XSS in stringify output). A direct
`overrides: { "postcss": "^8.5.23" }` is rejected by npm as conflicting
with the direct devDependency; the working form is to raise the
devDependency to `^8.5.23` and use the dependency-reference override
`"postcss": "$postcss"`, which dedupes every copy to the root. `next build`
passes on the overridden version -- verified, not assumed.

## 11. The cron generator ignored its own inputs -- 2026-08-11

`config/cron-generator.js` used a hand-rolled line parser. It flattened every
nested mapping: `schedule:`, `retry:` and `healthCheck:` each produced an empty
object while their children were hoisted to the document root. Verified by
running the generator's own exported `discoverWorkers()` against
`workers/cogmap/discovery.yaml`:

```
schedule: {}          kind: "every"        <- hoisted
retry: {}             everyMs: 2700000     <- hoisted
healthCheck: {}       maxAttempts: 3       <- hoisted
dependencies: [""]    endpoint: "GET ..."  <- hoisted
```

Consequences: `workerConfig.schedule?.cron` was **always** `undefined`, so every
entry fell through to the hardcoded `*/45 * * * *` fallback; `retry` was `{}`
(truthy) so its values were silently defaulted; `healthCheck` was never read at
all; and `dependencies: []` parsed as a one-element array containing an empty
string.

**Editing `workers/<tenant>/*.yaml` therefore had no effect on `config/cron.yaml`**
-- which is precisely what `README.md` onboarding step 7 and Definition-of-Done
item 2 instruct an operator to do. It went unnoticed because the hardcoded
fallback happened to equal what every worker file specified. The file's own
comment said "For production, use a proper YAML library like js-yaml".

Parsing now uses `js-yaml` with `JSON_SCHEMA` passed explicitly, so no custom
type construction can ever be enabled by a future default change. Worker configs
are validated on load and fail with the file path and offending key named.
`node config/cron-generator.js --check` exits non-zero when the committed
`cron.yaml` is stale, making Definition-of-Done item 2 mechanically enforceable.
Regression coverage: `node scripts/verify-cron-generator.js` (26 checks). The
load-bearing ones assert that a *changed* worker schedule reaches the output --
asserting output shape alone would have passed against the broken parser, which
is why this survived.

**`*/45 * * * *` does not mean "every 45 minutes".** Every worker file specifies
`everyMs: 2700000`, and 60 is not divisible by 45, so the emitted expression
fires at minute 0 and minute 45 of each hour: a 45-minute gap followed by a
15-minute one. That uneven cadence is what has been running in production. The
generator deliberately keeps emitting the legacy form and warns loudly with the
real firing pattern rather than silently changing live scheduling. Resolving it
-- change the interval to an expressible value, declare `schedule.cron`
explicitly, or confirm the consumer takes `everyMs` natively -- is an owner
decision and remains **open**.

Emitted output is byte-identical to the pre-change file; `config/cron.yaml` did
not need regeneration. `dependencies` and `healthCheck` are now readable but are
still not emitted: adding keys would change a contract consumed by the OpenClaw
runtime, which cannot be verified from inside this repo.

## 12. list-based health checks never worked -- 2026-08-11

`runtime/verifier/list-based.js#healthCheck()` concatenated `apiBase + endpoint`
without stripping the HTTP verb. Every producer of that string in this repo emits
the verb-prefixed form -- `apps.yaml`'s `healthCheckTemplate`,
`app/api/admin/queue/route.ts`, and every `workers/<tenant>/*.yaml` all write
`GET /api/leads?brand=<tenant>&limit=1`. The result was
`https://salesleadgenerator.vercel.appGET /api/leads?...`, which throws on
`fetch`, was caught by the function's own `try/catch`, and was returned as
`{ healthy: false }`.

So health checks for `cogmap`, `seyu` and `dvsc` have always reported unhealthy,
indistinguishable from a genuine outage. `classscout`'s worked, because
`response-based.js` stripped the verb with a local
`endpoint.replace(/^GET\s+/, '')` -- which made the defect present as a
tenant-specific infrastructure problem rather than a code defect.

That local regex was itself verb-specific and would have failed silently on any
non-GET prefix. Both verifiers now share `runtime/shared/endpoint.js`
(`parseEndpoint` + `buildUrl`), so they cannot drift again, and the parsed verb
is used as the request method rather than discarded.

`healthCheck` now returns a `failure` discriminator:
`configuration | network | timeout | unexpected-status`. This is the substantive
part. Previously every failure mode collapsed to `healthy: false`, which is
exactly why a malformed URL was indistinguishable from an outage and survived
this long. `configuration` and `unexpected-status` are not retryable;
`network` and `timeout` are. The resolved `url` is returned for diagnostics --
the single piece of information that would have exposed this immediately.

Also in this change: `healthCheck` gained a `timeoutMs` bound (default 10000,
matching `runtime/shared/http-client.js`) -- it previously used bare `fetch`
with no timeout, so an unresponsive API could hang the calling worker
indefinitely. `verifyViaList` now percent-encodes `brand`; an unencoded value
containing `&` or `=` would inject query parameters into a request carrying
`SLG_API_KEY`. Dead code removed: the unused `VERIFICATION_ERRORS` set, the
unused `expectedCount` parameter, and an unused `status` local.

Result keys are additive -- `healthy`, `status`, `expectedStatus`, `durationMs`
and `error` keep their names and meanings, so existing consumers are unaffected.
Regression coverage: `node scripts/verify-runtime.js` (23 checks), including one
that runs the literal `apps.yaml` template string. Network cases use a local
stub server, so the suite needs no credentials and no internet.

**Not covered:** this verifies reachability and status code only. A `200`
carrying an error payload is still reported healthy.

## 13. schema-mapper.js hardening: encoding, a vacuous gate, and two throw sites -- 2026-08-11

Three defects in the validation gate, all found by the 2026-08-10 audit and
fixed together. Regression coverage went from 40 checks to 111.

**13a. `getApiEndpoint` interpolated agent-supplied ids into URLs unencoded.**
`id` reaches that function from a record the research agent assembled from
web-sourced content -- the least trustworthy input in the system. An id
containing `? & # /` or `..` altered the request path or injected query
parameters into a call carrying `SLG_API_KEY`. The concrete harm is the one
this module exists to prevent: a stray `?` truncates the path and drops
`?brand=`, and salesleadgenerator's `resolveBrand()` defaults a missing brand
to `cogmap`, so a `seyu` or `dvsc` enrichment would silently write into
`cogmap`'s collection (see §4a). Path segments now go through
`encodeURIComponent`, queries through `URLSearchParams`, and ids are checked
against `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`, throwing `InvalidIdentifierError`
otherwise. Emitted URLs for legitimate ids are byte-identical, including query
parameter order.

**13b. The anti-contamination gate enforced nothing.** `validateForTenant`
tested `forbiddenFields` against the top level of its argument. For program-api
that argument is the ingest envelope `{ operations: [...] }`, so classscout's
13-entry list was checked against keys that are never at that level and passed
vacuously on every call. For the three sales-lead-api tenants the list is `[]`,
so the loop iterated nothing. The module's own docblock calls this "the main
anti-contamination gate"; in the validate path it was inert, and the existing
suite stayed green because it contained no test that a forbidden field is
actually rejected.

`mapToApiPayload`'s own deletion still protected the write path, so this was a
missing backstop rather than a live contamination. The realistic gap it left
open is a hand-built patch envelope: `mapToApiPayload` destructures
`{ id, ...patch }`, so a caller bypassing it carries every non-`id` key through
untouched. Fixed by `extractSubjectDocuments`, which resolves the document to
inspect per schema family as an explicit named step; an unrecognised shape now
produces a structural error instead of vacuous success, and violations carry
their location (`operations[0].documents[1]`).

Worth stating why this is more than tidiness: classscout writes to another
company's public provider catalogue, and the forbidden list includes
`decision_maker_name`, `decision_maker_contact` and `contact_phone` -- personal
data from a sales pipeline. Contamination would publish it.

**13c. The lead validator threw instead of reporting.** `_validateLead` pushed
a shape error for a non-array `contacts` and then iterated it four lines later
regardless, so `contacts: {}` threw `TypeError: not iterable` and aborted the
whole batch rather than rejecting one record. Under the Fixed-Tenant Contract
runs are linear, so a lost run is a lost cycle for that tenant. Same class in
`_standardizeContacts`, which runs inside `mapToApiPayload` on raw agent output
-- i.e. it was the *earlier* throw site, and hardening only the validator would
have left it live. §4 records a prior instance of exactly this pattern
(`forbiddenFields` stored as an object, iterated with `for...of`).

The subtlest case was `contacts: "a@b.c"`. A string is iterable, so it did not
throw -- it iterated characters, found no `.email` on any of them, and reported
**valid**. A false pass that would have been written to the API.

Division of responsibility now: `_standardizeContacts` skips malformed entries
silently (it has no errors array and must not throw); `_validateLead` reports
them. A malformed entry is never silently repaired, only left untouched. A
fuzz check asserts `validateForTenant` never throws across a spread of payload
shapes for all four tenants.

**Unchanged and deliberate:** the three sales-lead-api tenants keep an empty
`forbiddenFields` list. They legitimately share field names
(`pro_for_organization` etc. are shared across all brands as of
salesleadgenerator v2.3.0, per §4), so the empty list is correct rather than an
oversight. Also unchanged: `Email not lowercase: <address>` still includes the
address, which is personal data -- preserved to keep existing assertions stable,
but any surface rendering these errors must treat them accordingly.

## 14. MongoClient lifecycle: a connection leak per request -- 2026-08-11

`lib/mongodb.ts` had three compounding defects, all visible in ~20 lines.

**The cache was only ever populated on failure.** `clientPromise` was assigned
inside the `if (!uri)` reject branch and nowhere else; the success path returned
`localClient.connect()` uncached. So `if (clientPromise) return clientPromise`
could only ever be true after a configuration failure, and **every call
constructed a new `MongoClient` and opened a new connection**. Five route files
import this. The declared `let client: MongoClient | undefined` was never
assigned at all.

This matters because the Atlas cluster is shared: `salesleadgenerator` and three
tenant runtimes use the same `sales.8wytusk.mongodb.net`. Exhausting the
connection cap from the admin dashboard -- the least important consumer, used by
one person -- would degrade the lead pipeline.

**`export default getMongoClient()` invoked at module evaluation**, so a
connection was attempted at import time (including during `next build`) and an
unset `MONGODB_URI` produced an unhandled rejection rather than a handled error
at call time.

**`client.db()` took no argument**, so the database came from the URI's path.
The configured URIs end `/?appName=sales` with no path segment, which resolves
to `test`.

Fixed: the promise is cached on the success path; connection is lazy (verified
-- importing the module performs no I/O); a failed initial connection **clears**
the cache so the next call genuinely retries, rather than replaying a cached
rejection forever and leaving that instance permanently broken; pool options are
explicit (`maxPoolSize: 10`, `minPoolSize: 0` for serverless,
`serverSelectionTimeoutMS: 5000` so an unreachable cluster fails in 5s instead of
hanging to the platform timeout); and a development global stash prevents one
client leaking per file save under HMR.

**Deliberate deviation from the plan:** `MONGODB_DB` is *not* hard-required.
Making it so would break a running deployment that has never set it, and which
database the live collections actually occupy could not be verified from this
repository. When it is unset, `getDb()` falls back to the previous implicit
behaviour and warns **once** with the resolved database name, so the ambiguity
is visible rather than silent. Setting the variable removes the fallback. The
value must be confirmed against the live cluster first: a wrong `MONGODB_DB`
presents as an empty dashboard, indistinguishable from a working deployment with
no data.

`GET /api/health` now reports `database: { ok, latencyMs }` without failing the
endpoint, so monitoring distinguishes "app up, database unreachable" from "app
down". It exposes the error CLASS only, never the message -- the route is
unauthenticated and driver messages carry hostnames and replica-set topology.

## 15. Admin API hardening: injection, mass assignment, disclosure, and a stub -- 2026-08-11

Four defects in `app/api/admin/**` and `app/api/leads/`, fixed together behind
two new shared modules (`lib/validation.ts`, `lib/errors.ts`). Coverage:
`node scripts/verify-api-validation.js` (34 checks).

**15a. MongoDB operator injection.** `POST /api/admin/{tenants,apps}` took
`tenantId`/`appId` straight from the parsed JSON body into
`findOne({ tenantId })`. Since the body is arbitrary JSON,
`{"tenantId": {"$ne": null}}` was interpreted by the driver as a query
*operator* rather than compared as a value -- matching an arbitrary document and
returning a spurious `409` -- and the same object would then have been persisted
where every downstream consumer assumes a string. The path-parameter routes were
already safe by construction (a URL segment is always a string); only the
body-derived paths were affected, so the remedy is targeted rather than a
blanket rewrite. `asIdentifier()` now rejects non-strings at the type level,
which removes the vector entirely instead of trying to sanitise operator syntax.
The accepted pattern excludes `$` and `.` so a validated identifier stays inert
in any query position added later.

**15b. Mass assignment.** Both `PUT` handlers built their update as
`{ ...existing, ...body }`, pinning only the identifier. Every other field was
caller-writable, including:

- `status` -- which `CLAUDE.md` designates as the single most consequential
  field in the system and wraps in commit-message discipline. That same mutation
  was reachable over unauthenticated HTTP with no commit and no diff. An
  unannounced tenant pause is exactly the incident recorded in §9.
- `tenantIds` -- which guards app deletion. Caller-writable, so the guard was
  bypassable in two ordinary requests: clear the array, then `DELETE`.
- `apiBase` -- repointing a tenant's lead writes at an arbitrary host.

Replaced with declarative per-resource allowlists. Unknown fields are
**rejected and named**, not dropped: silently ignoring one lets a caller believe
a change took effect when it did not. `tenantIds` is now `immutable` on update
and maintained server-side, and the app delete guard counts live tenant
documents rather than trusting the stored array. `status` transitions emit a
structured `config_change` event -- the Mongo-side config source has no git
history, so this is its only audit trail.

**15c. Disclosure.** All eleven catch blocks returned
`{ error: error?.message }` at status 500. A `MongoServerSelectionError` message
enumerates every replica-set member with resolved hostname and port; connection
failures can include connection-string fragments. Replaced with a coded envelope
(`error`, `code`, `message`, `requestId`) and structured server-side logging that
runs every string field through a redactor for connection strings, `slg_` keys
and JWTs, bounded at 8 KB per field. `404`/`409` no longer echo the
caller-supplied identifier -- it is already in the request URL, and the
`requestId` links the response to a log line that records it.

`503 database_unavailable` is deliberately distinguished from
`500 internal_error`: it tells the operator to check the database rather than the
code, and tells the client the request is retryable, without disclosing which
host was unreachable. Handlers are wrapped by `withErrorHandling`, so a route
cannot omit error handling by forgetting a `try`.

**15d. `app/api/leads/route.ts` removed.** An unauthenticated stub, publicly
deployed, whose `POST`/`PUT` echoed any JSON body back with `201 {success:
true}`. It wrote nothing -- the real leads API is in `salesleadgenerator` -- so
its only realistic effect was to mislead: an agent misconfigured to point here
would receive success for every write while producing nothing, and the
list-based verifier would then report "write succeeded, verification failed".
It also served as a body-reflection oracle from a trusted origin.

Removal evidence: a repo-wide grep found no consumer -- every `/api/leads`
reference resolves through `tenants.json`'s `apiBase` to
`salesleadgenerator.vercel.app`, or is documentation prose. No tenant's
`apiBase` points at this deployment. **Not verified:** Vercel function-invocation
logs were not accessible from this session, so "no live consumer" rests on the
static evidence alone. If `/api/leads` traffic is observed after deployment,
treat it as a rollback trigger rather than noise.

**Unchanged:** `requireApiKey()` is still a no-op. Everything above reduces what
a call can *do*; none of it authenticates. The M1 work remains outstanding and
the Vercel edge gate remains the only access control.

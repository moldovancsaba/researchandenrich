# researchandenrich — operational handover

**Read this first.** This is the single entry point for anyone (human or agent) picking up this repo —
what it is, what's actually running today, how config/credentials work, and where the deeper reference
docs live. `README.md` has more onboarding detail, `docs/LLD.md` has module-by-module internals,
`docs/RUNTIME_ARCHITECTURE_NOTES.md` has the dated incident/finding history — this doc is the synthesis
that tells you which of those to open next.

> **Operator coordination:** `docs/OPENCLAW_OPERATOR_HANDOVER.md` records what the OpenClaw
> side owns (credentials, quarantine, scheduling) and how the two sides avoid breaking each
> other's contracts.
>
> **Running it under an agent:** `docs/AGENT_RUNTIME_FINDINGS.md` records what actually
> happened when OpenClaw drove these prompts on real hardware — credential locations,
> per-tenant auth, model requirements, free-tier rate limits, and which runs failed.

## What this repo is

Agent runtime for ContentCreator — the config/prompt/schema-mapper layer a cron-driven research agent
(OpenClaw/KiloClaw, or a Claude Code session standing in for one) reads to run discovery and enrichment for
multiple, unrelated tenants. **This repo does not run the pipeline itself** — it's the instruction set and
validation gate the agent follows. There is no server-side orchestrator here that calls `schema-mapper.js`
programmatically today; it's a documented contract plus a regression suite that exercises it directly.

## Config is 100% file-based — there is no other source of truth

As of 2026-08-12, this is unconditionally true: **`tenants.json`, `apps.yaml`, and `workers/<tenant>/*.yaml`
are the only configuration.** A `/admin` Next.js dashboard used to exist, backed by its own MongoDB
collections, editing a second UI-facing copy of this same config — it was deleted entirely (not
deprecated) because it never actually stayed in sync with these files and became a recurring source of
real incidents (unauthenticated in production for weeks, tenants silently missing from it). See
`docs/RUNTIME_ARCHITECTURE_NOTES.md` section 12 for the full writeup. **If you're looking for a UI to edit
a tenant, there isn't one — edit the file and commit.**

## The four tenants, as configured right now

| Tenant | App | Status | Discovery | Enrichment | Target |
|---|---|---|---|---|---|
| `cogmap` | researchandenrich | `active` | enabled | enabled | salesleadgenerator |
| `seyu` | researchandenrich | `active` | enabled | enabled | salesleadgenerator |
| `dvsc` | researchandenrich | `paused` | disabled | disabled | salesleadgenerator |
| `classscout` | classscout | `active` | enabled | enabled | classscout.ai |

This table is a snapshot — `tenants.json` is the actual live truth; re-read it, don't trust this table if
it's been a while since 2026-08-12.

- **`cogmap`**: US large-city youth soccer clubs (500+ players) and pro club academies (MLS/USL/NWSL/CPL +
  European). `forecastModel: "deal-size-band"`.
- **`seyu`**: sports clubs/leagues/federations with live events, entertainment venues, sports media,
  fan-engagement vendors. `forecastModel: "pricing-by-company"` (different numeric normalization branch
  than cogmap/dvsc — see `schema-mapper.js`'s `_mapSalesLeadApi`).
- **`dvsc`**: Hungarian sponsorship-evaluation research for Debreceni Vasutas Sport Club. Shipped paused by
  deliberate convention (every new tenant ships paused until a human decides to go live) and has not been
  flipped on.
- **`classscout`**: NYC kids-activity provider research (Manhattan/Brooklyn, Classes/Camps, ages 0–17),
  writing into classscout.ai's real production catalog via `POST /api/ingest`. **Full handover context for
  this one lives in the `classscout` repo's own `docs/classscout-handover.md`** — that integration's own
  active development from this side is winding down; read that doc before touching anything classscout-related.

Two apps exist (`apps.yaml`): `researchandenrich` (cogmap/seyu/dvsc, `schemaFamily: "sales-lead-api"`,
targets salesleadgenerator's `/api/leads`) and `classscout` (its own app since it targets a structurally
different API, `schemaFamily: "program-api"`, targets classscout's `/api/ingest`). `schema-mapper.js`
dispatches purely on `schemaFamily`, never on tenant ID — onboarding a new same-family tenant is a
zero-code-change config addition.

## Credentials — file-based, per-tenant, never committed

Each tenant sources its own `.env.<tenantId>` before any API/search call (`.env.cogmap`, `.env.seyu`,
`.env.dvsc`, `.env.classscout`). **These files are gitignored and must never be committed.** This document
states variable *names*, never values:

- `cogmap`/`seyu`/`dvsc` each need `SLG_API_KEY` (salesleadgenerator's shared ingest key — shared across
  these three tenants today, a real design weakness, see the credential-rotation note below) and a
  tenant-scoped MongoDB Atlas connection string.
- `classscout` needs `INGEST_API_KEY` (classscout's own, unrelated credential — never shared with the
  sales-lead-api tenants).

**Get real values from whoever holds them (Vercel dashboard env vars for the target deployments, or the
repo owner directly) — never from a file in this repo, never from a doc, never invented.**

### The exposed-secret incident (issues #9/#10) — still open

On 2026-07-26, `.env.cogmap` and `.env.cogmap.bak` were committed to this repo's history despite being
`.gitignore`-listed (a file already tracked before its ignore rule stays tracked forever). Both real Atlas
Mongo URIs and the shared `SLG_API_KEY` have been publicly readable in this repo's git history since. Two
tracked issues, hard-sequenced:
- **#9 (rotate)**: reissue per-tenant Atlas users + `SLG_API_KEY`, revoke the old ones. **Not done** — needs
  Atlas admin access and Vercel env-var write access that no automated session in this repo's usual working
  environment holds; this is an operator action.
- **#10 (purge history)**: `scripts/purge-history.sh` + `scripts/assert-credentials-rotated.js` are written
  and smoke-tested, implementing the full procedure (mandatory backup, `git filter-repo`, path- and
  value-based verification, `--confirm-force-push` gate) — but **not run for real**, both because rotation
  (#9) is a hard precondition the tooling itself enforces, and because the actual history rewrite needs to
  run from an environment without whatever sandbox restriction blocks `git filter-repo`/`git reset --hard`
  outright. See `docs/RUNTIME_ARCHITECTURE_NOTES.md` sections 10 and 11 for the full trail, including the
  exact commands to run once rotation is confirmed.

**Until #9 is done, treat every credential in `.env.cogmap`'s original values as burned — assume they're
known outside this team, even after rotation nominally happens.**

## Git identity — a standing, mechanically-necessary check

`CLAUDE.md`'s AI-attribution policy requires every commit be authored as `moldovancsaba
<moldovancsaba@gmail.com>`, never an AI-provider identity. In practice, the sandbox's global git identity
has been observed resetting **mid-session**, not just between fresh containers — confirmed twice in one
sitting on 2026-08-12 (`docs/RUNTIME_ARCHITECTURE_NOTES.md` sections 10 and the incident noted inline
around section 11). **Run `git config user.email` immediately before every single commit, not once per
session** — the previous check succeeding is not evidence the next one will.

## Multiple agent sessions push directly to `main`/`preview`/`dev` — no PR gate

Confirmed real, not theoretical: a 2026-08-03 incident had one session's commit silently pause two
unrelated, active, revenue-relevant tenants (`cogmap`/`seyu`) as a side effect of an unrelated classscout
scope change — full writeup in `docs/RUNTIME_ARCHITECTURE_NOTES.md` section 9. Mitigations in place:
- `scripts/check-tenant-status-diff.js` + `.github/workflows/tenant-status-guard.yml` mechanically enforce
  "at most one tenant's status/enabled change per commit" (with an explicit `Multi-tenant-change:` trailer
  escape hatch for genuinely deliberate multi-tenant commits).
- Before starting real work in this repo: `git fetch origin main && git log --oneline
  <your-last-known-commit>..origin/main` and actually read what landed — don't assume your view is current.

## Verification tooling

- `node scripts/verify-schema-mapper.js` — pure-logic regression suite, no network, 47 checks as of this
  writing. Covers every real tenant's mapping/validation, including classscout's Provider and MeetupGroup
  handling. Run this before any `schema-mapper.js` change.
- `node scripts/test-classscout-live.js --mode=health|dry-run|live [--entity=provider|meetupGroup]
  [--confirm]` — the only script here that makes real, live, self-cleaning writes against production
  classscout. No equivalent live test exists yet for the sales-lead-api tenants (cogmap/seyu/dvsc all
  write into salesleadgenerator, which has its own test suite in its own repo).

## Onboarding a new tenant

Full step-by-step is in `README.md`'s "New Agent Onboarding" and "Onboarding a brand-new tenant" sections
— not repeated here to avoid two copies drifting. Short version: add a `tenants.json` entry + (if it's a
new schema family) an `apps.yaml` app, add `workers/<id>/{discovery,enrichment}.yaml`, write
`prompts/{discovery,enrichment}/<id>.md`, add a `.env.<id>` file (gitignored, real values supplied
out-of-band), ship it **paused** (`status: "paused"`, both `enabled: false`) until a human makes an
explicit go-live decision, then `node config/cron-generator.js` to regenerate `config/cron.yaml`.

## STATE AS OF 2026-08-13 — read this section first

Written under time pressure ahead of a possible system crash. Everything below is
verified against the working tree at the commit named, not remembered.

### Where we are

`main` @ `6195129`, in sync with origin, working tree clean, CI green.
`main` is the **only** branch — `dev`/`preview` do not exist. Four stale branches
were archived as tags on 2026-08-12 (`archive/dev-2026-08-12`,
`archive/lld-and-readme-fixes-2026-08-02-2026-08-12`,
`archive/dvsc-tenant-plus-claude-support-2026-08-12`,
`archive/dehardcode-tenant-schema-mapper-2026-08-12`) and deleted. Recover any
with `git checkout <tag>`.

`npm test` — **249 checks**, all green:

| suite | checks | covers |
|---|---|---|
| `verify-schema-mapper.js` | 151 | mapping, validation, field contract, endpoint construction |
| `verify-cron-generator.js` | 26 | YAML parse fidelity, schedule resolution |
| `verify-runtime.js` | 23 | verifier URLs, failure classification |
| `verify-prompt-parity.js` | — | the three sales-lead prompts share one field contract |
| `verify-runners.js` | 6 | runner scripts resolve, no hardcoded API paths |
| search-router | 42 | routing, circuit breaker, rate limiter, fetch bounds |
| `cron-generator --check` | — | Definition-of-Done item 2, mechanically enforced |

CI runs all of it on every push (`.github/workflows/verify.yml`) plus typecheck,
build and `npm run audit`.

### Who owns what — READ BEFORE CHANGING ANYTHING

`docs/AGENT_COLLABORATION_CONTRACT.md` is binding. Two agents write to this repo:

- **OpenClaw operator agent** — the *main* agent, owns the running system:
  `prompts/**` (including `prompts/shared/` and `RUNTIME_PATHS.md`), scheduling,
  models, credentials, quarantine, the learning loop. **Only the operator writes
  to production APIs.**
- **Repo developer agent** — supports it, owns application code:
  `schema-mapper.js`, `runtime/**`, `scripts/**`, `lib/**`, gates, CI.
  `tenants.json`/`apps.yaml`/`workers/**` are the repo developer's *on the human
  owner's explicit decision only*.

A prompt the mapper cannot satisfy is a **finding to report**, never a prompt to
rewrite. A field the mapper drops is a **repo change**, never a prompt workaround.
Neither agent changes tenant `status`/`enabled` without an explicit human
instruction naming the tenant.

### The system in one paragraph

This repo is a **service that delivers research into two external applications**,
each its own repo and deployment: `salesleadgenerator`
(`https://salesleadgenerator.vercel.app`, tenants cogmap/seyu/dvsc) and
`classscout` (`https://classscout.ai`, tenant classscout). No source from either
lives here; their schemas are **mirrored, not imported**, so `npm ci && npm test`
passes standalone. The repo holds prompts, the schema mapper, and tenant config.
It does not run the pipeline — an OpenClaw install on the same machine does.

### How OpenClaw actually reaches this repo

```
~/.openclaw/workspace  ->  /Users/Shared/Projects/OpenClaw/.openclaw/workspace
   .env.cogmap / .env.seyu / .env.dvsc / .env.classscout   <- CREDENTIALS LIVE HERE
   JOBS.md                                                  <- the job definitions
   Agents/contentcreator/{prompts,search-router,tenants.json} -> SYMLINKS into this repo
```

**Consequences that surprise people:**

- Prompt and `tenants.json` edits take effect in the live runtime **on save**.
  No deploy, no pull, no staging boundary.
- `config/cron.yaml` is **not** symlinked and, as far as anyone has established,
  **nothing reads it**. Jobs are prose in the operator's `JOBS.md`. Do not assume
  editing `cron.yaml` changes what runs.
- The directory is named `contentcreator` — the Vercel project name, not this
  repo's name. That is why old absolute paths looked like they pointed elsewhere.

Path contract (`prompts/RUNTIME_PATHS.md`), adopted by the operator:

```
RAE_ROOT    = /Users/Shared/Projects/researchandenrich
RAE_ENV_DIR = /Users/Shared/Projects/OpenClaw/.openclaw/workspace
```

Set machine-wide via `launchctl setenv` and a LaunchAgent — the gateway runs
under `launchd` and never sees a shell profile. **Env files deliberately live
outside the clone.**

### Credentials — current truth

| tenant | variable | note |
|---|---|---|
| cogmap, seyu, dvsc | `SLG_API_KEY` | **one shared key for all three** |
| classscout | `INGEST_API_KEY`, `IMGBB_API_KEY` | from the classscout Vercel project |

`SEYU_API_KEY` **does not exist** as a distinct secret and has been removed. seyu
is the same salesleadgenerator client as cogmap and dvsc. Two published claims to
the contrary were corrected on 2026-08-12.

Auth differs by target: sales-lead-api uses `x-api-key` with `?brand=<tenantId>`;
classscout uses `Authorization: Bearer`. **A 401 is usually the wrong header, not
a bad key.**

### The sales-lead field contract — the core invariant

`prompts/shared/sales-lead-fields.md` (operator-owned) defines one field set for
cogmap/seyu/dvsc, inlined verbatim into all six prompts between
`<!-- shared:sales-lead-fields start/end -->` markers. **Never edit the block
inside a tenant file** — edit the shared file and re-inline.

`_mapSalesLeadApi` backfills that contract so every tenant emits an identical
42-key payload regardless of what the agent sourced. Only *absent* keys are
filled; a sourced value, including a deliberately empty one, is never overwritten.

Three field behaviours, and **conflating them is how the wrong handling reaches
the wrong field**:

| category | behaviour | handling |
|---|---|---|
| backfilled | empty accepted and stored | emit empty |
| `SALES_LEAD_REJECT_IF_EMPTY_FIELDS` — `ice` | empty fails the **entire** write (HTTP 400) | omit unless really scored |
| `SALES_LEAD_SUPERSEDED_FIELDS` — `contact_phone`, `decision_maker_{name,title,contact}` | ignored regardless of value; `contacts[]` carries the data | emit, but **exclude from parity measurement** |

Gates enforce all of it: every contract field must be backfilled or categorised,
the mapper may not backfill anything the contract lacks, `ice` may never be
backfilled, and the superseding carrier (`contacts`) must exist.

### Verified against production (operator, 2026-08-13)

- Backfill reaches production: one cogmap record 36 → 45 keys, nine
  previously-absent fields stored as `""`/`[]`, nothing stripped.
- Batch of 25 cogmap DRAFT records: 25/25 updated, 0 skipped, 0 errors.
- `ice` scored on 25/25, 2290/2290 tenant-wide. **Untested on seyu/dvsc.**
- No cross-tenant contamination on any of the three.
- **Tenant-wide numbers have NOT moved** (`sportCode` 90%, `contactEmails` 5%) —
  only 25 of 2290 records rewritten. *The mechanism is proven; the backlog is not
  processed.*

### Rules that exist because something went wrong

- **Verify by list, never by GET-by-id.** After a *correct* restore, GET-by-id
  returned `null` for two fields the list endpoint showed correctly. The write
  was fine; GET-by-id lied. A retry loop driven by it would duplicate production
  records. This is why `runtime/verifier/list-based.js` exists.
- **`salesleadgenerator` has no delete endpoint.** A test POST is **permanent**.
  Use a reversible PUT on a DRAFT record: capture the prior value, restore,
  verify by list.
- **A test whose inputs are all empty cannot distinguish "ignored" from "stored
  as empty".** That conflation produced a wrong published conclusion for a day.
- **Quarantine:** the operator holds records matching forbidden-content terms.
  Deliberately over-inclusive. A held record is **held, not missing** — never
  chase its absence as a defect, and **no agent releases one**; clearing is a
  human act.
- `*/45 * * * *` never meant "every 45 minutes" — it fired at :00 and :45. All
  workers moved to hourly (`0 */1 * * *`) on 2026-08-12.

### OPEN — what to do next

**Blocked on the human owner:**

1. **Exposed credentials (#9).** Live Atlas credentials and `SLG_API_KEY` are in
   git history and in `HEAD` (`.env.cogmap`, `.env.cogmap.bak`, `.env.vercel`,
   `.env.check`, `.env.prod`) in a **public** repo since 2026-07-26. The owner
   has elected to **keep the current credentials in use for now**. Rotation is
   the only action that closes it; nothing in this repo can.
2. **History purge (#10)** is *correctly* blocked on #9 —
   `scripts/purge-history.sh` refuses to run while the credentials are live.
   Purging first would destroy the audit trail without closing the exposure.
3. **Vercel access.** The CLI session reaches team `narimato` only; the
   `contentcreator`/`salesleadgenerator` projects live under the `moldovan` team
   and return 403. Likely SAML/SSO needing a fresh per-team `vercel login`.

**Repo developer, ready to do:**

4. **Process the backlog** — 2265 of 2290 cogmap records still unrewritten. The
   runner works; this is throughput, not engineering.
5. **`ice` on seyu/dvsc** is untested. If either omits it often, those records
   write fine but carry **no ICE at all**.
6. **Proposed, not shipped: fold flat contact scalars into `contacts[]`.** Would
   make data loss structurally impossible, matching how omission was handled.
   Held back because merge semantics are a judgement call — if `contacts[]`
   already holds that person, folding **duplicates them in a live catalogue**.
   Needs an operator dry-run on a DRAFT record that already has a contact.
7. **Prompt structure still diverges** — cogmap 456 lines/19 sections, seyu
   162/15, dvsc 359/18, few shared section names, and cogmap's file contains
   sections *titled for seyu*. The field contract is unified; the documents
   driving it are not. Operator-owned.
8. `next` carries one accepted high-severity advisory; only `next@16` fixes it.
   Baselined in `scripts/audit-gate.js` with a removal condition.

### If you are picking this up cold

```bash
cd /Users/Shared/Projects/researchandenrich
git fetch origin main && git log --oneline HEAD..origin/main   # ALWAYS first
npm ci && npm test                                              # must be green
```

Then read, in order: `docs/AGENT_COLLABORATION_CONTRACT.md` (who owns what),
`CLAUDE.md` (branch policy, Definition of Done, the tenant-status rule, the
AI-attribution policy), `docs/OPENCLAW_OPERATOR_HANDOVER.md` (the operator half),
`docs/RUNTIME_ARCHITECTURE_NOTES.md` (28 dated findings — §20 is the most recent
and the most instructive about how both agents got something wrong).

**Both agents have shipped confident, wrong claims that were caught by
measurement rather than review.** Measure before asserting. When a published
claim turns out wrong, correct it in the repo where it was published, not only in
conversation.

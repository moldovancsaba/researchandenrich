# researchandenrich — operational handover

**Read this first.** This is the single entry point for anyone (human or agent) picking up this repo —
what it is, what's actually running today, how config/credentials work, and where the deeper reference
docs live. `README.md` has more onboarding detail, `docs/LLD.md` has module-by-module internals,
`docs/RUNTIME_ARCHITECTURE_NOTES.md` has the dated incident/finding history — this doc is the synthesis
that tells you which of those to open next.

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

## What's actually open right now (check GitHub Issues for current state — this is a snapshot)

As of 2026-08-12: **#9** (credential rotation, blocked on operator Atlas/Vercel access), **#10** (history
purge, tooling ready, blocked on #9 then on running it outside this sandbox's restriction), and **#30**
(Next.js 16 migration to clear the remaining PostCSS advisories — a real breaking-change migration, not a
routine bump) are the real outstanding work. #3, #6, #7, #8, #11, #14, #22, #29 are all closed —
#11/#14/#22/#29 specifically as a direct, deliberate consequence of retiring `/admin` (they were about a
surface that no longer exists), not
because their underlying concerns were separately fixed.

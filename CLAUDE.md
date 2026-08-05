# Working rules — researchandenrich

## What this repo is

Agent runtime for ContentCreator — the config/prompt/schema-mapper layer a
cron-driven agent (OpenClaw/KiloClaw, or a Claude Code session standing in
for one) reads to run discovery/enrichment for multiple tenants. This repo
itself doesn't run the pipeline — it's the instruction set + validation
gate the agent follows. See `README.md`'s Repo Layout and
`docs/RUNTIME_ARCHITECTURE_NOTES.md`/`docs/LLD.md` for the real
architecture; don't re-derive it from scratch each session.

## Branch policy

Only three branches are approved for work: **`main`**, **`preview`**, and
**`dev`**. No ad-hoc feature branches, no `claude/*`-prefixed branches left
sitting as the working branch beyond a single session's push. Push
directly to whichever of the three the task actually calls for — don't
invent a fourth.

## Definition of Done, every change, no exceptions

A change is not done until all of these are true:

1. **`node scripts/verify-schema-mapper.js` passes** — every real tenant in
   `tenants.json` is exercised automatically; add regression coverage for
   any new mapping/validation logic in the same change, not as a follow-up.
2. **`node config/cron-generator.js` was re-run** if `tenants.json` or any
   `workers/*/*.yaml` changed, and the regenerated `config/cron.yaml` is
   committed alongside.
3. **Docs updated in the same change**, not deferred: `README.md` for
   anything a new session needs to know to operate the repo,
   `docs/RUNTIME_ARCHITECTURE_NOTES.md` for real findings/incidents (this
   repo's established pattern — write down what actually happened, dated,
   with enough detail that a future session doesn't rediscover it from
   scratch), `docs/LLD.md` for structural/method-level changes to
   `schema-mapper.js` or the tenant/app config shape.
4. **New tenants and new capabilities ship paused** (`status: "paused"`,
   both `enabled` flags `false`) until a human makes an explicit go-live
   decision — this is a load-bearing convention (`dvsc`, and initially
   `classscout`, both shipped this way), not a suggestion.
5. **Commit messages describe the change and its reasoning** — no AI
   attribution, no session links (see AI-assistant branding below).

## Tenant-status changes: the one rule that actually matters

**A commit that changes any tenant's `status` or `enabled` fields in
`tenants.json` must say so explicitly for every tenant it touches — not
just the one the task was about.** On 2026-08-03, a commit scoped as
"narrow classscout to Manhattan/Brooklyn sport Classes/Camps" also paused
`cogmap` and `seyu` — two active, unrelated, revenue-relevant tenants — as
a bundled side effect citing an out-of-band instruction that wasn't
visible anywhere in this repo. It went unnoticed until a second session
happened to diff against it for an unrelated reason. Full writeup:
`docs/RUNTIME_ARCHITECTURE_NOTES.md` §9. Tracked follow-up on preventing a
repeat: issue #6.

Concretely: if your task only concerns tenant X, do not touch tenant Y's
`status`/`enabled` in the same commit unless the task explicitly says to,
and if it does, name Y specifically in the commit message — "pause X" is
not sufficient when the diff also touches Y.

## Multiple agent sessions, one `main`

More than one agent session (OpenClaw/KiloClaw, multiple Claude Code
sessions) may be working this repo concurrently, each pushing straight to
`main`/`preview`/`dev` with no PR gate between them. Before starting real
work: `git fetch origin main && git log --oneline <your-last-known-commit>..origin/main`
to see what landed since you last synced, and actually read those diffs —
don't assume your view of the repo is current. If you find a change you
didn't expect (especially one touching a tenant/scope you weren't asked to
touch), stop and flag it rather than silently building on top of it or
silently reverting it.

## Continuous delivery, with real checkpoints

Work through the real, tracked backlog (GitHub Issues on this repo, plus
`classscoutcards`/`classscout-kiloclaw-agent` where relevant) rather than
stalling on ambiguity you could resolve by reading the code. But "keep
moving" does not mean "keep pushing to production indefinitely without a
human checkpoint" — every meaningful push (a new tenant capability, a
schema-mapper change, a scope change) gets a clear summary of what
shipped and why, the same standard this file itself is written to. Do not
self-invent new issues to stay busy; work the real backlog, and file a
real, well-scoped issue (matching the structure of #6/#7/#8) when new
follow-up work is discovered as an outcome of what you were already doing.

No GitHub Projects (v2) board API is available in this session's
toolset — issues can be created/labeled via the API, but cannot be added
to a project board programmatically. State this plainly whenever asked
for one; hand off the "add to board" step to whoever has board access
rather than claiming it was done.

## AI-assistant branding — banned, same as the sibling repos

No `Co-Authored-By` trailers, session links, or model names in commits,
PR/issue bodies, or docs. Describe the change and its reasoning only. This
mirrors `classscout/CLAUDE.md` and `salesleadgenerator/CLAUDE.md` — keep
all three repos' conventions consistent where they overlap.

## Where things actually live

- Full architecture, method-level detail: `docs/LLD.md`
- Real findings/incidents, dated: `docs/RUNTIME_ARCHITECTURE_NOTES.md`
- Per-tenant status and how to onboard a new one: `README.md`'s "New Agent
  Onboarding" / "Per-Tenant Toggles" sections
- Regression tests: `scripts/verify-schema-mapper.js` (pure logic, no
  network) and `scripts/test-classscout-live.js` (live health/dry-run/live
  modes against the real classscout deployment)

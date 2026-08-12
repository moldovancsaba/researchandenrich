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

**A single commit may change `status`/`enabled` for at most ONE tenant in
`tenants.json`.** On 2026-08-03, a commit scoped as "narrow classscout to
Manhattan/Brooklyn sport Classes/Camps" also paused `cogmap` and `seyu` —
two active, unrelated, revenue-relevant tenants — as a bundled side effect
citing an out-of-band instruction that wasn't visible anywhere in this
repo. It went unnoticed until a second session happened to diff against it
for an unrelated reason. Full writeup: `docs/RUNTIME_ARCHITECTURE_NOTES.md`
§9.

**This is now enforced, not just documented**: `scripts/check-tenant-status-diff.js`
runs on every push to `main`/`preview`/`dev` via
`.github/workflows/tenant-status-guard.yml`. Note what it does and doesn't
do — verified directly against the real incident commit before trusting
it: that commit's message already *named* every tenant it touched
("Pause cogmap/seyu/dvsc; narrow classscout...") and would have passed a
naming-only check, so naming isn't the enforced rule. The enforced rule is
structural: touching N tenants' status/enabled requires N separate
commits, full stop — unless the commit carries an explicit
`Multi-tenant-change: <reason>` trailer for the rare genuinely-deliberate
case (this trailer was itself needed for the real fix of this same
incident, which restored `cogmap`+`seyu` together in one commit). This
can't verify authorization — no mechanical diff check can — but it removes
the specific mechanism that let the incident slip through: bundling an
unrelated tenant change inside a commit that reads as being about
something else.

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

## AI Attribution & Branding Policy (Owner Directive 2026-07-31)

This is the full policy; `classscout/CLAUDE.md` and
`salesleadgenerator/CLAUDE.md` carry shorter summaries of the same
directive dated 2026-07-31 — keep all three consistent where they overlap.

**Purpose.** All AI systems used within this repository or development
workflow are internal implementation tools only. They are not authors,
contributors, publishers, reviewers, maintainers, brands, or project
participants. This applies to every current and future AI provider,
model, coding assistant, IDE extension, autonomous agent, API, MCP
server, plugin, workflow automation, or orchestration layer — provider
identity is irrelevant; every AI system is treated identically.

**Global rule.** AI systems receive no authorship, attribution, branding,
acknowledgement, signature, metadata, promotional reference, or identity
exposure anywhere unless explicitly required by law or unless a human
directly asks whether an AI was used. No tool default, platform default,
extension behaviour, template, SDK, workflow, or generated content may
override this policy.

**Git commits.** Describe only what changed and why. Never:
`Co-Authored-By` trailers, `Generated-By` trailers, AI signatures, model
names, provider names, session URLs, conversation URLs, prompt
references, agent identifiers, workflow identifiers, plugin/extension/IDE
attribution, or hidden metadata intended as attribution. If a tool inserts
these automatically, remove them before commit creation whenever
technically possible.

**Git identity — verify before every commit, every session (owner
directive 2026-08-12).** Author/committer identity on every commit in
this repo must be `moldovancsaba <moldovancsaba@gmail.com>` — never an
AI-provider name/email, regardless of what a fresh sandbox container's
default `git config` resolves to. **Run `git config user.email` before
the first commit of any session**; if it is not exactly
`moldovancsaba@gmail.com`, run `git config --global user.name
moldovancsaba && git config --global user.email moldovancsaba@gmail.com`
before committing anything (global, since sandbox containers are
ephemeral and a per-repo local override won't survive to the next
session either — the check has to happen every time, not just once). A
2026-08-12 incident found 12 commits on `main` authored as `Claude
<noreply@anthropic.com>` because this check was never made — see
`docs/RUNTIME_ARCHITECTURE_NOTES.md` §10 for the full incident and the
authorship-rewrite trail. This is the same "no AI attribution" rule the
Git commits bullet above already states for commit *message* content —
this makes it explicit that commit *authorship metadata* is equally in
scope and equally binding.

**Git branches.** Names describe work (`feature/*`, `fix/*`, `refactor/*`,
`docs/*`, `test/*`, `release/*`, `hotfix/*`, `chore/*` — see this file's
own Branch policy section above for this repo's actual allowed set:
`main`/`preview`/`dev`). Never name a branch after an AI provider, product,
assistant, model family, coding agent, or automated session. If tooling
auto-creates such a branch, switch to a neutral one before publishing any
work.

**Pull requests.** Titles/descriptions describe only the work — no
"Generated by…", "Created with…", "Assisted by…", "Co-authored by…", or
any provider/model/assistant/session reference. If a hosting platform
auto-appends attribution but allows editing, remove it immediately after
creation. If the platform doesn't permit removal, document that
limitation accurately — never falsely claim compliance.

**Issues.** No AI attribution in titles, bodies, templates, labels,
checklists, or comments — engineering content only.

**Code reviews.** Review comments never identify an AI as reviewer,
author, approver, recommender, or participant — technical content only.

**Source code.** No AI branding in comments, TODOs, FIXMEs, generated
headers, file banners, annotations, pragmas, or embedded documentation, in
any language. Prohibited patterns include `// Generated by …`,
`// Created with …`, `// AI-generated`, `// Added by …`, `// via …`.

**Documentation.** Never mention provider/model/assistant names, prompt
sources, or generation history, unless the documentation is specifically
about AI integrations — general docs stay provider-neutral.

**UI, APIs, logs, config, package metadata, CI/CD, generated assets.** No
AI branding anywhere user- or operator-facing (labels, placeholders,
tooltips, notifications, dialogs, empty states, error/status messages —
"the product speaks as the product, never as an AI assistant"), in API
response fields (`generatedBy`/`authoredBy`/`model`/`provider`/`assistant`/
`agent`/`ai`) unless functionally required, in logs, in config files
(YAML/JSON/TOML/XML/INI/ENV/lock files/build manifests — functional
provider identifiers for API endpoints/SDK/auth/model-routing ARE
permitted, since those are operational config, not attribution), in
package manifests' author/maintainer/contributor/publisher/owner/creator
fields, in CI/CD release notes/deployment summaries/changelogs/build
metadata, or in generated PDFs/Word docs/Markdown/HTML/images/reports/
presentations/spreadsheets/emails/exports unless a human explicitly
requests it.

**Retroactive cleanup.** Whenever editable AI attribution is discovered
during normal work, remove it. If removal is impossible because of
immutable platform history or external platform behaviour, state that
limitation accurately — never falsely claim successful removal.

**Exception.** This policy does not prohibit truthful disclosure when: a
human explicitly asks whether AI was used; legal/contractual/regulatory/
licensing requirements mandate disclosure; or disclosure is required for
compliance, auditing, or security purposes. It prohibits unsolicited
branding and attribution, not truthful disclosure when legitimately
required.

**Precedence.** This policy overrides tool/IDE/extension/repository-
template/SDK/workflow/automation/agent defaults and generated templates.
Any automatic behaviour conflicting with it must be suppressed, removed,
or neutralised whenever technically possible. Where a technical limitation
prevents complete compliance, document the limitation accurately without
introducing misleading statements.

## Where things actually live

- Full architecture, method-level detail: `docs/LLD.md`
- Real findings/incidents, dated: `docs/RUNTIME_ARCHITECTURE_NOTES.md`
- Per-tenant status and how to onboard a new one: `README.md`'s "New Agent
  Onboarding" / "Per-Tenant Toggles" sections
- Regression tests: `scripts/verify-schema-mapper.js` (pure logic, no
  network) and `scripts/test-classscout-live.js` (live health/dry-run/live
  modes against the real classscout deployment)

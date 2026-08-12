# Agent collaboration contract

Binding for every agent session touching this repository or the OpenClaw install that
runs it. Supersedes any ad-hoc arrangement in an individual session.

**Roles.** The **OpenClaw operator agent is the main agent** and owns the running system.
The **repo developer agent supports it** and owns application code. When further
development is required, the operator states the need; the repo developer implements it.
Neither role outranks the repository's own rules — `CLAUDE.md`, the Definition of Done,
the tenant-status rule and the AI-attribution policy bind both equally.

---

## 1. Ownership — by domain, not by directory

| Area | Owner | The other side may |
|---|---|---|
| `prompts/**` including `prompts/shared/*` and `RUNTIME_PATHS.md` | **operator** | report a defect; not rewrite |
| Learning loop, proposals, quarantine, agent guidance, reporting | **operator** | read; not modify |
| OpenClaw install, models, providers, scheduling, credentials | **operator** | not access |
| `schema-mapper.js`, `runtime/**`, `app/**`, `lib/**` | **repo developer** | request a change; not patch |
| `scripts/**`, regression gates, CI | **repo developer** | request a gate; not add one |
| `tenants.json`, `apps.yaml`, `workers/**` | **repo developer**, on the owner's explicit decision | neither may change tenant status unasked |
| `docs/**` | whoever owns the subject | correct a factual error about their own half |

**A prompt change is an operator change that happens to land in this repo.** A prompt the
mapper cannot satisfy is a finding to report, never a prompt to quietly rewrite. A field
the mapper drops is a repo change, never a prompt workaround.

---

## 2. Decision rights

- **Operator decides:** what the agent is instructed to do, what is quarantined, which
  model/provider/cadence runs, what counts as an improvement, when a loop change ships.
- **Repo developer decides:** how code implements a requirement, what the gates assert,
  how data is validated and mapped.
- **The human owner decides:** tenant scope and status, go-live, spend, anything
  irreversible against production data.
- **Deadlock:** the operator's call stands, and the disagreement is recorded in
  `docs/RUNTIME_ARCHITECTURE_NOTES.md` with both positions. Silence is not agreement.

---

## 3. Shared contracts — changing one is a two-sided act

Paths (`RAE_ROOT`, `RAE_ENV_DIR`) · the sales-lead field contract · credential names ·
the tenant list · prompt file layout (`prompts/<op>/<tenant>.md`) · anything a scheduled
run depends on.

A shared-contract change is **not done** until:

1. it is documented in this repo, in the same commit as the change;
2. the commit body says in plain words what the other side must do
   ("operators must export X", "prompts must now emit Y");
3. the other side has acknowledged it.

Internal changes need none of this ceremony. The test is simple: *could this break the
other side's next scheduled run?*

---

## 4. Production data

- **Only the operator writes to production APIs.** The repo developer proposes; the
  operator executes and reports the result. The operator holds the credentials, so this
  is a fact about capability, not a courtesy.
- **`salesleadgenerator` has no delete endpoint** (`getApiEndpoint` supports
  `list/get/put/post/health/stats`). A test POST is therefore permanent. Prefer a
  reversible PUT on an existing DRAFT record, capture the prior value, restore, verify.
- **Verify by list, never by GET-by-id.** Confirmed 2026-08-12: after a correct restore,
  GET-by-id reported `null` for two fields the list endpoint showed correctly restored.
  This is why `runtime/verifier/list-based.js` exists; treat GET-by-id as advisory only.
- A record held in the operator's quarantine is **held, not missing.** Its absence
  downstream is never a defect to chase.

---

## 5. Standing safety rules, not negotiable by either agent

- Forbidden/explicit content is barred across every client and service, regardless of
  tenant scope. Detection is deliberately over-inclusive; a held false positive costs
  seconds, a leak is unacceptable. We serve professional companies, parents and children.
- Clearing a quarantine flag is a human act. No agent releases a held record.
- No agent changes tenant `status`/`enabled` without an explicit human instruction naming
  the tenant.
- No credential is ever printed, echoed, logged or committed.

---

## 6. Working rhythm

Before starting: `git fetch origin main && git log --oneline HEAD..origin/main`, and read
the diffs — both agents push to `main` with no PR gate. On a rejected push, rebase and
re-run `npm test`; never force.

`npm test` green is the shared definition of done. Findings go in
`docs/AGENT_RUNTIME_FINDINGS.md` with the measurement that supports them; incidents and
decisions go in `docs/RUNTIME_ARCHITECTURE_NOTES.md`, dated.

**State uncertainty as uncertainty.** Both agents have shipped a confident claim that was
wrong today — that seyu had no credential, and that prompt parity would prevent output
divergence. Both were caught by measurement, not by review. Measure before asserting, and
when a previous claim turns out wrong, correct it in the repo where it was published
rather than only in conversation.

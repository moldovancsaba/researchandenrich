# OpenClaw operator ↔ repo developer handover

Two sides touch this system and neither can see the other's half:

- **This repository** — prompts, schema-mapper, tenant config. Owned by the repo developer.
- **An OpenClaw install that runs those prompts** — credentials, scheduling, agent guidance,
  quarantine, reporting. Lives outside this repo entirely.

On 2026-08-12 both sides changed the same contract on the same day without knowing it. This
document records what changed on the operator side and how the two should stay in sync.

---

## 1. The near-miss that motivated this doc

The repo moved prompt paths from `$HOME/.openclaw/workspace/...` to `$RAE_ROOT`
(`prompts/RUNTIME_PATHS.md`, commit `56a5785`). That is a strictly better contract — the old
one only resolved inside one operator's layout.

The operator side had, hours earlier, built its integration **around the old hardcoded path**:
a symlink at `~/.openclaw/workspace` pointing into the OpenClaw state dir, with the repo
exposed as `Agents/contentcreator`. Neither side was wrong; they were edited independently and
would have failed at the next scheduled run with a missing-file error that pointed at neither
cause.

It was caught only because the operator happened to read the git log before writing this doc.

---

## 2. Operator-side state as of 2026-08-12

Nothing below lives in this repository. It is recorded here because it determines whether the
prompts in this repo can actually run.

### Path contract — adopted

```
RAE_ROOT     = /Users/Shared/Projects/researchandenrich
RAE_ENV_DIR  = /Users/Shared/Projects/OpenClaw/.openclaw/workspace
```

Set machine-wide via `launchctl setenv` and persisted in a LaunchAgent, because the OpenClaw
gateway runs under `launchd` and never sees a shell profile. `RAE_ENV_DIR` is set separately
because the tenant env files deliberately do **not** live inside the repo clone.

### Credentials

| tenant | variable(s) | source |
|---|---|---|
| cogmap, dvsc | `SLG_API_KEY` | operator's env file |
| seyu | `SLG_API_KEY` + `SEYU_API_KEY` (same value) | one shared salesleadgenerator key |
| classscout | `INGEST_API_KEY`, `IMGBB_API_KEY` | pulled from the classscout Vercel project |

All at mode `600`, gitignored, never echoed. **seyu is not a separate credential** — an earlier
revision of `AGENT_RUNTIME_FINDINGS.md` claimed it was unprovisionable; corrected in `9e3ef35`.

### What the operator enforces that this repo does not

- **Content quarantine.** Any record whose url or name matches a forbidden-content term is held
  in `quarantine.json` and skipped for enrichment and publishing. Deliberately over-inclusive:
  legitimate records like "Adult & Me" swim classes are held. A held record is never
  auto-released; clearing is a human act. This is a policy decision on the operator side —
  this repo has no equivalent gate, so **a record that looks fine here may still be held**.
- **A learning loop.** Hourly: report → outcome diff → improvement proposals. Some proposals
  are applied automatically to the agent's own guidance; anything scoped to this repo is left
  for a human and never auto-applied.
- **Hourly reporting** of discovered/enriched/published counts per app per client.

---

## 3. Where the two sides can silently break each other

| Change here | Breaks operator side unless |
|---|---|
| Renaming/moving a prompt file | The runner references it by tenant + operation, so keep the `prompts/<op>/<tenant>.md` shape |
| Changing the path contract in `RUNTIME_PATHS.md` | `RAE_ROOT`/`RAE_ENV_DIR` are re-exported and the gateway restarted |
| Adding a required env var to a prompt | The operator creates it — the repo cannot, credentials are not stored here |
| Adding a tenant | The operator provisions a key and adds it to reporting/learning lists |
| Changing the field contract | Cross-tenant comparisons on the operator side silently change meaning |

| Change on the operator side | Breaks this repo's assumptions unless |
|---|---|
| Moving the env directory | `RAE_ENV_DIR` is updated |
| Quarantining records | Understood as intentional — the record is not "missing", it is held |
| Changing agent model/limits | Runs may exceed `workers/*/timeoutMs`; a full pass is measured at ~16s/card |

---

## 4. How to update each other

**Both sides, before starting work:**

```bash
cd $RAE_ROOT && git fetch origin main && git log --oneline HEAD..origin/main
```

Read the diffs. `CLAUDE.md` already requires this for concurrent sessions; it applies equally
to the operator, who is another concurrent writer.

**Repo developer → operator.** If a change affects any row in section 3, say so in the commit
message body in plain words ("operators must export X", "prompts now require Y"). The operator
reads commit messages, not diffs, when deciding whether a scheduled run needs attention.

**Operator → repo developer.** Anything the operator learns that is a fact about *this repo* —
a prompt that cannot be followed, a field never populated, a path that does not resolve —
belongs in `docs/AGENT_RUNTIME_FINDINGS.md` with the measurement that supports it, committed
here. Anything that is a fact about the operator's own machine stays on the operator's machine.

**Both:** when a run-affecting change lands, restart the gateway. Config changes hot-reload;
environment variables do not.

**The rule that would have caught the near-miss:** a change to a *shared contract* — paths,
field shape, credentials, tenant list — is never done until it is documented in this repo and
the other side has acknowledged it. A change to one side's internals needs no ceremony.

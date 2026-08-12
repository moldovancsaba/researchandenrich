# Agent runtime findings — running this repo under OpenClaw

Dated 2026-08-12. Measured on a real OpenClaw install (v2026.7.1-2, Apple M4, 16 GB,
macOS 26.5.1) driving the prompts in this repo. `rae_handover.md` describes what this repo
*is*; this document records what actually happened when an agent tried to run it, including
what failed. Everything below is observed, not predicted.

## Credential reality (corrects assumptions in the prompts)

| Tenant | Credential | Where it actually is |
|---|---|---|
| `classscout` | `INGEST_API_KEY`, `IMGBB_API_KEY` | Vercel project `classscout`, production env — pullable |
| `cogmap` | `SLG_API_KEY` | repo `.env.cogmap` only |
| `dvsc` | `SLG_API_KEY` | same key as cogmap |
| `seyu` | `SLG_API_KEY` | the **same shared key** as cogmap/dvsc — there is no separate seyu credential |

**The `salesleadgenerator` Vercel project holds zero environment variables** — production,
preview and development are all empty; only Vercel's own `VERCEL_*`/`TURBO_*` system vars
come back from `vercel env pull`. Whatever authenticates the live `x-api-key` requests is
not stored there.

**Correction (2026-08-12, same day):** an earlier revision of this document concluded that
`seyu` "cannot be provisioned" because no `SEYU_API_KEY` existed anywhere. That was wrong.
seyu is the same salesleadgenerator client as cogmap and dvsc and authenticates with the
same `SLG_API_KEY`. The prompts read `SLG_API_KEY` directly (8e34d7b); an earlier arrangement had them read `SEYU_API_KEY`, which only worked where the key had been duplicated under that name and 401'd in any environment provisioned from README. Verified by
calling `GET /api/leads?brand=seyu` with the shared key: HTTP 200, 681 records. The lesson
worth keeping is that "no separate credential exists" was evidence about the credential
store, not about the tenant — and the two were conflated. Tenant isolation here is enforced
by the `brand=` parameter and the Fixed-Tenant Contract, not by separate keys.

The project is reachable by name (`vercel link --yes --project salesleadgenerator`) even
though it does not appear in `vercel project ls` output. "Not listed" does not mean "no access".

## Auth differs per tenant — a 401 usually means the wrong header

- `classscout`: `Authorization: Bearer $INGEST_API_KEY` against `https://classscout.ai`.
  Verified working: `scripts/test-classscout-live.js --mode=health` → HTTP 200,
  *"INGEST_API_KEY is accepted"*. That script is the fastest 401-vs-503 diagnostic; use it
  before assuming a key is bad.
- sales-lead-api tenants: `x-api-key: $SLG_API_KEY`, routed with `brand=<tenantId>`.

Values pulled from Vercel arrive **quoted**. `source` strips the quotes; extracting with
`grep | cut` does not, and sending the quoted string produces a misleading 401.

## Model requirements — the discovery prompts are the hard part

The discovery prompts are 12–17 KB (≈4,700 tokens for classscout) and require multi-step
tool use: search-router calls, page fetches, schema-correct assembly, then a verified POST.
Observed behaviour by model class:

| Model | Result |
|---|---|
| `qwen2.5:7b` (local) | **Invented a `bin/discover-cogmap` executable** that does not exist, rather than doing the work |
| `qwen3:1.7b` (local) | Tool calls fine; misreads task intent |
| `ministral-8b` (Mistral) | Executes a named command correctly; fails vaguer multi-step asks |
| `mistral-small` | Handled recursive file tasks correctly |
| `nemotron-3-ultra-550b` (free) | 10+ successful tool calls, then agent-level timeout |

**No model has yet completed a full discovery run end to end.** Best attempts ended at 259s
and 394s. `workers/*/discovery.yaml` sets `timeoutMs: 300000`; a real run needs more than
that, or the prompt needs splitting into smaller checkpointed steps.

**The failure mode to design against is invention, not refusal.** A model that fabricates a
command is one step away from fabricating a company record and POSTing it. Any tenant run
must be inspected before it is scheduled — enrichment writes into a live customer-facing
catalog.

## Free-tier rate limits decide feasibility, not model quality

Per-model, from live response headers:

| Provider / model | req/min | tokens/min |
|---|---|---|
| Mistral `mistral-large-latest` | **4** | 250,000 |
| Mistral `mistral-small-latest` | 50 | 50,000 |
| Mistral `ministral-8b-latest` | 188 | 625,000 |
| Mistral `ministral-3b-latest` | 750 | 1,300,000 |
| OpenRouter free tier (any model) | — | **50 requests/DAY** |

The largest model has the smallest quota: an agent loop makes 6+ calls in under a minute and
`mistral-large` dies with `API rate limit reached`. **OpenRouter's free tier cannot sustain
this repo's cron** (every 45 min × 4 tenants × 2 operations ≈ 192 runs/day, each many calls).
Check any provider before committing to it:

```bash
curl -s -D - -o /dev/null -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  <provider-endpoint> | grep -i ratelimit
```

## Prompt-path assumption

The prompts hardcode `$HOME/.openclaw/workspace/...` for both the tenant env files and the
search router. An OpenClaw install whose state directory lives elsewhere must keep that path
resolving (a symlink is sufficient). Link `prompts/`, `search-router/` and `tenants.json`
individually rather than the whole repo — linking the repo root exposes `node_modules/` and
`.next/` to workspace scanning and blows the agent's context budget.

## Status of the four tenants when this was written

`tenants.json` remains the live truth. At time of writing `dvsc` ships `paused` by
convention. `seyu` is `active` and, contrary to this document's first revision, fully
provisionable with the shared key — so an operator running "the enabled tenants" today can
run `cogmap`, `seyu` and `classscout`.

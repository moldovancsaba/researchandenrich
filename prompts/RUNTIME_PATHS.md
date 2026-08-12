# Runtime paths — how to locate this repo's files from a prompt

Every prompt under `prompts/` needs two things from the filesystem: a tenant's
env file, and the search router. Both used to be written as absolute paths into
one operator's OpenClaw workspace:

```
$HOME/.openclaw/workspace/.env.cogmap
$HOME/.openclaw/workspace/Agents/contentcreator/search-router/seyu-search-router/AgentFinder
```

That only worked inside that one layout, under a directory named
`contentcreator` — which is not this repository's name. A clone anywhere else
(CI, a second machine, a different agent runtime, a container) could not resolve
either path, and the failure looked like a missing file rather than a wrong
assumption.

Prompts now reference `$RAE_ROOT`. This file is the contract for resolving it.

---

## Resolving `$RAE_ROOT`

`RAE_ROOT` is the absolute path to the root of this repository — the directory
containing `tenants.json`, `apps.yaml` and `schema-mapper.js`.

**If you already know where the repo is**, export it and stop reading:

```bash
export RAE_ROOT=/path/to/researchandenrich
```

**If you do not know where it is**, resolve it in this order. The first one that
produces a directory containing `tenants.json` wins.

```bash
resolve_rae_root() {
  # 1. Explicit configuration always wins.
  if [ -n "${RAE_ROOT:-}" ] && [ -f "$RAE_ROOT/tenants.json" ]; then
    echo "$RAE_ROOT"; return 0
  fi

  # 2. You are already somewhere inside a clone.
  local top
  if top="$(git rev-parse --show-toplevel 2>/dev/null)" \
     && [ -f "$top/tenants.json" ]; then
    echo "$top"; return 0
  fi

  # 3. Legacy OpenClaw workspace layout. Kept so an unchanged OpenClaw
  #    deployment keeps working without being reconfigured.
  local legacy="$HOME/.openclaw/workspace/Agents/contentcreator"
  if [ -f "$legacy/tenants.json" ]; then
    echo "$legacy"; return 0
  fi

  # 4. Last resort: search the usual places, shallowly, so this never becomes a
  #    whole-disk scan.
  local hit
  hit="$(find "$HOME" /Users/Shared/Projects /opt /srv -maxdepth 4 \
         -name tenants.json -path '*researchandenrich*' 2>/dev/null | head -1)"
  if [ -n "$hit" ]; then
    dirname "$hit"; return 0
  fi

  echo "Could not locate the researchandenrich repository." >&2
  echo "Set RAE_ROOT to its absolute path and retry." >&2
  return 1
}

export RAE_ROOT="$(resolve_rae_root)" || exit 1
```

If none of those find it, the repository is not on this machine. Clone it:

```bash
git clone https://github.com/moldovancsaba/researchandenrich
```

---

## The two paths every prompt uses

### 1. Tenant credentials

```bash
source "${RAE_ENV_DIR:-$RAE_ROOT}/.env.<tenantId>"

> **Env files normally live OUTSIDE the clone.** Credentials are not repo content, and
> a clone is disposable. `$RAE_ROOT` is only the fallback for the case where an operator
> deliberately co-locates them. Set `RAE_ENV_DIR` explicitly in any real deployment.
```

Env files are **gitignored** and operator-supplied — a clone will not contain
working ones. `RAE_ENV_DIR` exists for deployments that keep credentials outside
the repository (a mounted secrets volume, for instance); it defaults to the repo
root, which is where `README.md` documents them.

If the file is missing, that is a **provisioning** problem, not a path problem.
Do not invent values and do not proceed with a partially-configured tenant —
see `README.md`'s "New Agent Onboarding" step 4.

### 2. Search router

```bash
"$RAE_ROOT/search-router/bin/run-router-search.sh"
```

This launcher resolves the router relative to its own location and fails with an
actionable message if dependencies are missing. `AgentFinder`, in
`search-router/seyu-search-router/`, is an equivalent entry point and is also
self-locating; either works, and both speak stdio MCP.

The router's `node_modules` is gitignored. On a fresh clone:

```bash
npm --prefix "$RAE_ROOT/search-router/seyu-search-router" ci
```

---

## For whoever changes this next

- **Do not reintroduce an absolute path** into a prompt file. If you need a new
  location, add it to the resolution above and reference it through a variable.
- **Keep step 3 (the legacy OpenClaw path).** It is the only reason an existing
  OpenClaw deployment keeps working without being reconfigured. Remove it only
  once you have confirmed no deployment relies on that layout — and note that
  the directory is named `contentcreator`, which is the Vercel project name, not
  this repo's name.
- The repository is designed to run standalone: `npm ci && npm test` passes with
  no other repository present. `salesleadgenerator` and `classscout` are HTTP
  targets, not dependencies, and their schemas are mirrored here rather than
  imported. Keep it that way.

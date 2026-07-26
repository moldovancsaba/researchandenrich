# ContentCreator Agent Runtime

Agent runtime for ContentCreator — unified lead and program research service. Serves two equal tenants (cogmap, seyu) via a round-robin batch scheduler.

## Repo Layout

```
├── agents/contentcreator/       <- agent runtime code (this repo)
│   ├── prompts/                 <- prompt files (discovery/enrichment)
│   │   ├── discovery/
│   │   └── enrichment/
│   ├── tenants.json             <- tenant configs (incl. per-operation enabled flags)
│   ├── schema-mapper.js         <- schema mapping + cross-tenant guards
│   ├── runtime/                 <- shared runtime (cache, HTTP client, retry)
│   ├── workers/*/               <- per-tenant worker YAML configs
│   ├── config/
│   │   ├── cron-generator.js    <- generates cron.yaml from tenants.json + workers
│   │   └── cron.yaml            <- generated cron schedule
│   └── prompt-editor/           <- prompt management API (added later)
│       └── api/
│           └── prompts/
│               └── route.ts     <- GET/PUT prompts with MongoDB + disk fallback
```

## Prompt Editor

The prompt editor API is available at `/api/prompts` (see `prompt-editor/api/prompts/route.ts`).
It reads/writes prompts via the API defined here. The researchandenrich repo provides
the runtime-level prompt storage and retrieval.

## Per-Tenant Toggles

Each tenant in `tenants.json` has per-operation `enabled` flags:

```json
{
  "tenants": {
    "cogmap": {
      "discovery": { "enabled": true, ... },
      "enrichment": { "enabled": true, ... }
    }
  }
}
```

The cron-generator reads these flags to include/exclude operations in the cron schedule.

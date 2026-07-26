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
│   ├── runtime/                  <- shared runtime (cache, HTTP client, retry)
│   ├── workers/*/                <- per-tenant worker YAML configs
│   ├── config/
│   │   ├── cron-generator.js    <- generates cron.yaml from tenants.json + workers
│   │   └── cron.yaml            <- generated cron schedule
│   ├── apps.yaml                <- app definitions
│   ├── config/apps/             <- per-app config (researchandenrich.yaml)
│   ├── package.json             <- Vercel override (build script bypass)
│   ├── vercel.json              <- static framework config
│   └── .env.cogmap / .env.seyu <- protected credentials (600 permissions)
```

## Per-Tenant Toggles

Each tenant in `tenants.json` has per-operation `enabled` flags:

```json
{
  "tenants": {
    "cogmap": {
      "discovery": { "enabled": true },
      "enrichment": { "enabled": true }
    },
    "seyu": {
      "discovery": { "enabled": true },
      "enrichment": { "enabled": true }
    }
  }
}
```

The cron-generator reads these flags to include/exclude operations in the cron schedule.

## Deployment Note

This repo is deployed on Vercel as a static project. `vercel.json` forces `framework: static` and `package.json` overrides the build command to prevent Vercel from auto-detecting Next.js (this repo has no Next.js app directory).

## Prohibited

- Do not work on the salesleadgenerator webapp (separate repo, out of scope)
- No cross-tenant field writes
- All prompt content + runtime config lives in this repo only

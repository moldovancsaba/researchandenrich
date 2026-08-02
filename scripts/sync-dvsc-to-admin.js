#!/usr/bin/env node
/**
 * Sync the dvsc app/tenant into the Mongo-backed admin API.
 *
 * WHY THIS EXISTS: this repo has two unsynced config sources -- static files
 * (tenants.json / apps.yaml / workers/*), which the cron-generator and
 * schema-mapper read directly off disk, and a MongoDB-backed admin API
 * (contentcreator_apps / contentcreator_tenants collections via
 * /api/admin/{apps,tenants}) that drives the /admin dashboard. Nothing in
 * this repo currently syncs the two. Adding dvsc to tenants.json/apps.yaml
 * (done in this same change) does NOT make it appear in /admin -- this
 * script is what does that, by calling the admin API the same way the
 * dashboard itself would.
 *
 * DISCLOSURE: this script has NOT been run against the live deployment.
 * There is no ADMIN_API_KEY / MONGODB_URI available in the sandbox this
 * was written in, so it could not be executed or verified end-to-end.
 * This repo's own README/config also do not state researchandenrich's own
 * deployed URL anywhere, so --api-base has deliberately been left with NO
 * default -- guessing one would be exactly the kind of unverified claim
 * this repo's operating rules forbid. Whoever runs this must supply the
 * real deployed admin URL explicitly. The script is idempotent (GETs
 * before POSTing) and mirrors the exact payload shape read from
 * app/api/admin/apps/route.ts and app/api/admin/tenants/route.ts, but it
 * has only been reviewed by inspection, not exercised against a real
 * database. Run it once, read the output, and confirm the /admin
 * dashboard reflects dvsc before relying on it.
 *
 * Usage:
 *   ADMIN_API_KEY=... node scripts/sync-dvsc-to-admin.js --api-base https://<real-admin-deployment>
 *   (or set ADMIN_API_BASE instead of --api-base)
 */

const API_BASE = (() => {
  const idx = process.argv.indexOf('--api-base');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.ADMIN_API_BASE || '';
})();

const API_KEY = process.env.ADMIN_API_KEY;

if (!API_KEY) {
  console.error('ADMIN_API_KEY env var is required (the same key requireApiKey() in lib/api-auth.ts checks for).');
  process.exit(1);
}

if (!API_BASE) {
  console.error('--api-base (or ADMIN_API_BASE env var) is required. This repo does not document its own deployed URL, so it cannot be defaulted -- pass the real one explicitly.');
  process.exit(1);
}

const APP_PAYLOAD = {
  appId: 'researchandenrich',
  displayName: 'ResearchEnrich',
  description: 'Business and program research across sports, entertainment, media, and tech',
  apiBase: 'https://salesleadgenerator.vercel.app',
  verifier: 'runtime/verifier/list-based.js',
  schemaMapper: 'schema-mapper.js',
  searchEngines: ['seyu-search-router'],
  qualityPipeline: ['DRAFT', 'CHECKED', 'VERIFIED'],
  maxResultsPerRun: 5,
};

const TENANT_PAYLOAD = {
  tenantId: 'dvsc',
  appId: 'researchandenrich',
  displayName: 'DVSC',
  description: 'Debreceni Vasutas Sport Club -- Hungarian football/handball club, sponsorship sales',
  status: 'paused',
  apiBase: 'https://salesleadgenerator.vercel.app',
  board: 'dvsc',
  brandFields: { pro: 'pro_for_organization', con: 'con_for_organization', valueProp: '' },
  forbiddenFields: [],
  iceScoring: true,
  discovery: { prompt: 'prompts/discovery/dvsc.md', schedule: { kind: 'every', everyMs: 2700000 } },
  enrichment: { prompt: 'prompts/enrichment/dvsc.md', schedule: { kind: 'every', everyMs: 2700000 } },
  sortOrder: 2,
};

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ensureApp() {
  const { status, body } = await request('/api/admin/apps');
  if (status !== 200) {
    throw new Error(`GET /api/admin/apps failed: ${status} ${JSON.stringify(body)}`);
  }
  const exists = (body.apps || []).some((a) => a.appId === 'researchandenrich');
  if (exists) {
    console.log('app "researchandenrich" already exists in the admin API -- not creating.');
    return;
  }
  const created = await request('/api/admin/apps', {
    method: 'POST',
    body: JSON.stringify(APP_PAYLOAD),
  });
  console.log('POST /api/admin/apps ->', created.status, JSON.stringify(created.body));
}

async function ensureTenant() {
  const { status, body } = await request('/api/admin/tenants');
  if (status !== 200) {
    throw new Error(`GET /api/admin/tenants failed: ${status} ${JSON.stringify(body)}`);
  }
  const exists = (body.tenants || []).some((t) => t.tenantId === 'dvsc');
  if (exists) {
    console.log('tenant "dvsc" already exists in the admin API -- not creating.');
    return;
  }
  const created = await request('/api/admin/tenants', {
    method: 'POST',
    body: JSON.stringify(TENANT_PAYLOAD),
  });
  console.log('POST /api/admin/tenants ->', created.status, JSON.stringify(created.body));
}

async function main() {
  await ensureApp();
  await ensureTenant();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

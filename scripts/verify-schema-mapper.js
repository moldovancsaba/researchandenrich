#!/usr/bin/env node
/**
 * Standalone regression check for schema-mapper.js's dynamic tenant
 * dispatch. No test framework is configured in this repo (package.json has
 * no "test" script) -- this is a plain, dependency-free Node script run
 * directly: `node scripts/verify-schema-mapper.js`. Exits non-zero on any
 * failure so it's safe to wire into CI later if this repo ever adds one.
 *
 * Exists specifically to catch the bug class this file was rewritten to
 * fix: a new/existing tenant silently falling through hardcoded
 * `case 'cogmap': case 'seyu':`-style switches (the real, live bug that
 * broke DVSC's POST path -- `getApiEndpoint('dvsc', 'post')` used to throw
 * "No endpoint mapping for tenant: dvsc"). Every real tenant in
 * tenants.json is exercised, plus a synthetic tenant NOT present in
 * tenants.json to prove a same-family tenant needs zero code changes here.
 */

const assert = require('assert');
const SchemaMapper = require('../schema-mapper');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`FAIL  ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const mapper = new SchemaMapper();
const realTenants = Object.keys(mapper.tenants).filter(
  (id) => mapper.tenants[id].schemaFamily === 'sales-lead-api'
);

console.log(`Real sales-lead-api tenants found in tenants.json: ${realTenants.join(', ')}`);
assert.ok(realTenants.length >= 3, 'expected at least cogmap/seyu/dvsc to be present');

// getApiEndpoint must work identically, with no per-tenant special-casing,
// for every real tenant -- including brand/tenantId on EVERY action, not
// just 'list' (the exact gap that made non-cogmap POST/GET/PUT silently
// default to cogmap's own collection).
for (const tenantId of realTenants) {
  check(`getApiEndpoint('${tenantId}', 'list') includes ?brand=${tenantId}`, () => {
    const url = mapper.getApiEndpoint(tenantId, 'list');
    assert.ok(url.includes(`brand=${tenantId}`), url);
  });
  check(`getApiEndpoint('${tenantId}', 'post') includes ?brand=${tenantId}`, () => {
    const url = mapper.getApiEndpoint(tenantId, 'post');
    assert.ok(url.includes(`brand=${tenantId}`), url);
  });
  check(`getApiEndpoint('${tenantId}', 'get', 'abc123') includes ?brand=${tenantId} and the id`, () => {
    const url = mapper.getApiEndpoint(tenantId, 'get', 'abc123');
    assert.ok(url.includes('/abc123') && url.includes(`brand=${tenantId}`), url);
  });
  check(`getApiEndpoint('${tenantId}', 'put', 'abc123') includes ?brand=${tenantId} and the id`, () => {
    const url = mapper.getApiEndpoint(tenantId, 'put', 'abc123');
    assert.ok(url.includes('/abc123') && url.includes(`brand=${tenantId}`), url);
  });
}

// mapToApiPayload + validateForTenant, driven purely by forecastModel, not
// tenant identity.
for (const tenantId of realTenants) {
  const tenant = mapper.tenants[tenantId];
  check(`mapToApiPayload('${tenantId}') lowercases contact emails`, () => {
    const payload = mapper.mapToApiPayload(tenantId, {
      contacts: [{ name: 'Jane Doe', email: 'JANE@EXAMPLE.COM' }],
    });
    assert.strictEqual(payload.contacts[0].email, 'jane@example.com');
  });

  if (tenant.forecastModel === 'deal-size-band') {
    check(`mapToApiPayload('${tenantId}') normalizes an out-of-vocab recommended_tier to 'essential'`, () => {
      const payload = mapper.mapToApiPayload(tenantId, { recommended_tier: 'not-a-real-tier' });
      assert.strictEqual(payload.recommended_tier, 'essential');
    });
  }
  if (tenant.forecastModel === 'pricing-by-company') {
    check(`mapToApiPayload('${tenantId}') normalizes pricingByCompany currency to uppercase`, () => {
      const payload = mapper.mapToApiPayload(tenantId, {
        pricingByCompany: { 'Acme Inc': { currency: 'eur', pricing_model: 'custom' } },
      });
      assert.strictEqual(payload.pricingByCompany['Acme Inc'].currency, 'EUR');
    });
  }

  check(`validateForTenant('${tenantId}') accepts a minimal valid payload`, () => {
    const result = mapper.validateForTenant(tenantId, { contacts: [] });
    assert.deepStrictEqual(result.errors, []);
  });
}

// The real regression case: a synthetic tenant NOT in tenants.json,
// sharing the sales-lead-api family, proving no tenant-ID-specific code
// exists anywhere in this file -- adding a same-family tenant to
// tenants.json alone is genuinely sufficient.
check("a synthetic 'newbrand' tenant (not in tenants.json) works identically with zero code changes", () => {
  const synthetic = new SchemaMapper();
  synthetic.tenants.newbrand = {
    app: 'researchandenrich',
    apiBase: 'https://salesleadgenerator.vercel.app',
    forbiddenFields: [],
    schemaFamily: 'sales-lead-api',
    forecastModel: 'deal-size-band',
  };
  const url = synthetic.getApiEndpoint('newbrand', 'post');
  assert.strictEqual(url, 'https://salesleadgenerator.vercel.app/api/leads?brand=newbrand');
  const payload = synthetic.mapToApiPayload('newbrand', { recommended_tier: 'ELITE' });
  assert.strictEqual(payload.recommended_tier, 'elite');
});

// A tenant with an unrecognized/missing schemaFamily must fail loudly, not
// silently fall through to some default behavior.
check('a tenant with no schemaFamily throws rather than silently defaulting', () => {
  const broken = new SchemaMapper();
  broken.tenants.broken = { app: 'researchandenrich', apiBase: 'https://example.com', forbiddenFields: [] };
  assert.throws(() => broken.getApiEndpoint('broken', 'post'), /schemaFamily/);
  assert.throws(() => broken.mapToApiPayload('broken', {}), /schemaFamily/);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

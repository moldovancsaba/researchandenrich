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

// --- program-api (classscout) ---
// Targets classscout's real `POST /api/ingest` batch-operations contract,
// not the sales-lead-api shape above. See schema-mapper.js's `_mapClassScout`
// docblock for why the field vocabulary differs (category = program format,
// not subject; ageRanges is a closed en-dash-bucket enum; image/website are
// hard-required).
check("getApiEndpoint('classscout', 'post'|'put'|'health') all resolve to the single /api/ingest endpoint", () => {
  const url = mapper.getApiEndpoint('classscout', 'post');
  assert.strictEqual(url, 'https://classscout.ai/api/ingest');
  assert.strictEqual(mapper.getApiEndpoint('classscout', 'put'), url);
  assert.strictEqual(mapper.getApiEndpoint('classscout', 'health'), url);
});

check("getApiEndpoint('classscout', 'list'|'get') throw -- no ingest-credential-readable route exists", () => {
  assert.throws(() => mapper.getApiEndpoint('classscout', 'list'), /no ingest-credential-readable/);
  assert.throws(() => mapper.getApiEndpoint('classscout', 'get'), /no ingest-credential-readable/);
});

const sampleProvider = {
  id: 'prov-brooklyn-art-studio-a1b2c3',
  name: 'Brooklyn Art Studio for Kids',
  category: 'Classes',
  borough: 'Brooklyn',
  neighborhood: 'Park Slope',
  address: '123 7th Ave, Brooklyn, NY 11215',
  activityTypes: ['Art', 'Painting'],
  ageRanges: ['3–5', '6–8'],
  dayTimeTags: ['Weekday', 'Afternoon'],
  pricePerClass: 35,
  shortDescription: 'Weekly art classes for young kids in Park Slope.',
  longDescription: 'Brooklyn Art Studio for Kids offers weekly painting and drawing classes for children ages 3-8 in a bright, welcoming Park Slope studio, taught by working artists.',
  image: 'https://i.ibb.co/abc123/brooklyn-art-studio.jpg',
  website: 'https://brooklynartstudioforkids.example.com',
  email: 'HELLO@BrooklynArtStudioForKids.example.com',
  phone: '+1 718 555 0100',
  contactLinks: [{ type: 'email', label: 'General', value: 'HELLO@BrooklynArtStudioForKids.example.com' }],
  sourceUrls: ['https://brooklynartstudioforkids.example.com/about'],
};

check("mapToApiPayload('classscout', record, 'post') wraps a providers.upsertMany operation and lowercases emails", () => {
  const payload = mapper.mapToApiPayload('classscout', sampleProvider, 'post');
  assert.strictEqual(payload.operations.length, 1);
  const op = payload.operations[0];
  assert.strictEqual(op.resource, 'providers');
  assert.strictEqual(op.action, 'upsertMany');
  assert.strictEqual(op.documents[0].email, 'hello@brooklynartstudioforkids.example.com');
  assert.strictEqual(op.documents[0].contactLinks[0].value, 'hello@brooklynartstudioforkids.example.com');
  assert.strictEqual(op.documents[0].rating, 0, 'editorial fields must never be invented by discovery');
  assert.strictEqual(op.documents[0].reviewCount, 0);
  assert.deepStrictEqual(op.documents[0].badges, []);
});

check("mapToApiPayload('classscout', {...}, 'put') wraps a provider.patch operation with only-changed fields", () => {
  const payload = mapper.mapToApiPayload('classscout', { id: 'prov-brooklyn-art-studio-a1b2c3', phone: '+1 718 555 0199' }, 'put');
  assert.strictEqual(payload.operations.length, 1);
  const op = payload.operations[0];
  assert.strictEqual(op.resource, 'provider');
  assert.strictEqual(op.action, 'patch');
  assert.strictEqual(op.id, 'prov-brooklyn-art-studio-a1b2c3');
  assert.deepStrictEqual(op.patch, { phone: '+1 718 555 0199' });
});

check("validateForTenant('classscout') accepts a valid mapped create payload", () => {
  const payload = mapper.mapToApiPayload('classscout', sampleProvider, 'post');
  const result = mapper.validateForTenant('classscout', payload);
  assert.deepStrictEqual(result.errors, []);
});

check("validateForTenant('classscout') rejects a missing image (the hard-required-field mistake an agent is likely to make)", () => {
  const noImage = { ...sampleProvider, image: '' };
  const payload = mapper.mapToApiPayload('classscout', noImage, 'post');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('image')), result.errors.join('; '));
});

check("validateForTenant('classscout') rejects a subject-taxonomy value used as category (the sports/arts/etc. mistake every prior attempt made)", () => {
  const wrongCategory = { ...sampleProvider, category: 'Sports' };
  const payload = mapper.mapToApiPayload('classscout', wrongCategory, 'post');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('category must be one of')), result.errors.join('; '));
});

check("validateForTenant('classscout') rejects an ageRanges value not in the closed en-dash vocabulary (the raw age_min/age_max mistake)", () => {
  const wrongAge = { ...sampleProvider, ageRanges: ['3-5'] }; // hyphen, not en dash
  const payload = mapper.mapToApiPayload('classscout', wrongAge, 'post');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('ageRanges')), result.errors.join('; '));
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

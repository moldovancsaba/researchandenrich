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
const { verifyFromIngestResponse } = require('../runtime/verifier/response-based');

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
    app: 'salesleadgenerator',
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
  broken.tenants.broken = { app: 'salesleadgenerator', apiBase: 'https://example.com', forbiddenFields: [] };
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

check("validateForTenant('classscout') rejects a create payload missing category or borough (regression: these were only format-checked, never required-checked)", () => {
  const { category, borough, ...missingBoth } = sampleProvider;
  const payload = mapper.mapToApiPayload('classscout', missingBoth, 'post');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('category is required')), result.errors.join('; '));
  assert.ok(result.errors.some((e) => e.includes('borough is required')), result.errors.join('; '));
});

check("validateForTenant('classscout') rejects a patch that explicitly sets image: '' (regression: empty string was exempted from the ImgBB check)", () => {
  const payload = mapper.mapToApiPayload('classscout', { id: sampleProvider.id, image: '' }, 'put');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('image must be an https ImgBB URL')), result.errors.join('; '));
});

check("validateForTenant('classscout') still accepts a patch that OMITS image entirely (leaving the existing image untouched is fine)", () => {
  const payload = mapper.mapToApiPayload('classscout', { id: sampleProvider.id, phone: '+1 718 555 0199' }, 'put');
  const result = mapper.validateForTenant('classscout', payload);
  assert.deepStrictEqual(result.errors, []);
});

check("validateForTenant('classscout') rejects a contactLinks[].type not in classscout's closed enum (regression: a live 422 on 'linkedin' was NOT caught locally, 2026-08-03)", () => {
  const payload = mapper.mapToApiPayload(
    'classscout',
    { id: sampleProvider.id, contactLinks: [{ type: 'linkedin', value: 'https://linkedin.com/company/example' }] },
    'put'
  );
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('contactLinks[].type')), result.errors.join('; '));
});

check("validateForTenant('classscout') accepts every real contactLinks[].type value classscout's live schema allows", () => {
  const validTypes = ['website', 'registration', 'email', 'phone', 'instagram', 'facebook', 'other'];
  const payload = mapper.mapToApiPayload(
    'classscout',
    { id: sampleProvider.id, contactLinks: validTypes.map((type) => ({ type, label: type, value: 'x' })) },
    'put'
  );
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(!result.errors.some((e) => e.includes('contactLinks')), result.errors.join('; '));
});

check("validateForTenant('classscout') rejects a contactLinks[] entry missing label (regression: a live 422 on 'contactLinks.0.label: Required' was NOT caught locally, 2026-08-03)", () => {
  const payload = mapper.mapToApiPayload(
    'classscout',
    { id: sampleProvider.id, contactLinks: [{ type: 'instagram', value: 'https://instagram.com/example' }] },
    'put'
  );
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('contactLinks[].label')), result.errors.join('; '));
});

check("validateForTenant('classscout') accepts a contactLinks[] entry with a non-empty label", () => {
  const payload = mapper.mapToApiPayload(
    'classscout',
    { id: sampleProvider.id, contactLinks: [{ type: 'instagram', label: 'Instagram', value: 'https://instagram.com/example' }] },
    'put'
  );
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(!result.errors.some((e) => e.includes('contactLinks')), result.errors.join('; '));
});

// --- runtime/verifier/response-based.js ---
check('verifyFromIngestResponse does NOT confirm a batch when the API silently dropped an operation (regression: results.length < expectedIds.length used to pass via vacuous .every())', () => {
  const result = verifyFromIngestResponse({
    responseBody: { ok: true, results: [{ index: 0, ok: true }] }, // only 1 result back
    expectedIds: ['prov-a', 'prov-b'], // but 2 operations were submitted
  });
  assert.strictEqual(result.confirmed, false);
});

check('verifyFromIngestResponse confirms a batch when every expected result came back ok', () => {
  const result = verifyFromIngestResponse({
    responseBody: { ok: true, results: [{ index: 0, ok: true }, { index: 1, ok: true }] },
    expectedIds: ['prov-a', 'prov-b'],
  });
  assert.strictEqual(result.confirmed, true);
});

// --- program-api (classscout) meetupGroup entity kind ---
// A genuinely different resource from Provider, not a variant of it -- see
// schema-mapper.js's _mapClassScoutMeetup docblock for the field differences
// (closed groupType/single ageRange/cadence enums, optional coverImageUrl,
// meetup- id prefix).
const sampleMeetup = {
  id: 'meetup-park-slope-new-parents-a1b2c3',
  name: 'Park Slope New Parents',
  borough: 'Brooklyn',
  neighborhood: 'Park Slope',
  groupType: 'New Parents',
  ageRange: '0–2',
  cadence: 'Weekly',
  instagram: '@parkslopenewparents',
  website: 'https://parkslopenewparents.example.com',
  description: 'A weekly meetup for new parents in Park Slope to connect and share support.',
  initials: 'PS',
  icon: 'stroller',
  palette: 'teal',
};

check("mapToApiPayload('classscout', meetup, 'post', 'meetupGroup') wraps a meetupGroups.upsertMany operation", () => {
  const payload = mapper.mapToApiPayload('classscout', sampleMeetup, 'post', 'meetupGroup');
  assert.strictEqual(payload.operations.length, 1);
  const op = payload.operations[0];
  assert.strictEqual(op.resource, 'meetupGroups');
  assert.strictEqual(op.action, 'upsertMany');
  assert.strictEqual(op.documents[0].id, sampleMeetup.id);
  assert.strictEqual(op.documents[0].coverImageUrl, undefined, 'coverImageUrl must be omitted, not empty-string, when not supplied');
});

check("mapToApiPayload('classscout', {...}, 'put', 'meetupGroup') wraps a meetupGroup.patch operation", () => {
  const payload = mapper.mapToApiPayload('classscout', { id: sampleMeetup.id, cadence: 'Monthly' }, 'put', 'meetupGroup');
  const op = payload.operations[0];
  assert.strictEqual(op.resource, 'meetupGroup');
  assert.strictEqual(op.action, 'patch');
  assert.strictEqual(op.id, sampleMeetup.id);
  assert.deepStrictEqual(op.patch, { cadence: 'Monthly' });
});

check("validateForTenant('classscout') accepts a valid mapped meetup create payload", () => {
  const payload = mapper.mapToApiPayload('classscout', sampleMeetup, 'post', 'meetupGroup');
  const result = mapper.validateForTenant('classscout', payload);
  assert.deepStrictEqual(result.errors, []);
});

check("validateForTenant('classscout') rejects a meetup create missing groupType/ageRange/cadence", () => {
  const { groupType, ageRange, cadence, ...missing } = sampleMeetup;
  const payload = mapper.mapToApiPayload('classscout', missing, 'post', 'meetupGroup');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('groupType is required')), result.errors.join('; '));
  assert.ok(result.errors.some((e) => e.includes('ageRange is required')), result.errors.join('; '));
  assert.ok(result.errors.some((e) => e.includes('cadence is required')), result.errors.join('; '));
});

check("validateForTenant('classscout') rejects a meetup ageRange value not in its own closed vocabulary (regression: must not reuse Provider's ageRanges list)", () => {
  const wrongAge = { ...sampleMeetup, ageRange: '3–5 years' }; // not a real value in either vocabulary
  const payload = mapper.mapToApiPayload('classscout', wrongAge, 'post', 'meetupGroup');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('ageRange must be one of')), result.errors.join('; '));
});

check("validateForTenant('classscout') accepts a meetup with NO coverImageUrl at all (regression: unlike Provider's image, this field is genuinely optional)", () => {
  const payload = mapper.mapToApiPayload('classscout', sampleMeetup, 'post', 'meetupGroup');
  assert.strictEqual('coverImageUrl' in payload.operations[0].documents[0], false);
  const result = mapper.validateForTenant('classscout', payload);
  assert.deepStrictEqual(result.errors, []);
});

check("validateForTenant('classscout') rejects a meetup coverImageUrl that isn't an ImgBB URL when one IS supplied", () => {
  const payload = mapper.mapToApiPayload('classscout', { ...sampleMeetup, coverImageUrl: 'https://example.com/photo.jpg' }, 'post', 'meetupGroup');
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('coverImageUrl must be empty or an https ImgBB URL')), result.errors.join('; '));
});


// ---------------------------------------------------------------------------
// getApiEndpoint: identifier encoding and validation (issue #24)
//
// `id` reaches this function from an agent-produced record assembled from
// web-sourced content. Unencoded interpolation let it alter the request path
// or inject query parameters into a call carrying SLG_API_KEY -- including
// suppressing ?brand=, which salesleadgenerator defaults to 'cogmap', so a
// seyu or dvsc write would silently land in cogmap's collection.
// ---------------------------------------------------------------------------

const { InvalidIdentifierError } = require('../schema-mapper');

check('getApiEndpoint output is unchanged for legitimate identifiers', () => {
  assert.strictEqual(
    mapper.getApiEndpoint('seyu', 'put', '507f1f77bcf86cd799439011'),
    'https://salesleadgenerator.vercel.app/api/leads/507f1f77bcf86cd799439011?brand=seyu');
  assert.strictEqual(
    mapper.getApiEndpoint('cogmap', 'list'),
    'https://salesleadgenerator.vercel.app/api/leads?brand=cogmap&limit=1000');
  assert.strictEqual(
    mapper.getApiEndpoint('dvsc', 'post'),
    'https://salesleadgenerator.vercel.app/api/leads?brand=dvsc');
  assert.strictEqual(
    mapper.getApiEndpoint('classscout', 'post'),
    'https://classscout.ai/api/ingest');
});

check('getApiEndpoint query parameter order is brand then limit', () => {
  // URLSearchParams follows insertion order; a reordered query would be
  // equivalent but would produce a confusing diff against recorded run URLs.
  assert.match(mapper.getApiEndpoint('cogmap', 'list'), /\?brand=cogmap&limit=1000$/);
});

for (const bad of ['abc?brand=cogmap', 'abc#', '../../admin/x', 'a/b', 'a%2Fb', 'a.b', 'a&b']) {
  check(`getApiEndpoint rejects a structure-altering id: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => mapper.getApiEndpoint('seyu', 'put', bad), InvalidIdentifierError);
  });
}

for (const bad of [null, undefined, '', 42, {}, []]) {
  check(`getApiEndpoint rejects a non-string id: ${JSON.stringify(bad) ?? 'undefined'}`, () => {
    assert.throws(() => mapper.getApiEndpoint('seyu', 'put', bad), InvalidIdentifierError);
  });
}

check('getApiEndpoint rejects an id with a leading separator', () => {
  assert.throws(() => mapper.getApiEndpoint('seyu', 'put', '-abc'), InvalidIdentifierError);
  assert.throws(() => mapper.getApiEndpoint('seyu', 'put', '_abc'), InvalidIdentifierError);
});

check('getApiEndpoint accepts 128 chars and rejects 129', () => {
  assert.ok(mapper.getApiEndpoint('seyu', 'put', 'a'.repeat(128)));
  assert.throws(() => mapper.getApiEndpoint('seyu', 'put', 'a'.repeat(129)),
    InvalidIdentifierError);
});

check("getApiEndpoint accepts classscout's prov-<slug> id form", () => {
  assert.ok(mapper.getApiEndpoint('cogmap', 'get', 'prov-brooklyn-soccer-academy'));
});

check('getApiEndpoint still throws for list/get on program-api', () => {
  assert.throws(() => mapper.getApiEndpoint('classscout', 'list'), /no ingest-credential-readable/);
  assert.throws(() => mapper.getApiEndpoint('classscout', 'get', 'prov-x'),
    /no ingest-credential-readable/);
});

check('getApiEndpoint still throws for an unknown action', () => {
  assert.throws(() => mapper.getApiEndpoint('cogmap', 'frobnicate'), /Unknown action/);
});


// ---------------------------------------------------------------------------
// Anti-contamination gate (issue #25)
//
// The forbidden-field check ran against the TOP LEVEL of its argument. For
// program-api that argument is the ingest envelope { operations: [...] }, so
// classscout's 13-entry forbiddenFields list was tested against keys that are
// never there and passed vacuously on every call. mapToApiPayload's own
// deletion still protected the write path, but the validator -- the documented
// "anti-contamination gate" -- enforced nothing.
//
// One case per forbidden field, so editing the list in tenants.json cannot
// silently drop coverage.
// ---------------------------------------------------------------------------

const CLASSSCOUT_FORBIDDEN = mapper.getTenant('classscout').forbiddenFields || [];

check('classscout declares a non-empty forbiddenFields list', () => {
  assert.ok(CLASSSCOUT_FORBIDDEN.length > 0, 'nothing to enforce -- coverage would be vacuous');
});

function classscoutCreate(extra) {
  return {
    operations: [{
      resource: 'providers', action: 'upsertMany',
      documents: [Object.assign({
        id: 'prov-test', name: 'Test', category: 'Classes', borough: 'Brooklyn',
        neighborhood: 'Park Slope', address: '123 Somewhere Street',
        activityTypes: ['Sports'], ageRanges: ['6–8'], dayTimeTags: ['Weekend'],
        pricePerClass: 0, shortDescription: 'A test provider record.',
        longDescription: 'A test provider record long enough to satisfy the minimum length rule.',
        rating: 0, reviewCount: 0, badges: [],
        image: 'https://i.ibb.co/abc/x.jpg', email: '', website: 'https://example.com', phone: '',
      }, extra)],
    }],
  };
}

for (const field of CLASSSCOUT_FORBIDDEN) {
  check(`classscout create rejects forbidden field in the provider document: ${field}`, () => {
    const result = mapper.validateForTenant('classscout', classscoutCreate({ [field]: 'x' }));
    assert.ok(
      result.errors.some((e) => e.startsWith(`Forbidden field present: ${field}`)),
      `not rejected. errors: ${JSON.stringify(result.errors)}`);
  });
}

for (const field of CLASSSCOUT_FORBIDDEN) {
  check(`classscout patch rejects forbidden field in the patch object: ${field}`, () => {
    const payload = {
      operations: [{ resource: 'provider', action: 'patch', id: 'prov-test',
                     patch: { [field]: 'x' } }],
    };
    const result = mapper.validateForTenant('classscout', payload);
    assert.ok(
      result.errors.some((e) => e.startsWith(`Forbidden field present: ${field}`)),
      `not rejected. errors: ${JSON.stringify(result.errors)}`);
  });
}

check('a forbidden field set to null is still rejected', () => {
  // Explicitly nulling a forbidden field still asserts it into the document.
  const result = mapper.validateForTenant('classscout', classscoutCreate({ ice: null }));
  assert.ok(result.errors.some((e) => e.startsWith('Forbidden field present: ice')));
});

check('violation messages name the location of the offending document', () => {
  const result = mapper.validateForTenant('classscout', classscoutCreate({ ice: 7 }));
  assert.ok(result.errors.some((e) => e.includes('(at operations[0].documents[0])')),
    JSON.stringify(result.errors));
});

check('a clean classscout create payload still validates', () => {
  const result = mapper.validateForTenant('classscout', classscoutCreate({}));
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

check('an unrecognised program-api shape fails loudly instead of passing vacuously', () => {
  for (const bad of [
    { operations: [] },
    { operations: [{ resource: 'providers', action: 'upsertMany' }] },
    { operations: [{ resource: 'providers', action: 'upsertMany', documents: [null] }] },
    { operations: [{ resource: 'provider', action: 'patch', id: 'prov-x', patch: 'nope' }] },
  ]) {
    const result = mapper.validateForTenant('classscout', bad);
    assert.strictEqual(result.valid, false, `passed vacuously: ${JSON.stringify(bad)}`);
  }
});

check('multi-document batches report per-index locations', () => {
  const payload = {
    operations: [{
      resource: 'providers', action: 'upsertMany',
      documents: [{ id: 'prov-a' }, { id: 'prov-b', ice: 3 }],
    }],
  };
  const result = mapper.validateForTenant('classscout', payload);
  assert.ok(result.errors.some((e) => e.includes('(at operations[0].documents[1])')),
    JSON.stringify(result.errors));
});

check('a sales-lead-api tenant with forbiddenFields rejects a violation', () => {
  // No real sales-lead tenant sets forbiddenFields (they legitimately share
  // field names), so a synthetic tenant proves the check runs for that family.
  const synthetic = new (require('../schema-mapper'))();
  synthetic.tenants.synthetic = {
    app: 'salesleadgenerator', status: 'paused',
    apiBase: 'https://salesleadgenerator.vercel.app',
    brandFields: { pro: 'pro_for_organization', con: 'con_for_organization' },
    forbiddenFields: ['leaked_field'],
    schemaFamily: 'sales-lead-api', forecastModel: 'deal-size-band',
  };
  const result = synthetic.validateForTenant('synthetic', { leaked_field: 'x' });
  assert.ok(result.errors.some((e) => e.startsWith('Forbidden field present: leaked_field')),
    JSON.stringify(result.errors));
});

check('qualityGate.requiredFields resolve against the extracted document', () => {
  const synthetic = new (require('../schema-mapper'))();
  synthetic.tenants.reqtest = {
    app: 'classscout', status: 'paused', apiBase: 'https://classscout.ai',
    forbiddenFields: [], schemaFamily: 'program-api',
    qualityGate: { requiredFields: ['name'] },
  };
  const missing = {
    operations: [{ resource: 'providers', action: 'upsertMany', documents: [{ id: 'prov-x' }] }],
  };
  const result = synthetic.validateForTenant('reqtest', missing);
  assert.ok(result.errors.some((e) => e.startsWith('Missing required field: name')),
    JSON.stringify(result.errors));
});


// ---------------------------------------------------------------------------
// Lead validator shape hardening (issue #26)
//
// _validateLead pushed a shape error for a non-array `contacts` and then
// iterated it anyway, so `contacts: {}` threw "not iterable" and aborted the
// whole batch run rather than rejecting one record. _standardizeContacts had
// the same class of defect and runs EARLIER (inside mapToApiPayload, on raw
// agent output), so it was the first throw site.
//
// `contacts: "a@b.c"` is the nastiest case: a string is iterable, so it did
// not throw -- it iterated characters, found no .email on any of them, and
// reported valid. A false pass.
// ---------------------------------------------------------------------------

const MALFORMED_CONTACTS = [
  [{}, 'contacts must be an array'],
  ['a@b.c', 'contacts must be an array'],
  [[null], 'contacts[0] must be an object'],
  [[42], 'contacts[0] must be an object'],
  [['a@b.c'], 'contacts[0] must be an object'],
  [[{ email: 42 }], 'contacts[0].email must be a string'],
  [[{ email: {} }], 'contacts[0].email must be a string'],
];

for (const [value, expected] of MALFORMED_CONTACTS) {
  check(`_validateLead reports rather than throws for contacts: ${JSON.stringify(value)}`, () => {
    const result = mapper.validateForTenant('cogmap', { contacts: value });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.includes(expected),
      `expected "${expected}", got ${JSON.stringify(result.errors)}`);
  });
}

check('contacts: "a@b.c" is rejected (was a silent false pass)', () => {
  const result = mapper.validateForTenant('cogmap', { contacts: 'a@b.c' });
  assert.strictEqual(result.valid, false, 'a string contacts value passed validation');
});

check('legitimate empty contact states remain valid', () => {
  for (const value of [[], [{}], [{ email: null }], [{ email: '' }]]) {
    const result = mapper.validateForTenant('cogmap', { contacts: value });
    assert.strictEqual(result.valid, true,
      `${JSON.stringify(value)} -> ${JSON.stringify(result.errors)}`);
  }
});

check('a malformed entry does not stop later entries being checked', () => {
  const result = mapper.validateForTenant('cogmap',
    { contacts: [null, { email: 'A@B.C' }] });
  assert.ok(result.errors.includes('contacts[0] must be an object'));
  assert.ok(result.errors.some((e) => e.startsWith('Email not lowercase:')),
    JSON.stringify(result.errors));
});

check('contact_phone shape is guarded before startsWith', () => {
  const bad = mapper.validateForTenant('cogmap', { contact_phone: 42 });
  assert.ok(bad.errors.includes('contact_phone must be a string'));
  const empty = mapper.validateForTenant('cogmap', { contact_phone: '' });
  assert.strictEqual(empty.valid, true, 'empty phone should be skipped, as before');
  const national = mapper.validateForTenant('cogmap', { contact_phone: '0361234' });
  assert.ok(national.errors.some((e) => e.startsWith('Phone not in international format:')));
});

check('_standardizeContacts never throws on any malformed contacts shape', () => {
  for (const value of [{}, 'a@b.c', [null], [42], [{ email: 42 }], [{ email: null }]]) {
    mapper.mapToApiPayload('cogmap', { contacts: value });
  }
});

check('_standardizeContacts leaves a non-string email untouched rather than repairing it', () => {
  const out = mapper.mapToApiPayload('cogmap', { contacts: [{ email: 42 }] });
  assert.strictEqual(out.contacts[0].email, 42);
});

check('_standardizeContacts still lowercases well-formed emails', () => {
  const out = mapper.mapToApiPayload('cogmap', { contacts: [{ email: 'A@B.C' }] });
  assert.strictEqual(out.contacts[0].email, 'a@b.c');
});

check('validateForTenant never throws across a fuzz of payload shapes', () => {
  const values = [
    undefined, null, 0, 1, '', 'x', true, false, [], {}, [[]], [{}], [null],
    { contacts: null }, { contacts: 0 }, { contacts: [[]] },
    { contact_phone: [] }, { contact_phone: {} },
    { pro_for_organization: 42 }, { estimated_participants: 'many' },
    { recommended_tier: 42 }, { revenue_model: [] },
  ];
  for (const tenantId of ['cogmap', 'seyu', 'dvsc', 'classscout']) {
    for (const payload of values) {
      try {
        mapper.validateForTenant(tenantId, payload);
      } catch (err) {
        throw new Error(
          `threw for ${tenantId} with ${JSON.stringify(payload)}: ${err.message}`);
      }
    }
  }
});


// ---------------------------------------------------------------------------
// One payload shape across every salesleadgenerator client (owner decision
// 2026-08-12)
//
// forecastModel used to select between two DISJOINT field sets: cogmap/dvsc
// emitted recommended_tier / revenue_model / estimated_participants /
// estimated_annual_revenue_usd / product_fit_notes, seyu emitted
// pricingByCompany instead. So seyu wrote a field the others never wrote and
// omitted five they always wrote -- a format divergence between clients of one
// API. Every field is now present on every tenant; empty where a tenant's
// business logic does not populate it.
// ---------------------------------------------------------------------------

const SALES_LEAD_TENANTS = Object.keys(mapper.tenants)
  .filter((id) => mapper.tenants[id].schemaFamily === 'sales-lead-api');

const UNIFIED_FORECAST_FIELDS = [
  'recommended_tier',
  'revenue_model',
  'estimated_participants',
  'estimated_annual_revenue_usd',
  'product_fit_notes',
  'pricingByCompany',
];

check('every sales-lead-api tenant emits an identical field set', () => {
  const shapes = SALES_LEAD_TENANTS.map((id) =>
    Object.keys(mapper.mapToApiPayload(id, { name: 'X' })).sort().join(','));
  const distinct = [...new Set(shapes)];
  assert.strictEqual(distinct.length, 1,
    `tenants diverge: ${JSON.stringify(Object.fromEntries(
      SALES_LEAD_TENANTS.map((id, i) => [id, shapes[i]])))}`);
});

for (const field of UNIFIED_FORECAST_FIELDS) {
  check(`every sales-lead-api tenant emits ${field}`, () => {
    for (const id of SALES_LEAD_TENANTS) {
      const out = mapper.mapToApiPayload(id, { name: 'X' });
      assert.ok(field in out, `${id} is missing ${field}`);
    }
  });
}

check('unpopulated forecast fields are empty, not absent and not invented', () => {
  for (const id of SALES_LEAD_TENANTS) {
    const out = mapper.mapToApiPayload(id, { name: 'X' });
    // Previously an absent recommended_tier on a deal-size-band tenant could be
    // coerced to 'essential'. Empty must stay empty.
    assert.strictEqual(out.recommended_tier, '', `${id} invented a tier`);
    assert.strictEqual(out.revenue_model, '', `${id} invented a revenue model`);
    assert.strictEqual(out.estimated_participants, 0);
    assert.strictEqual(out.estimated_annual_revenue_usd, 0);
    assert.strictEqual(out.product_fit_notes, '');
    assert.deepStrictEqual(out.pricingByCompany, {});
  }
});

check('seyu now normalises the deal-size-band fields it previously ignored', () => {
  const out = mapper.mapToApiPayload('seyu', {
    name: 'X', recommended_tier: '  ELITE ', revenue_model: 'Revenue Share',
    estimated_participants: '250', estimated_annual_revenue_usd: -5,
  });
  assert.strictEqual(out.recommended_tier, 'elite');
  assert.strictEqual(out.revenue_model, 'revenue_share');
  assert.strictEqual(out.estimated_participants, 250);
  assert.strictEqual(out.estimated_annual_revenue_usd, 0);
});

check('cogmap and dvsc now normalise pricingByCompany, which they previously dropped', () => {
  for (const id of ['cogmap', 'dvsc']) {
    const out = mapper.mapToApiPayload(id, {
      name: 'X',
      pricingByCompany: { AcmeCo: { currency: ' eur ', pricing_model: 'Monthly SaaS', monthly_eur: '-3' } },
    });
    assert.strictEqual(out.pricingByCompany.AcmeCo.currency, 'EUR', id);
    assert.strictEqual(out.pricingByCompany.AcmeCo.pricing_model, 'monthly_saas', id);
    assert.strictEqual(out.pricingByCompany.AcmeCo.monthly_eur, 0, id);
  }
});

check('an out-of-vocabulary value still falls back to the safe default', () => {
  const out = mapper.mapToApiPayload('cogmap', { recommended_tier: 'platinum' });
  assert.strictEqual(out.recommended_tier, 'essential');
});

check('validation accepts empty forecast fields for every tenant', () => {
  for (const id of SALES_LEAD_TENANTS) {
    const result = mapper.validateForTenant(id, mapper.mapToApiPayload(id, { name: 'X' }));
    assert.strictEqual(result.valid, true, `${id}: ${JSON.stringify(result.errors)}`);
  }
});

check('validation still rejects an out-of-vocabulary forecast value for every tenant', () => {
  for (const id of SALES_LEAD_TENANTS) {
    const r = mapper.validateForTenant(id, { recommended_tier: 'platinum' });
    assert.ok(r.errors.some((e) => e.startsWith('recommended_tier must be')), id);
    const r2 = mapper.validateForTenant(id, { pricingByCompany: [] });
    assert.ok(r2.errors.some((e) => e.startsWith('pricingByCompany must be')), id);
  }
});

check('forecastModel no longer changes the payload shape', () => {
  // It is retained only as a hint about which fields a tenant's prompt fills.
  const withModel = new (require('../schema-mapper'))();
  withModel.tenants.shapetest = {
    ...withModel.tenants.cogmap, forecastModel: 'pricing-by-company',
  };
  const a = Object.keys(withModel.mapToApiPayload('cogmap', { name: 'X' })).sort();
  const b = Object.keys(withModel.mapToApiPayload('shapetest', { name: 'X' })).sort();
  assert.deepStrictEqual(a, b, 'forecastModel still switches the shape');
});


// ---------------------------------------------------------------------------
// Mapper <-> prompt contract parity (operator/repo shared contract)
//
// prompts/shared/sales-lead-fields.md is the operator's file and the source of
// truth for WHICH fields exist. The mapper backfills them so omission is
// structurally impossible rather than a prompt-compliance question. These
// checks fail if the two drift -- a field the operator adds must be backfilled
// here, or explicitly recorded as server-computed.
// ---------------------------------------------------------------------------

const CONTRACT_PATH = require('path').join(
  __dirname, '..', 'prompts', 'shared', 'sales-lead-fields.md');
const {
  SALES_LEAD_CONTRACT_FIELDS,
  SALES_LEAD_SERVER_COMPUTED_FIELDS,
} = require('../schema-mapper');

/** Field names are the backticked identifiers in the contract's bullet list. */
function contractFieldNames() {
  const md = require('fs').readFileSync(CONTRACT_PATH, 'utf8');
  const names = new Set();
  for (const line of md.split('\n')) {
    if (!line.trimStart().startsWith('-')) continue;
    for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
      // Skip prose references to legacy/forbidden names, which the contract
      // mentions only to prohibit them.
      if (/^(pro|con)_for_$/.test(m[1])) continue;
      names.add(m[1]);
    }
  }
  return names;
}

check('the prompt contract file is parseable and non-empty', () => {
  // Guards the guard: an empty parse would make every check below vacuous.
  assert.ok(contractFieldNames().size >= 30,
    `only parsed ${contractFieldNames().size} field names from the contract`);
});

check('every contract field is backfilled or recorded as server-computed', () => {
  const contract = contractFieldNames();
  const handled = new Set([
    ...Object.keys(SALES_LEAD_CONTRACT_FIELDS),
    ...SALES_LEAD_SERVER_COMPUTED_FIELDS,
    // Named in the contract only to forbid them.
    'pro_for_tenant', 'con_for_tenant',
  ]);
  const missing = [...contract].filter((f) => !handled.has(f)
    && !/^(pro|con)_for_/.test(f));
  assert.deepStrictEqual(missing, [],
    `contract fields neither backfilled nor recorded as server-computed: ${missing.join(', ')}. `
    + 'Add them to SALES_LEAD_CONTRACT_FIELDS, or to SALES_LEAD_SERVER_COMPUTED_FIELDS '
    + 'with evidence that salesleadgenerator computes them.');
});

check('the mapper backfills nothing the contract does not list', () => {
  const contract = contractFieldNames();
  const extra = Object.keys(SALES_LEAD_CONTRACT_FIELDS).filter((f) => !contract.has(f));
  assert.deepStrictEqual(extra, [],
    `mapper backfills fields absent from the prompt contract: ${extra.join(', ')}`);
});

check('server-computed fields are NOT backfilled', () => {
  // Sending an empty value for a field the server derives risks clobbering a
  // correct one. Absent is the current working behaviour; empty is unverified.
  for (const field of SALES_LEAD_SERVER_COMPUTED_FIELDS) {
    assert.ok(!(field in SALES_LEAD_CONTRACT_FIELDS), `${field} must not be backfilled`);
    for (const id of SALES_LEAD_TENANTS) {
      const out = mapper.mapToApiPayload(id, {});
      assert.ok(!(field in out), `${id} emitted server-computed ${field}`);
    }
  }
});

check('every tenant emits every backfilled contract field', () => {
  for (const id of SALES_LEAD_TENANTS) {
    const out = mapper.mapToApiPayload(id, {});
    for (const field of Object.keys(SALES_LEAD_CONTRACT_FIELDS)) {
      assert.ok(field in out, `${id} is missing ${field}`);
    }
  }
});

check('a sourced value is never overwritten by the backfill', () => {
  const out = mapper.mapToApiPayload('cogmap', {
    entity_name: 'De Anza Force',
    contactEmails: ['a@b.c'],
    estimated_participants: 500,
  });
  assert.strictEqual(out.entity_name, 'De Anza Force');
  assert.deepStrictEqual(out.contactEmails, ['a@b.c']);
  assert.strictEqual(out.estimated_participants, 500);
});

check('a deliberately empty sourced value survives the backfill', () => {
  const out = mapper.mapToApiPayload('cogmap', { entity_name: '', tags: [] });
  assert.strictEqual(out.entity_name, '');
  assert.deepStrictEqual(out.tags, []);
});

check('backfilled arrays and objects are not shared between records', () => {
  // A shared reference would let one record's mutation leak into the next.
  const a = mapper.mapToApiPayload('cogmap', {});
  const b = mapper.mapToApiPayload('cogmap', {});
  a.tags.push('leaked');
  a.pricingByCompany.X = {};
  assert.deepStrictEqual(b.tags, [], 'array default is shared across records');
  assert.deepStrictEqual(b.pricingByCompany, {}, 'object default is shared across records');
});

check('a backfilled record still validates for every tenant', () => {
  for (const id of SALES_LEAD_TENANTS) {
    const r = mapper.validateForTenant(id, mapper.mapToApiPayload(id, {}));
    assert.strictEqual(r.valid, true, `${id}: ${JSON.stringify(r.errors)}`);
  }
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

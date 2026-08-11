#!/usr/bin/env node
/**
 * Standalone regression check for the admin API's input validation and error
 * envelope. Plain, dependency-free Node matching this repo's scripts/*.js
 * convention: `node scripts/verify-api-validation.js`.
 *
 * Requires Node >= 22.18 (see engines.node), which strips TypeScript types on
 * require without a flag -- lib/validation.ts and lib/api-response.ts are
 * loaded directly rather than through a build step.
 *
 * Covers three defect classes the audit found in app/api/admin/**:
 *   - MongoDB operator injection: tenantId/appId went from the JSON body
 *     straight into findOne({ tenantId }), so {"$ne": null} was interpreted as
 *     a query operator rather than compared as a value.
 *   - Mass assignment: PUT built its update as { ...existing, ...body }, so
 *     any caller could set status (stopping a tenant's cron) or clear
 *     tenantIds (bypassing the app delete guard).
 *   - Disclosure: catch blocks returned error.message verbatim, and MongoDB
 *     driver errors carry hostnames, replica-set topology, and connection
 *     string fragments.
 */

const assert = require('assert');

const {
  asIdentifier,
  validateAgainstSchema,
  deepEqual,
  TENANT_SCHEMA,
  APP_SCHEMA,
} = require('../lib/validation.ts');
const { classify, log, errorName } = require('../lib/errors.ts');

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

// ---------------------------------------------------------------------------
// Identifier validation -- operator injection
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS = [
  { $ne: null },
  { $gt: '' },
  { $exists: true },
  { $regex: '.*' },
];

for (const payload of INJECTION_PAYLOADS) {
  check(`asIdentifier rejects the operator object ${JSON.stringify(payload)}`, () => {
    const r = asIdentifier(payload, 'tenantId');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'must be a string');
  });
}

check('asIdentifier rejects every non-string primitive', () => {
  for (const v of [42, true, false, null, undefined, [], [['a']]]) {
    const r = asIdentifier(v, 'tenantId');
    assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(v)}`);
  }
});

check('asIdentifier rejects empty and whitespace-only strings', () => {
  assert.strictEqual(asIdentifier('', 'x').ok, false);
  assert.strictEqual(asIdentifier('   ', 'x').ok, false);
});

check('asIdentifier rejects characters MongoDB treats specially', () => {
  // $ and . are the two characters that carry meaning in a field name, so a
  // validated identifier stays inert in any query position added later.
  for (const v of ['a$b', 'a.b', 'a/b', 'a b', 'a\nb', '$where']) {
    assert.strictEqual(asIdentifier(v, 'x').ok, false, `accepted ${JSON.stringify(v)}`);
  }
});

check('asIdentifier rejects uppercase', () => {
  // Accepting mixed case would allow two tenants differing only in case, which
  // collide in every human-facing context.
  assert.strictEqual(asIdentifier('CogMap', 'x').ok, false);
});

check('asIdentifier rejects a leading separator', () => {
  assert.strictEqual(asIdentifier('-abc', 'x').ok, false);
  assert.strictEqual(asIdentifier('_abc', 'x').ok, false);
});

check('asIdentifier accepts 64 characters and rejects 65', () => {
  assert.strictEqual(asIdentifier('a'.repeat(64), 'x').ok, true);
  assert.strictEqual(asIdentifier('a'.repeat(65), 'x').ok, false);
});

check('asIdentifier accepts every real identifier in this repo', () => {
  const tenants = Object.keys(require('../tenants.json').tenants);
  assert.ok(tenants.length >= 4, 'expected at least four tenants');
  for (const id of [...tenants, 'researchandenrich', 'classscout']) {
    const r = asIdentifier(id, 'x');
    assert.strictEqual(r.ok, true, `rejected the real identifier '${id}'`);
  }
});

check('asIdentifier trims surrounding whitespace before validating', () => {
  const r = asIdentifier('  cogmap\n', 'x');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, 'cogmap');
});

// ---------------------------------------------------------------------------
// Field allowlisting -- mass assignment
// ---------------------------------------------------------------------------

check('an unknown field is rejected and named, not silently dropped', () => {
  const r = validateAgainstSchema(TENANT_SCHEMA, { isAdmin: true }, { partial: true });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.errors, [{ field: 'isAdmin', reason: 'not an accepted field' }]);
});

check('multiple bad fields are all reported in one response', () => {
  const r = validateAgainstSchema(
    TENANT_SCHEMA, { isAdmin: true, alsoBogus: 1 }, { partial: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 2);
});

check('tenantIds is immutable on app update -- restores the delete guard', () => {
  // Previously caller-writable, so the guard was bypassable in two requests:
  // clear the array, then DELETE.
  const r = validateAgainstSchema(APP_SCHEMA, { tenantIds: [] }, { partial: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'tenantIds'
    && e.reason.includes('cannot be modified')), JSON.stringify(r.errors));
});

check('tenantIds IS accepted on create', () => {
  const r = validateAgainstSchema(
    APP_SCHEMA, { appId: 'x', displayName: 'X', tenantIds: [] }, { partial: false });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

check('status accepts its enum and rejects anything else', () => {
  for (const v of ['active', 'paused']) {
    assert.strictEqual(
      validateAgainstSchema(TENANT_SCHEMA, { status: v }, { partial: true }).ok, true);
  }
  const bad = validateAgainstSchema(TENANT_SCHEMA, { status: 'enabled' }, { partial: true });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors[0].reason.includes('must be one of: active, paused'));
});

check('schemaFamily and forecastModel enforce their vocabularies', () => {
  assert.strictEqual(
    validateAgainstSchema(TENANT_SCHEMA, { schemaFamily: 'made-up' }, { partial: true }).ok,
    false);
  assert.strictEqual(
    validateAgainstSchema(TENANT_SCHEMA, { forecastModel: 'guesswork' }, { partial: true }).ok,
    false);
  assert.strictEqual(
    validateAgainstSchema(TENANT_SCHEMA, { schemaFamily: 'program-api' }, { partial: true }).ok,
    true);
});

check('each declared type rejects a wrong-typed value', () => {
  const cases = [
    ['displayName', 42],
    ['iceScoring', 'yes'],
    ['sortOrder', '3'],
    ['forbiddenFields', 'ice'],
    ['forbiddenFields', [1, 2]],
    ['brandFields', 'pro'],
    ['brandFields', []],
    ['sortOrder', NaN],
  ];
  for (const [field, value] of cases) {
    const r = validateAgainstSchema(TENANT_SCHEMA, { [field]: value }, { partial: true });
    assert.strictEqual(r.ok, false, `accepted ${field}=${JSON.stringify(value)}`);
  }
});

check('maxLength is enforced', () => {
  const r = validateAgainstSchema(
    TENANT_SCHEMA, { displayName: 'a'.repeat(129) }, { partial: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].reason.includes('at most 128'));
});

check('an explicit null is rejected rather than persisted', () => {
  const r = validateAgainstSchema(TENANT_SCHEMA, { displayName: null }, { partial: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].reason.includes('must not be null'));
});

check('required fields are enforced on create but not on update', () => {
  const create = validateAgainstSchema(TENANT_SCHEMA, { displayName: 'X' }, { partial: false });
  assert.strictEqual(create.ok, false);
  assert.ok(create.errors.some((e) => e.field === 'tenantId' && e.reason === 'required'));

  const update = validateAgainstSchema(TENANT_SCHEMA, { displayName: 'X' }, { partial: true });
  assert.strictEqual(update.ok, true, JSON.stringify(update.errors));
});

check('an empty update body is a valid no-op', () => {
  const r = validateAgainstSchema(TENANT_SCHEMA, {}, { partial: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, {});
});

check('a non-object body is rejected', () => {
  for (const body of [null, undefined, 'x', 42, []]) {
    const r = validateAgainstSchema(TENANT_SCHEMA, body, { partial: true });
    assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(body)}`);
  }
});

check('only allowlisted fields survive into the returned value', () => {
  const r = validateAgainstSchema(
    TENANT_SCHEMA, { displayName: 'X', status: 'active' }, { partial: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.value).sort(), ['displayName', 'status']);
});

check('deepEqual distinguishes changed from unchanged config values', () => {
  assert.strictEqual(deepEqual('a', 'a'), true);
  assert.strictEqual(deepEqual({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.strictEqual(deepEqual([1, 2], [1, 2]), true);
  assert.strictEqual(deepEqual(null, undefined), false);
});

// ---------------------------------------------------------------------------
// Error classification and redaction -- disclosure
// ---------------------------------------------------------------------------

check('driver connection failures classify as retryable 503, not 500', () => {
  class MongoServerSelectionError extends Error {}
  const r = classify(new MongoServerSelectionError('topology: [host-a:27017, host-b:27017]'));
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.code, 'database_unavailable');
});

check('the safe message never contains the exception message', () => {
  class MongoServerSelectionError extends Error {}
  const secret = 'sales.8wytusk.mongodb.net:27017';
  const r = classify(new MongoServerSelectionError(`could not connect to ${secret}`));
  assert.ok(!r.message.includes(secret), `leaked: ${r.message}`);
  assert.ok(!r.message.includes('27017'));
});

check('malformed JSON classifies as 400, not 500', () => {
  const r = classify(new SyntaxError('Unexpected token < in JSON at position 0'));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.code, 'malformed_body');
});

check('an unknown error class falls back to a generic 500', () => {
  const r = classify(new Error('something internal'));
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.code, 'internal_error');
  assert.ok(!r.message.includes('something internal'));
});

check('classify handles non-Error thrown values without throwing', () => {
  for (const v of ['a string', undefined, null, 42, {}]) {
    const r = classify(v);
    assert.strictEqual(r.status, 500);
  }
});

check('log redacts connection strings, api keys and JWTs', () => {
  const captured = [];
  const original = console.error;
  console.error = (line) => captured.push(line);
  try {
    log({
      level: 'error',
      message:
        'failed: mongodb+srv://user:hunter2@sales.8wytusk.mongodb.net/?appName=sales '
        + 'key=slg_7f3a9c2e5b18446d9a01e6c8f73b2a14 '
        + 'tok=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345',
    });
  } finally {
    console.error = original;
  }
  const line = captured.join('');
  assert.ok(!line.includes('hunter2'), 'connection string password leaked');
  assert.ok(!line.includes('8wytusk'), 'cluster host leaked');
  assert.ok(!line.includes('slg_7f3a9c2e'), 'api key leaked');
  assert.ok(line.includes('[redacted]'), 'nothing was redacted');
});

check('log truncates oversized fields rather than emitting them whole', () => {
  const captured = [];
  const original = console.error;
  console.error = (line) => captured.push(line);
  try {
    log({ level: 'error', message: 'x'.repeat(20000) });
  } finally {
    console.error = original;
  }
  assert.ok(captured[0].includes('[truncated'), 'oversized field was not truncated');
});

check('log never throws, even on a value that cannot be serialised', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const original = console.error;
  console.error = () => {};
  try {
    log({ level: 'error', cyclic });
  } finally {
    console.error = original;
  }
});


// ---------------------------------------------------------------------------
// Minification hazard (found against a real production build)
//
// classify() originally keyed on err.constructor.name. Next.js minifies the
// production server bundle and renames classes, so ConfigurationError became a
// mangled identifier: dev returned 503 misconfigured and production returned
// 500 internal_error for the identical condition. err.name is a string literal
// and survives.
// ---------------------------------------------------------------------------

check('classification survives a minified (renamed) class', () => {
  class ConfigurationError extends Error {
    constructor(msg) { super(msg); this.name = 'ConfigurationError'; }
  }
  const err = new ConfigurationError('MONGODB_URI is not set');
  // Simulate the minifier renaming the constructor.
  Object.defineProperty(err.constructor, 'name', { value: 'e' });
  assert.strictEqual(err.constructor.name, 'e', 'rename did not take effect');
  assert.strictEqual(classify(err).code, 'misconfigured',
    'classification regressed to constructor.name');
});

check('errorName prefers the literal name over the constructor name', () => {
  class Renamed extends Error {
    constructor() { super('x'); this.name = 'MongoServerSelectionError'; }
  }
  const err = new Renamed();
  Object.defineProperty(err.constructor, 'name', { value: 'q' });
  assert.strictEqual(errorName(err), 'MongoServerSelectionError');
  assert.strictEqual(classify(err).code, 'database_unavailable');
});

check('errorName falls back to the constructor for an unnamed error', () => {
  class PlainThing extends Error {}
  assert.strictEqual(errorName(new PlainThing('x')), 'PlainThing');
});

check('errorName handles non-Error values', () => {
  for (const v of ['str', 42, null, undefined, {}]) {
    assert.strictEqual(errorName(v), 'Unknown');
  }
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

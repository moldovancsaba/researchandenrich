#!/usr/bin/env node
/**
 * Standalone regression check for the queue control plane.
 *
 * The defect this exists for: PATCH wrote `<operation>.schedule.enabled` while
 * GET derived `enabled` from `tenant.status` alone and never read that field.
 * The operator toggled a job, the API returned 200, the UI reported success,
 * the value was persisted — and nothing read it, so the next page load showed
 * the original state. A control that reports success and changes nothing is
 * worse than an absent one, because it is acted upon.
 *
 * Two adjacent defects covered here too: PUT replaced the whole schedule
 * object from `{...(job.schedule || {})}`, so a reorder omitting `schedule`
 * erased a tenant's schedule; and it reported `updated: updates.length`, the
 * number of writes ATTEMPTED, so a reorder naming a nonexistent tenant
 * reported success.
 */

const assert = require('assert');
const {
  effectiveEnabled,
  parseJobId,
  REORDER_FORBIDDEN_FIELDS,
} = require('../lib/queue-core.ts');

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
// effectiveEnabled — the read/write agreement
// ---------------------------------------------------------------------------

const TRUTH_TABLE = [
  // status,    operation.enabled, expected
  ['active',    true,              true],
  ['active',    undefined,         true],  // absent means enabled, as tenants.json implies
  ['active',    false,             false],
  ['paused',    true,              false], // tenant switch wins
  ['paused',    undefined,         false],
  ['paused',    false,             false],
  [undefined,   true,              false], // unknown status is not active
];

for (const [status, enabled, expected] of TRUTH_TABLE) {
  check(`effectiveEnabled: status=${status} enabled=${enabled} -> ${expected}`, () => {
    const tenant = { status, discovery: enabled === undefined ? {} : { enabled } };
    assert.strictEqual(effectiveEnabled(tenant, 'discovery'), expected);
  });
}

check('effectiveEnabled reads the operation it was asked about', () => {
  const tenant = {
    status: 'active',
    discovery: { enabled: false },
    enrichment: { enabled: true },
  };
  assert.strictEqual(effectiveEnabled(tenant, 'discovery'), false);
  assert.strictEqual(effectiveEnabled(tenant, 'enrichment'), true);
});

check('effectiveEnabled ignores a stale schedule.enabled', () => {
  // The field the old PATCH wrote. It must have no effect, or the migration
  // would be cosmetic.
  const tenant = {
    status: 'active',
    discovery: { enabled: false, schedule: { kind: 'every', everyMs: 1, enabled: true } },
  };
  assert.strictEqual(effectiveEnabled(tenant, 'discovery'), false);
});

check('effectiveEnabled does not throw on a malformed tenant', () => {
  for (const t of [null, undefined, {}, { status: 'active' }, { discovery: null }]) {
    assert.doesNotThrow(() => effectiveEnabled(t, 'discovery'), `for ${JSON.stringify(t)}`);
  }
});

// ---------------------------------------------------------------------------
// parseJobId — a non-string previously threw a TypeError into a generic 500
// ---------------------------------------------------------------------------

check('parseJobId accepts well-formed ids for both operations', () => {
  assert.deepStrictEqual(parseJobId('queue-cogmap-discovery'),
    { tenantId: 'cogmap', operation: 'discovery' });
  assert.deepStrictEqual(parseJobId('queue-classscout-enrichment'),
    { tenantId: 'classscout', operation: 'enrichment' });
});

check('parseJobId returns null for a non-string rather than throwing', () => {
  for (const v of [42, null, undefined, {}, [], true]) {
    assert.doesNotThrow(() => parseJobId(v), `threw for ${JSON.stringify(v)}`);
    assert.strictEqual(parseJobId(v), null);
  }
});

check('parseJobId rejects malformed and unknown-operation ids', () => {
  for (const v of [
    'queue-cogmap-sideways',
    'cogmap-discovery',
    'queue--discovery',
    'queue-cogmap',
    '',
  ]) {
    assert.strictEqual(parseJobId(v), null, `accepted ${JSON.stringify(v)}`);
  }
});

check('parseJobId rejects a tenant segment that is not a valid identifier', () => {
  // Keeps a crafted job id from reaching a query document.
  for (const v of [
    'queue-$ne-discovery',
    'queue-a.b-discovery',
    'queue-CogMap-discovery',
    'queue--abc-discovery',
  ]) {
    assert.strictEqual(parseJobId(v), null, `accepted ${JSON.stringify(v)}`);
  }
});

check('parseJobId handles a tenant id containing a hyphen', () => {
  // The regex is non-greedy on the tenant segment; a hyphenated tenant must
  // still resolve, with only the trailing operation stripped.
  assert.deepStrictEqual(parseJobId('queue-my-tenant-discovery'),
    { tenantId: 'my-tenant', operation: 'discovery' });
});

// ---------------------------------------------------------------------------
// Reorder field policy — the schedule-erasure path
// ---------------------------------------------------------------------------

check('schedule is rejected on reorder', () => {
  assert.ok(REORDER_FORBIDDEN_FIELDS.includes('schedule'),
    'reorder accepting schedule is what erased tenant schedules');
});

check('enabled is rejected on reorder', () => {
  // Enablement has its own endpoint with its own audit event; letting a
  // reorder carry it would bypass that.
  assert.ok(REORDER_FORBIDDEN_FIELDS.includes('enabled'));
});

check('the reorder policy also rejects prompt and tenantId', () => {
  assert.ok(REORDER_FORBIDDEN_FIELDS.includes('prompt'));
  assert.ok(REORDER_FORBIDDEN_FIELDS.includes('tenantId'));
});

// ---------------------------------------------------------------------------
// Structural: the route must not reintroduce the defects
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const rawRouteSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'api', 'admin', 'queue', 'route.ts'),
  'utf8'
);

/**
 * Comments are stripped before matching. The route's own docblocks NAME the
 * defective field while explaining that it is no longer written -- matching
 * prose would fire on the documentation rather than the code.
 */
const routeSource = rawRouteSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

check('the route never writes schedule.enabled (comments excluded)', () => {
  assert.ok(!/schedule\.enabled/.test(routeSource),
    'the route writes schedule.enabled again — the field nothing reads');
  // Guard the guard: if comment-stripping ever removed everything, every
  // structural check below would pass vacuously.
  assert.ok(routeSource.includes('bulkWrite'), 'comment stripping removed real code');
});

check('PATCH writes <operation>.enabled', () => {
  assert.match(routeSource, /\[`\$\{operation\}\.enabled`\]/,
    'PATCH does not write the field GET reads');
});

check('the reorder path sets sortOrder only', () => {
  // $set inside bulkWrite must not carry schedule or enabled.
  const bulk = routeSource.slice(routeSource.indexOf('bulkWrite'));
  assert.ok(/\$set: \{ sortOrder/.test(bulk), 'reorder $set does not lead with sortOrder');
  assert.ok(!/\$set: \{[^}]*schedule/.test(bulk), 'reorder $set touches schedule');
});

check('the reorder response reports driver counts, not attempted writes', () => {
  assert.match(routeSource, /matched: result\.matchedCount/);
  assert.match(routeSource, /modified: result\.modifiedCount/);
  assert.ok(!/updated: updates\.length/.test(routeSource),
    'still reporting the number of writes attempted');
});

check('GET returns operationEnabled and tenantStatus alongside enabled', () => {
  // Without both inputs the UI cannot distinguish "you turned this off" from
  // "the tenant is paused".
  assert.match(routeSource, /operationEnabled:/);
  assert.match(routeSource, /tenantStatus:/);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

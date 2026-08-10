#!/usr/bin/env node
/**
 * Standalone regression check for config/cron-generator.js. Plain,
 * dependency-free Node, matching this repo's existing scripts/*.js
 * convention: `node scripts/verify-cron-generator.js`. Exits non-zero on any
 * failure.
 *
 * Exists to catch the bug class the generator was rewritten to fix: a
 * hand-rolled YAML parser that silently flattened nested mappings, so
 * `schedule`, `retry` and `healthCheck` all parsed as {} while their children
 * were hoisted to the top level. The practical effect was that the generator
 * ignored its own inputs -- every entry fell through to a hardcoded default
 * and editing a worker YAML changed nothing. It went unnoticed because the
 * default happened to match what the files specified.
 *
 * The load-bearing checks here are the ones that prove the input is actually
 * READ (a changed schedule reaches the output), not merely parsed. Asserting
 * the output alone would have passed against the broken parser.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateCronYaml,
  loadWorkerYaml,
  validateWorkerConfig,
  everyMsToCron,
  resolveCron,
} = require('../config/cron-generator');

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

/** Write a temp YAML file and return its path. */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-gen-'));
function fixture(name, body) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, body);
  return p;
}

// ---------------------------------------------------------------------------
// Parse fidelity -- the exact assertions the old parser failed
// ---------------------------------------------------------------------------

const NESTED = `
tenant: fixture
operation: discovery
prompt: prompts/discovery/fixture.md
schedule:
  kind: every
  everyMs: 1800000
retry:
  maxAttempts: 5
  backoffMs: 2500
timeoutMs: 120000
dependencies: []
healthCheck:
  endpoint: GET /api/leads?brand=fixture&limit=1
  expectedStatus: 200
`;

check('nested schedule mapping survives parsing (old parser produced {})', () => {
  const doc = loadWorkerYaml(fixture('nested.yaml', NESTED));
  assert.deepStrictEqual(doc.schedule, { kind: 'every', everyMs: 1800000 });
});

check('nested retry mapping survives parsing (old parser produced {})', () => {
  const doc = loadWorkerYaml(fixture('nested2.yaml', NESTED));
  assert.deepStrictEqual(doc.retry, { maxAttempts: 5, backoffMs: 2500 });
});

check('nested healthCheck mapping survives parsing (old parser produced {})', () => {
  const doc = loadWorkerYaml(fixture('nested3.yaml', NESTED));
  assert.strictEqual(doc.healthCheck.expectedStatus, 200);
  assert.strictEqual(doc.healthCheck.endpoint, 'GET /api/leads?brand=fixture&limit=1');
});

check('empty sequence parses as [] (old parser produced [""])', () => {
  const doc = loadWorkerYaml(fixture('nested4.yaml', NESTED));
  assert.deepStrictEqual(doc.dependencies, []);
});

check('children are NOT hoisted to the document root', () => {
  const doc = loadWorkerYaml(fixture('nested5.yaml', NESTED));
  assert.strictEqual(doc.everyMs, undefined, 'everyMs leaked to the root');
  assert.strictEqual(doc.maxAttempts, undefined, 'maxAttempts leaked to the root');
  assert.strictEqual(doc.endpoint, undefined, 'endpoint leaked to the root');
});

// ---------------------------------------------------------------------------
// The input is actually READ -- asserting output shape alone would have
// passed against the broken parser, which is why it survived so long.
// ---------------------------------------------------------------------------

check('an explicit schedule.cron in a worker file reaches the generated output', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '0 */6 * * *' } } } }
  );
  assert.match(out, /cron: "0 \*\/6 \* \* \*"/);
});

check('changing a worker schedule changes the generated output', () => {
  const build = (cron) => generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron } } } }
  );
  assert.notStrictEqual(build('0 */6 * * *'), build('0 */12 * * *'));
});

check('worker retry values reach the output rather than being defaulted', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '* * * * *' },
                         retry: { maxAttempts: 7, backoffMs: 1234 } } } }
  );
  assert.match(out, /maxAttempts: 7/);
  assert.match(out, /backoffMs: 1234/);
});

check('worker timeoutMs reaches the output', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '* * * * *' }, timeoutMs: 99000 } } }
  );
  assert.match(out, /timeoutMs: 99000/);
});

// ---------------------------------------------------------------------------
// Interval -> cron conversion
// ---------------------------------------------------------------------------

check('everyMsToCron converts expressible sub-hour intervals', () => {
  assert.strictEqual(everyMsToCron(30 * 60000, 'f'), '*/30 * * * *');
  assert.strictEqual(everyMsToCron(15 * 60000, 'f'), '*/15 * * * *');
  assert.strictEqual(everyMsToCron(5 * 60000, 'f'), '*/5 * * * *');
});

check('everyMsToCron converts whole-hour intervals', () => {
  assert.strictEqual(everyMsToCron(60 * 60000, 'f'), '0 */1 * * *');
  assert.strictEqual(everyMsToCron(6 * 60 * 60000, 'f'), '0 */6 * * *');
  assert.strictEqual(everyMsToCron(24 * 60 * 60000, 'f'), '0 0 * * *');
});

check('everyMsToCron preserves the legacy form for 45m (live behaviour, warns)', () => {
  // 60 % 45 !== 0, so this is not a faithful 45-minute interval. Production
  // has always run this uneven cadence; the generator must not silently
  // change it. See the function's docblock.
  assert.strictEqual(everyMsToCron(45 * 60000, 'f'), '*/45 * * * *');
});

check('everyMsToCron rejects a sub-minute interval', () => {
  assert.throws(() => everyMsToCron(30000, 'f'), /whole number of minutes/);
});

check('everyMsToCron rejects a non-positive interval', () => {
  assert.throws(() => everyMsToCron(0, 'f'), /positive number/);
  assert.throws(() => everyMsToCron(-60000, 'f'), /positive number/);
});

check('resolveCron prefers an explicit cron over everyMs', () => {
  const r = resolveCron({ schedule: { cron: '0 3 * * *', everyMs: 1800000 } }, 'f');
  assert.strictEqual(r.cron, '0 3 * * *');
  assert.strictEqual(r.source, 'explicit');
});

// ---------------------------------------------------------------------------
// Validation -- the old parser silently produced wrong output instead
// ---------------------------------------------------------------------------

check('a worker file missing a required key fails with the path and key named', () => {
  const p = fixture('missing.yaml', 'tenant: x\noperation: discovery\n');
  assert.throws(() => validateWorkerConfig(loadWorkerYaml(p), p), /missing required key 'prompt'/);
});

check('an invalid operation value is rejected', () => {
  const p = fixture('badop.yaml',
    'tenant: x\noperation: sideways\nprompt: p.md\nschedule:\n  everyMs: 60000\n');
  assert.throws(() => validateWorkerConfig(loadWorkerYaml(p), p), /must be 'discovery' or 'enrichment'/);
});

check('a schedule with neither cron nor everyMs is rejected', () => {
  const p = fixture('noschedule.yaml',
    'tenant: x\noperation: discovery\nprompt: p.md\nschedule:\n  kind: every\n');
  assert.throws(() => validateWorkerConfig(loadWorkerYaml(p), p), /needs either a 'cron'/);
});

check('a scalar schedule is rejected', () => {
  const p = fixture('scalarsched.yaml',
    'tenant: x\noperation: discovery\nprompt: p.md\nschedule: hourly\n');
  assert.throws(() => validateWorkerConfig(loadWorkerYaml(p), p), /'schedule' must be a mapping/);
});

check('malformed YAML fails with the file path named', () => {
  const p = fixture('broken.yaml', 'tenant: x\n  bad: [unclosed\n');
  assert.throws(() => loadWorkerYaml(p), /invalid YAML/);
});

check('a non-mapping document root is rejected', () => {
  const p = fixture('seq.yaml', '- one\n- two\n');
  assert.throws(() => loadWorkerYaml(p), /expected a YAML mapping/);
});

// ---------------------------------------------------------------------------
// Enablement precedence
// ---------------------------------------------------------------------------

check('a paused tenant yields enabled: false', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'paused', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '* * * * *' } } } }
  );
  assert.match(out, /enabled: false/);
});

check('an active tenant with discovery.enabled false yields enabled: false', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: false } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '* * * * *' } } } }
  );
  assert.match(out, /enabled: false/);
});

check('an active tenant with the operation enabled yields enabled: true', () => {
  const out = generateCronYaml(
    { tenants: { t1: { app: 'a', status: 'active', discovery: { enabled: true } } } },
    { t1: { discovery: { prompt: 'p.md', schedule: { cron: '* * * * *' } } } }
  );
  assert.match(out, /enabled: true/);
});

check('a tenant declared in tenants.json with no worker directory is skipped, not emitted', () => {
  const out = generateCronYaml(
    { tenants: { ghost: { app: 'a', status: 'active' } } },
    {}
  );
  assert.doesNotMatch(out, /worker: ghost/);
});

// ---------------------------------------------------------------------------
// The real tree still produces the committed file
// ---------------------------------------------------------------------------

check('generated output matches the committed config/cron.yaml', () => {
  const { discoverWorkers, loadTenantConfig } = require('../config/cron-generator');
  const actual = generateCronYaml(loadTenantConfig(), discoverWorkers());
  const committed = fs.readFileSync(path.join(__dirname, '..', 'config', 'cron.yaml'), 'utf-8');
  assert.strictEqual(
    actual.trim(),
    committed.trim(),
    'config/cron.yaml is stale or the generator drifted. If intentional, regenerate it AND ' +
    'explain every changed line -- each one is a live scheduling change.'
  );
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Standalone regression check for the standalone runner scripts.
 *
 * Exists because run-cogmap-enrichment-lean.js could not run at all on a clean
 * checkout, and nothing caught it: it required `dotenv`, which is in neither
 * `dependencies` nor `node_modules`, so it died with MODULE_NOT_FOUND before
 * doing any work. It also hardcoded `/api/lead` (singular) instead of calling
 * getApiEndpoint, and dropped the query string when building its request, so
 * `?brand=` never reached the API.
 *
 * These are structural checks: a runner that hardcodes an API path or requires
 * an absent module fails here rather than at 03:00 in a scheduled run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./verify-helpers');

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (err) { console.error(`FAIL  ${label}\n      ${err.message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');

/** Any top-level *.js that looks like an executable runner. */
function runnerFiles() {
  return fs.readdirSync(ROOT)
    .filter((f) => /^run-.*\.js$/.test(f))
    .map((f) => path.join(ROOT, f));
}

const runners = runnerFiles();

check('runner scripts are discovered (guards against a vacuous pass)', () => {
  assert.ok(runners.length > 0, 'no run-*.js found -- discovery is broken');
});

const declaredDeps = new Set([
  ...Object.keys(require('../package.json').dependencies || {}),
  ...Object.keys(require('../package.json').devDependencies || {}),
]);

for (const file of runners) {
  const rel = path.relative(ROOT, file);
  const src = codeOnly(fs.readFileSync(file, 'utf8'), 'require(');

  check(`${rel}: every require() resolves`, () => {
    const requires = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
    const bare = requires.filter((r) => !r.startsWith('.') && !r.startsWith('/'));
    for (const dep of bare) {
      const top = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
      if (top.startsWith('node:')) continue;
      let resolvable = true;
      try { require.resolve(top); } catch { resolvable = false; }
      assert.ok(resolvable,
        `requires '${top}' which does not resolve` +
        (declaredDeps.has(top) ? ' (declared but not installed)' : ' and is not in package.json'));
    }
  });

  check(`${rel}: does not hardcode a salesleadgenerator API path`, () => {
    // getApiEndpoint owns identifier validation, percent-encoding and the
    // ?brand= parameter. A hardcoded URL bypasses all three.
    const hardcoded = src.match(/https:\/\/salesleadgenerator[^'"`\s]*/g) || [];
    assert.deepStrictEqual(hardcoded, [],
      `hardcodes ${hardcoded.join(', ')} -- call getApiEndpoint instead`);
  });

  check(`${rel}: preserves the query string when building a request`, () => {
    // salesleadgenerator's resolveBrand() defaults a MISSING brand to 'cogmap',
    // so a dropped query string is invisible for cogmap and silently writes
    // another tenant's records into cogmap's collection.
    if (!/new URL\(/.test(src)) return;
    if (!/path:\s*/.test(src)) return;
    assert.ok(/url\.search|\.search\b/.test(src),
      'builds a request path from a URL without including url.search, dropping ?brand=');
  });

  check(`${rel}: resolves env files through the RAE_ENV_DIR contract`, () => {
    if (!/\.env\./.test(src)) return;
    assert.match(src, /RAE_ENV_DIR/,
      'reads a tenant env file without honouring RAE_ENV_DIR; prompts/RUNTIME_PATHS.md '
      + 'states env files normally live outside the clone');
  });
}

check('run-cogmap-enrichment-lean.js loads without throwing', () => {
  // The original failure mode was a crash at require time, before any work.
  const res = require('child_process').spawnSync(
    process.execPath,
    ['-e', "process.argv[1]=require('path').resolve('run-cogmap-enrichment-lean.js');"
         + "require('module')._load(process.argv[1], null, true)"],
    { cwd: ROOT, encoding: 'utf8', timeout: 20000 }
  );
  assert.ok(!/MODULE_NOT_FOUND/.test(res.stderr || ''),
    `module resolution failed: ${(res.stderr || '').split('\n')[0]}`);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) { console.error('FAILURES ABOVE'); process.exit(1); }

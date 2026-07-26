#!/usr/bin/env node
/**
 * Run this on a machine with real internet access — NOT inside a network-
 * restricted sandbox. It calls each engine directly (bypassing the router's
 * failover) with a harmless test query and reports PASS/FAIL/WARN so you can
 * see, per engine, whether it's reachable and whether the parser still
 * matches its real response shape.
 *
 * Usage:
 *   node scripts/live-smoke-test.js               # all engines with safe defaults
 *   node scripts/live-smoke-test.js --only=parallel,youcom
 *   SEYU_SEARCH_CONFIG=./my-config.json node scripts/live-smoke-test.js   # to include Fess/YaCy
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES } from '../src/engines/registry.js';
import { commonCrawlSpec } from '../src/engines/commonCrawl.js';
import { runRestEngine } from '../src/engines/restRunner.js';
import { runMcpUpstreamEngine } from '../src/engines/mcpUpstreamAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.replace('--only=', '').split(',') : null;

const configPath = process.env.SEYU_SEARCH_CONFIG || path.join(__dirname, '..', 'seyu-search-router.config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* fine — fess/yacy will just report not_configured */ }

const TEST_QUERY = 'climate';
const ALL_SPECS = { ...ENGINES, commonCrawl: commonCrawlSpec };

const results = [];

async function testOne(id, spec) {
  const opts = { ...(config[id] || {}), query: TEST_QUERY, maxResults: 5 };
  const startedAt = Date.now();
  try {
    let outcome;
    if (spec.type === 'rest') outcome = await runRestEngine(spec, TEST_QUERY, opts);
    else if (spec.type === 'mcp') outcome = await runMcpUpstreamEngine(spec, TEST_QUERY, opts, {});
    else if (spec.type === 'custom') outcome = await spec.run(TEST_QUERY, opts);
    else throw new Error(`unknown type for ${id}`);

    const latencyMs = Date.now() - startedAt;
    if (outcome.parseWarning) {
      results.push({ id, status: 'WARN', latencyMs, detail: outcome.parseWarning, count: outcome.results.length });
    } else {
      results.push({ id, status: 'PASS', latencyMs, count: outcome.results.length, sample: outcome.results[0] || null });
    }
  } catch (err) {
    if (err.type === 'not_configured') {
      results.push({ id, status: 'SKIP', detail: 'not configured — add a baseUrl in seyu-search-router.config.json to test this one' });
      return;
    }
    results.push({ id, status: 'FAIL', latencyMs: Date.now() - startedAt, detail: `${err.type || 'error'}: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}` });
  }
}

console.log(`Live smoke test — query: "${TEST_QUERY}"\n`);

for (const [id, spec] of Object.entries(ALL_SPECS)) {
  if (only && !only.includes(id)) continue;
  // eslint-disable-next-line no-await-in-loop
  await testOne(id, spec);
}

const width = Math.max(...results.map((r) => r.id.length)) + 2;
for (const r of results) {
  const badge = { PASS: '\u2705 PASS', WARN: '\u26a0\ufe0f  WARN', FAIL: '\u274c FAIL', SKIP: '\u23ed\ufe0f  SKIP' }[r.status];
  console.log(`${r.id.padEnd(width)} ${badge}${r.latencyMs ? ` (${r.latencyMs}ms)` : ''}`);
  if (r.count != null) console.log(`${''.padEnd(width)}   ${r.count} result(s)${r.sample ? ` \u2014 e.g. ${r.sample.url}` : ''}`);
  if (r.detail) console.log(`${''.padEnd(width)}   ${r.detail}`);
}

const failed = results.filter((r) => r.status === 'FAIL');
const warned = results.filter((r) => r.status === 'WARN');
console.log(`\n${results.length} tested \u2014 ${results.filter((r) => r.status === 'PASS').length} pass, ${warned.length} warn, ${failed.length} fail, ${results.filter((r) => r.status === 'SKIP').length} skipped.`);

if (['parallel', 'youcom'].some((id) => (only ? only.includes(id) : true))) {
  const p = results.find((r) => r.id === 'parallel');
  const y = results.find((r) => r.id === 'youcom');
  console.log('\nThese two were flagged "unverified-in-this-build" in the registry (could not be reached from the build sandbox):');
  if (p) console.log(`  parallel: ${p.status}${p.detail ? ` \u2014 ${p.detail}` : ''}`);
  if (y) console.log(`  youcom:   ${y.status}${y.detail ? ` \u2014 ${y.detail}` : ''}`);
  console.log('If either shows WARN or FAIL, open src/engines/registry.js and adjust that engine\'s parseResult/buildArgs to match what it actually returned above, then re-run this script.');
}

process.exit(failed.length > 0 ? 1 : 0);

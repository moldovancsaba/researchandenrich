import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchRouter } from '../src/router.js';
import { makeResult } from '../src/resultSchema.js';

function fakeEngine(id, { failTimes = 0, errorType = 'timeout', status, results = [], rateLimit = null } = {}) {
  let calls = 0;
  const spec = {
    id,
    label: `Fake ${id}`,
    type: 'custom',
    cacheTtlMs: 60_000,
    rateLimit,
    async run() {
      calls += 1;
      if (calls <= failTimes) {
        const err = new Error(`simulated ${errorType}${status ? ` (${status})` : ''}`);
        err.type = errorType;
        if (status) err.status = status;
        throw err;
      }
      return { results: results.map((r, i) => makeResult({ ...r, engine: id, rank: r.rank ?? i + 1 })) };
    },
  };
  return { spec, getCalls: () => calls };
}

function fakeNotConfigured(id) {
  return {
    id,
    label: `Fake ${id}`,
    type: 'custom',
    cacheTtlMs: 60_000,
    async run() {
      throw Object.assign(new Error(`${id} not configured`), { type: 'not_configured' });
    },
  };
}

test('fails over to the next engine and reports partial when the first fails', async () => {
  const a = fakeEngine('a', { failTimes: 1, results: [] });
  const b = fakeEngine('b', { results: [{ url: 'https://ok.com/1', title: 'ok' }] });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec, b: b.spec },
    routes: { testRoute: ['a', 'b'] },
  });

  const res = await router.search('q', { queryType: 'testRoute' });
  assert.equal(res.status, 'partial');
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].url, 'https://ok.com/1');
  assert.equal(res.attempted[0].outcome, 'failed');
  assert.equal(res.attempted[1].outcome, 'ok');
});

test('fast mode stops at the first engine with results; thorough mode merges all', async () => {
  const a = fakeEngine('a', { results: [{ url: 'https://a.com/1' }] });
  const b = fakeEngine('b', { results: [{ url: 'https://b.com/1' }] });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec, b: b.spec },
    routes: { testRoute: ['a', 'b'] },
  });

  const fast = await router.search('q1', { queryType: 'testRoute', mode: 'fast' });
  assert.equal(fast.results.length, 1);
  assert.equal(b.getCalls(), 0); // never reached

  const thorough = await router.search('q2', { queryType: 'testRoute', mode: 'thorough' });
  assert.equal(thorough.results.length, 2);
  assert.equal(b.getCalls(), 1);
});

test('circuit breaker opens after repeated failures and skips without calling the engine again', async () => {
  const a = fakeEngine('a', { failTimes: 999 }); // always fails
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec },
    routes: { testRoute: ['a'] },
  });

  await router.search('q', { queryType: 'testRoute' });
  await router.search('q', { queryType: 'testRoute' });
  const third = await router.search('q', { queryType: 'testRoute' });
  assert.equal(third.status, 'coverage_incomplete');
  assert.equal(a.getCalls(), 3); // threshold reached, circuit now open

  const fourth = await router.search('q', { queryType: 'testRoute' });
  assert.equal(a.getCalls(), 3); // NOT called again — breaker skipped it
  assert.equal(fourth.attempted[0].outcome, 'skipped');
  assert.equal(fourth.attempted[0].reason, 'circuit_open');
});

test('a surprise 401 on an engine documented as anonymous is treated as an ordinary failure and does not crash the router', async () => {
  const a = fakeEngine('a', { failTimes: 999, errorType: 'http_error', status: 401 });
  const b = fakeEngine('b', { results: [{ url: 'https://fallback.com/1' }] });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec, b: b.spec },
    routes: { testRoute: ['a', 'b'] },
  });

  const res = await router.search('q', { queryType: 'testRoute' });
  assert.equal(res.status, 'partial');
  assert.equal(res.attempted[0].status, 401);
  assert.equal(res.results[0].url, 'https://fallback.com/1');
});

test('cache hit avoids re-calling the engine', async () => {
  const a = fakeEngine('a', { results: [{ url: 'https://cached.com/1' }] });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec },
    routes: { testRoute: ['a'] },
  });

  await router.search('same query', { queryType: 'testRoute' });
  const second = await router.search('same query', { queryType: 'testRoute' });
  assert.equal(a.getCalls(), 1);
  assert.equal(second.attempted[0].outcome, 'cache_hit');
});

test('coverage_incomplete when every engine in the route fails, with a clear note and no crash', async () => {
  const a = fakeEngine('a', { failTimes: 999 });
  const b = fakeEngine('b', { failTimes: 999 });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec, b: b.spec },
    routes: { testRoute: ['a', 'b'] },
  });

  const res = await router.search('q', { queryType: 'testRoute', mode: 'thorough' });
  assert.equal(res.status, 'coverage_incomplete');
  assert.equal(res.results.length, 0);
  assert.match(res.note, /No usable results/);
  assert.match(res.note, /does not fall back to an unapproved scraper/);
});

test('not_configured engines are skipped without tripping the circuit breaker or blocking an "ok" status', async () => {
  const notConfigured = fakeNotConfigured('nc');
  const b = fakeEngine('b', { results: [{ url: 'https://ok.com/1' }] });
  const router = new SearchRouter({
    engines: {},
    customEngines: { nc: notConfigured, b: b.spec },
    routes: { testRoute: ['nc', 'b'] },
  });

  const res = await router.search('q', { queryType: 'testRoute' });
  assert.equal(res.status, 'ok'); // not_configured shouldn't force 'partial'
  assert.equal(res.attempted[0].reason, 'not_configured');
  const health = router.getHealth().find((h) => h.id === 'nc');
  assert.equal(health.circuit.state, 'closed'); // never penalized
});

test('rate limiter blocks a second call within the window and shows up as skipped', async () => {
  const a = fakeEngine('a', {
    results: [{ url: 'https://x.com/1' }],
    rateLimit: { kind: 'minInterval', minIntervalMs: 10_000 },
  });
  const router = new SearchRouter({
    engines: {},
    customEngines: { a: a.spec },
    routes: { testRoute: ['a'] },
  });

  await router.search('query one', { queryType: 'testRoute' });
  const second = await router.search('query two', { queryType: 'testRoute' }); // different query, same engine budget
  assert.equal(second.attempted[0].outcome, 'skipped');
  assert.match(second.attempted[0].reason, /min interval/);
});

test('unknown queryType returns a clear error instead of throwing', async () => {
  const router = new SearchRouter({ engines: {}, customEngines: {}, routes: { onlyRoute: [] } });
  const res = await router.search('q', { queryType: 'nonexistent' });
  assert.equal(res.status, 'error');
  assert.match(res.error, /unknown queryType/);
});

test('daily budget limiter persists across router instances via persistDir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seyu-router-'));
  const a = fakeEngine('a', { results: [{ url: 'https://x.com/1' }], rateLimit: { kind: 'dailyBudget', dailyBudget: 1 } });

  const router1 = new SearchRouter({ engines: {}, customEngines: { a: a.spec }, routes: { testRoute: ['a'] }, persistDir: dir });
  await router1.search('q', { queryType: 'testRoute' });

  const router2 = new SearchRouter({ engines: {}, customEngines: { a: a.spec }, routes: { testRoute: ['a'] }, persistDir: dir });
  const res = await router2.search('q2', { queryType: 'testRoute' });
  assert.equal(res.status, 'coverage_incomplete'); // budget already spent by router1, persisted to disk

  fs.rmSync(dir, { recursive: true, force: true });
});

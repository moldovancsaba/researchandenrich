#!/usr/bin/env node
/**
 * Standalone regression check for runtime/shared/endpoint.js and the two
 * verifiers. Plain, dependency-free Node matching this repo's scripts/*.js
 * convention: `node scripts/verify-runtime.js`. Exits non-zero on any failure.
 *
 * Exists to catch the bug this module was extracted to fix: list-based.js's
 * healthCheck concatenated `apiBase + endpoint` without stripping the HTTP
 * verb, so the documented `GET /api/leads?brand=...` input produced
 * `https://hostGET /api/leads?...`. That throws on fetch, was swallowed by the
 * function's own try/catch, and was reported as `{ healthy: false }` -- i.e.
 * identical to a real outage. Health checks for cogmap, seyu and dvsc have
 * therefore never worked, while classscout's did, because response-based.js
 * stripped the verb with a local regex.
 *
 * The load-bearing check is the one using the literal string from apps.yaml's
 * healthCheckTemplate. Network cases run against a local stub server, so this
 * suite needs no credentials and no internet.
 */

const assert = require('assert');
const http = require('http');

const { parseEndpoint, buildUrl } = require('../runtime/shared/endpoint');
const listBased = require('../runtime/verifier/list-based');
const responseBased = require('../runtime/verifier/response-based');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures.push(label);
    console.error(`FAIL  ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures.push(label);
    console.error(`FAIL  ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// parseEndpoint
// ---------------------------------------------------------------------------

check('parseEndpoint strips a GET prefix', () => {
  assert.deepStrictEqual(parseEndpoint('GET /api/leads?brand=cogmap&limit=1'),
    { method: 'GET', path: '/api/leads?brand=cogmap&limit=1' });
});

check('parseEndpoint uses a non-GET verb as the request method', () => {
  assert.deepStrictEqual(parseEndpoint('POST /api/ingest'),
    { method: 'POST', path: '/api/ingest' });
});

check('parseEndpoint accepts a bare path and defaults to GET', () => {
  assert.deepStrictEqual(parseEndpoint('/api/ingest'),
    { method: 'GET', path: '/api/ingest' });
});

check('parseEndpoint normalises a lowercase verb', () => {
  assert.strictEqual(parseEndpoint('get /api/x').method, 'GET');
});

check('parseEndpoint tolerates extra whitespace', () => {
  assert.deepStrictEqual(parseEndpoint('  GET    /api/x  '),
    { method: 'GET', path: '/api/x' });
});

check('parseEndpoint throws on non-string and empty input', () => {
  assert.throws(() => parseEndpoint(undefined), TypeError);
  assert.throws(() => parseEndpoint(42), TypeError);
  assert.throws(() => parseEndpoint('   '), TypeError);
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

check('buildUrl normalises a trailing slash on the base', () => {
  assert.strictEqual(buildUrl('https://example.com/', '/api/x'), 'https://example.com/api/x');
  assert.strictEqual(buildUrl('https://example.com///', '/api/x'), 'https://example.com/api/x');
});

check('buildUrl adds a missing leading slash on the path', () => {
  assert.strictEqual(buildUrl('https://example.com', 'api/x'), 'https://example.com/api/x');
});

check('buildUrl throws on a scheme-less base', () => {
  assert.throws(() => buildUrl('example.com', '/api/x'));
});

check('buildUrl throws on an empty base', () => {
  assert.throws(() => buildUrl('', '/api/x'), TypeError);
});

check('buildUrl preserves the query string verbatim', () => {
  assert.strictEqual(
    buildUrl('https://example.com', '/api/leads?brand=cogmap&limit=1000'),
    'https://example.com/api/leads?brand=cogmap&limit=1000');
});

// ---------------------------------------------------------------------------
// The exact regression: apps.yaml's own healthCheckTemplate format
// ---------------------------------------------------------------------------

check("apps.yaml's healthCheckTemplate format produces a valid URL", () => {
  // Verbatim from apps.yaml with {{tenant}} substituted -- the precise input
  // that produced "https://hostGET /api/leads?..." before this fix.
  const endpoint = 'GET /api/leads?brand=cogmap&limit=1';
  const { path } = parseEndpoint(endpoint);
  const url = buildUrl('https://salesleadgenerator.vercel.app', path);
  assert.strictEqual(url, 'https://salesleadgenerator.vercel.app/api/leads?brand=cogmap&limit=1');
  assert.doesNotMatch(url, /\s/, 'URL contains whitespace -- the verb was not stripped');
});

check('both verifiers parse the same endpoint identically', () => {
  const endpoint = 'GET /api/ingest';
  // Same shared module, so this asserts they are actually wired to it.
  assert.strictEqual(
    typeof listBased.healthCheck, 'function');
  assert.strictEqual(
    typeof responseBased.healthCheck, 'function');
  assert.deepStrictEqual(parseEndpoint(endpoint), { method: 'GET', path: '/api/ingest' });
});

// ---------------------------------------------------------------------------
// healthCheck failure classification (local stub server, no network)
// ---------------------------------------------------------------------------

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const ok = await startServer((req, res) => {
    if (req.url.startsWith('/api/leads')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ leads: [] }));
      return;
    }
    if (req.url === '/api/slow') {
      setTimeout(() => { res.writeHead(200); res.end('{}'); }, 5000);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const base = `http://127.0.0.1:${ok.address().port}`;

  await checkAsync('healthCheck reports healthy against a reachable endpoint', async () => {
    const r = await listBased.healthCheck({
      apiBase: base, endpoint: 'GET /api/leads?brand=cogmap&limit=1', apiKey: 'k',
    });
    assert.strictEqual(r.healthy, true, `expected healthy, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.failure, null);
    assert.match(r.url, /\/api\/leads\?brand=cogmap&limit=1$/);
  });

  await checkAsync('healthCheck classifies an unexpected status', async () => {
    const r = await listBased.healthCheck({
      apiBase: base, endpoint: 'GET /api/nope', apiKey: 'k',
    });
    assert.strictEqual(r.healthy, false);
    assert.strictEqual(r.failure, 'unexpected-status');
    assert.strictEqual(r.status, 404);
  });

  await checkAsync('healthCheck classifies a malformed apiBase as configuration', async () => {
    const r = await listBased.healthCheck({
      apiBase: 'not-a-url', endpoint: 'GET /api/leads', apiKey: 'k',
    });
    assert.strictEqual(r.failure, 'configuration');
    assert.strictEqual(r.status, 0);
  });

  await checkAsync('healthCheck classifies a non-string endpoint as configuration', async () => {
    const r = await listBased.healthCheck({ apiBase: base, endpoint: null, apiKey: 'k' });
    assert.strictEqual(r.failure, 'configuration');
  });

  await checkAsync('healthCheck classifies an unreachable host as network', async () => {
    const r = await listBased.healthCheck({
      apiBase: 'http://127.0.0.1:1', endpoint: 'GET /api/leads', apiKey: 'k', timeoutMs: 3000,
    });
    assert.strictEqual(r.failure, 'network');
  });

  await checkAsync('healthCheck enforces its timeout', async () => {
    const r = await listBased.healthCheck({
      apiBase: base, endpoint: 'GET /api/slow', apiKey: 'k', timeoutMs: 250,
    });
    assert.strictEqual(r.failure, 'timeout');
    assert.match(r.error, /timed out after 250ms/);
  });

  await checkAsync('healthCheck never exposes the api key in the returned url', async () => {
    const r = await listBased.healthCheck({
      apiBase: base, endpoint: 'GET /api/leads?brand=cogmap&limit=1', apiKey: 'secret-key-value',
    });
    assert.doesNotMatch(r.url || '', /secret-key-value/);
  });

  await checkAsync('response-based healthCheck also strips the verb', async () => {
    const r = await responseBased.healthCheck({
      apiBase: base, endpoint: 'GET /api/leads?brand=x&limit=1', apiKey: 'k',
    });
    assert.strictEqual(r.healthy, true, `expected healthy, got ${JSON.stringify(r)}`);
    assert.doesNotMatch(r.url, /\s/);
  });

  await checkAsync('response-based healthCheck classifies a malformed base', async () => {
    const r = await responseBased.healthCheck({
      apiBase: 'nope', endpoint: 'GET /api/ingest', apiKey: 'k',
    });
    assert.strictEqual(r.failure, 'configuration');
  });

  await checkAsync('verifyViaList encodes the brand parameter', async () => {
    // A brand containing & would otherwise inject a query parameter into a
    // request carrying SLG_API_KEY.
    let seenUrl = null;
    const spy = await startServer((req, res) => {
      seenUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ leads: [] }));
    });
    const spyBase = `http://127.0.0.1:${spy.address().port}`;
    await listBased.verifyViaList({
      apiBase: spyBase, brand: 'a&admin=1', recordId: 'x', collectionType: 'leads', apiKey: 'k',
    });
    spy.close();
    assert.ok(seenUrl.includes('brand=a%26admin%3D1'),
      `brand was not encoded: ${seenUrl}`);
  });

  ok.close();

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
})();

#!/usr/bin/env node
// Pure-logic regression test for lib/api-auth.ts's requireApiKey() (issue #3).
// Loads the real source with next/server's NextResponse swapped for a minimal
// local shim (a thin JSON-Response wrapper -- all requireApiKey actually uses),
// so this runs without a live Next.js server or MongoDB, matching this repo's
// existing scripts/verify-schema-mapper.js convention (pure logic, no network).
//
// Run with: node --experimental-strip-types scripts/verify-api-auth.js
// (the temp module it loads is real TypeScript; Node's built-in type-stripping
// needs the flag on Node 22 -- confirm still required on whatever Node version
// is running this before assuming the flag is obsolete.)

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
}

const SHIM = `
class NextResponse extends Response {
  static json(body, init) {
    return new NextResponse(JSON.stringify(body), {
      ...(init || {}),
      headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
    });
  }
}
`;

async function loadFreshModule(envOverrides) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-auth.ts'), 'utf8');
  const rewritten = source.replace(
    "import { NextResponse } from 'next/server'",
    SHIM
  );
  const tmpFile = path.join(os.tmpdir(), `api-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(tmpFile, rewritten);
  // Deliberately leave envOverrides applied after returning: requireApiKey()
  // reads process.env.NODE_ENV live at call time, so the caller invokes it
  // (synchronously, right after this resolves) before the *next* test case
  // overwrites these values again. Only the temp file is cleaned up here.
  Object.assign(process.env, envOverrides);
  try {
    return await import(`file://${tmpFile}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function main() {
  console.log('=== lib/api-auth.ts requireApiKey() regression (issue #3) ===\n');

  // Case 1: no ADMIN_API_KEY configured, non-production -- fail open.
  {
    const { requireApiKey } = await loadFreshModule({ ADMIN_API_KEY: '', NODE_ENV: 'development' });
    const result = requireApiKey(new Request('http://x/api/admin/tenants'));
    if (result === null) ok('unset key + non-production: request passes through (dev/test convenience)');
    else fail('unset key + non-production should pass through', `got status ${result && result.status}`);
  }

  // Case 2: no ADMIN_API_KEY configured, production -- fail closed.
  {
    const { requireApiKey } = await loadFreshModule({ ADMIN_API_KEY: '', NODE_ENV: 'production' });
    const result = requireApiKey(new Request('http://x/api/admin/tenants'));
    if (result && result.status === 401) ok('unset key + production: fails closed with 401 (misconfiguration must not silently disable auth)');
    else fail('unset key + production should fail closed with 401', result ? `got status ${result.status}` : 'got null (request would have passed through)');
  }

  // Case 3: configured key, correct header -- passes.
  {
    const { requireApiKey } = await loadFreshModule({ ADMIN_API_KEY: 'secret-value', NODE_ENV: 'production' });
    const result = requireApiKey(new Request('http://x/api/admin/tenants', { headers: { 'x-api-key': 'secret-value' } }));
    if (result === null) ok('configured key + correct x-api-key header: passes');
    else fail('configured key + correct header should pass', `got status ${result && result.status}`);
  }

  // Case 4: configured key, missing header -- rejected.
  {
    const { requireApiKey } = await loadFreshModule({ ADMIN_API_KEY: 'secret-value', NODE_ENV: 'production' });
    const result = requireApiKey(new Request('http://x/api/admin/tenants'));
    if (result && result.status === 401) ok('configured key + missing x-api-key header: rejected with 401');
    else fail('missing header should be rejected with 401', result ? `got status ${result.status}` : 'got null');
  }

  // Case 5: configured key, wrong header value -- rejected.
  {
    const { requireApiKey } = await loadFreshModule({ ADMIN_API_KEY: 'secret-value', NODE_ENV: 'production' });
    const result = requireApiKey(new Request('http://x/api/admin/tenants', { headers: { 'x-api-key': 'wrong-value' } }));
    if (result && result.status === 401) ok('configured key + wrong x-api-key header: rejected with 401');
    else fail('wrong header value should be rejected with 401', result ? `got status ${result.status}` : 'got null');
  }

  console.log(`\n${passed} check(s) passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main();

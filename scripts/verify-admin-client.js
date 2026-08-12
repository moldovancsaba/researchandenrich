#!/usr/bin/env node
/**
 * Standalone regression check for the admin API client.
 *
 * Replaces a design in which every admin fetch sent
 * process.env.NEXT_PUBLIC_SLG_API_KEY -- a value Next.js inlines into the
 * client bundle, so the page published its own credential -- and the queue page
 * sent nothing at all.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  stateForResponse, isRetryable, adminPath, adminFetch, SessionEnded, AdminRequestFailed,
} = require('../lib/admin-client.ts');
const { codeOnly } = require('./verify-helpers');

let passed = 0;
function check(label, fn) {
  try { const r = fn(); if (r && r.then) throw new Error('async check used sync runner'); passed++; console.log(`  ok  ${label}`); }
  catch (err) { console.error(`FAIL  ${label}\n      ${err.message}`); process.exitCode = 1; }
}
async function checkAsync(label, fn) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (err) { console.error(`FAIL  ${label}\n      ${err.message}`); process.exitCode = 1; }
}

// --- state mapping ---------------------------------------------------------

check('401 missing_credential WITH a session maps to expired, not invalid', () => {
  // Conflating them would tell the operator their key is wrong when it is
  // merely stale.
  const s = stateForResponse(401, { code: 'missing_credential' }, true, null);
  assert.strictEqual(s.status, 'expired');
});

check('401 missing_credential WITHOUT a session maps to signed-out', () => {
  const s = stateForResponse(401, { code: 'missing_credential' }, false, null);
  assert.strictEqual(s.status, 'signed-out');
});

check('401 invalid_credential maps to invalid and carries the server message', () => {
  const s = stateForResponse(401, { code: 'invalid_credential', message: 'nope' }, false, null);
  assert.strictEqual(s.status, 'invalid');
  assert.strictEqual(s.message, 'nope');
});

check('429 maps to rate-limited and reads Retry-After', () => {
  const s = stateForResponse(429, { message: 'slow down' }, true, '900');
  assert.strictEqual(s.status, 'rate-limited');
  assert.strictEqual(s.retryAfterSeconds, 900);
});

check('429 with a missing or junk Retry-After still yields a positive wait', () => {
  for (const h of [null, '', 'soon']) {
    const s = stateForResponse(429, {}, true, h);
    assert.ok(s.retryAfterSeconds > 0, `non-positive wait for ${JSON.stringify(h)}`);
  }
});

check('503 maps to misconfigured', () => {
  assert.strictEqual(stateForResponse(503, {}, true, null).status, 'misconfigured');
});

check('4xx that are not auth failures produce no auth state', () => {
  // A 400 or 404 must surface as a request failure, not sign the operator out.
  for (const status of [400, 404, 409, 422, 500]) {
    assert.strictEqual(stateForResponse(status, {}, true, null), null, `status ${status}`);
  }
});

check('only service-level failures are retryable', () => {
  assert.strictEqual(isRetryable({ status: 'misconfigured', message: '' }), true);
  assert.strictEqual(isRetryable({ status: 'offline', message: '' }), true);
  // Retrying a rejected credential is pointless and looks like probing.
  assert.strictEqual(isRetryable({ status: 'invalid', message: '' }), false);
  assert.strictEqual(isRetryable({ status: 'expired' }), false);
});

// --- path building ---------------------------------------------------------

check('adminPath encodes every segment', () => {
  assert.strictEqual(adminPath('tenants', 'cog map'), '/api/admin/tenants/cog%20map');
  assert.strictEqual(adminPath('tenants', 'a/b'), '/api/admin/tenants/a%2Fb');
  assert.strictEqual(adminPath('tenants', 'a?x=1'), '/api/admin/tenants/a%3Fx%3D1');
});

// --- request behaviour -----------------------------------------------------

(async () => {
  await checkAsync('every request sends credentials so the cookie travels', async () => {
    let seen = null;
    const fetchImpl = async (p, init) => { seen = init; return new Response('{}', { status: 200 }); };
    await adminFetch('/api/admin/tenants', {}, {
      fetchImpl, hadSession: () => true, setAuthState: () => {},
    });
    assert.strictEqual(seen.credentials, 'same-origin');
  });

  await checkAsync('a session-ending failure throws SessionEnded carrying the original request', async () => {
    // The carried request is what lets an in-flight edit be replayed after
    // re-auth instead of being silently discarded.
    const fetchImpl = async () => new Response(JSON.stringify({ code: 'missing_credential' }), { status: 401 });
    const init = { method: 'PUT', body: '{"displayName":"X"}' };
    await assert.rejects(
      () => adminFetch('/api/admin/tenants/cogmap', init, {
        fetchImpl, hadSession: () => true, setAuthState: () => {},
      }),
      (err) => {
        assert.ok(err instanceof SessionEnded);
        assert.strictEqual(err.path, '/api/admin/tenants/cogmap');
        assert.strictEqual(err.init.body, '{"displayName":"X"}');
        return true;
      }
    );
  });

  await checkAsync('a non-auth failure throws AdminRequestFailed, not SessionEnded', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ code: 'unknown_field' }), { status: 400 });
    await assert.rejects(
      () => adminFetch('/api/admin/tenants', {}, {
        fetchImpl, hadSession: () => true, setAuthState: () => {},
      }),
      (err) => err instanceof AdminRequestFailed && err.status === 400
    );
  });

  await checkAsync('a network failure maps to offline rather than throwing raw', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    let state = null;
    await assert.rejects(
      () => adminFetch('/api/admin/tenants', {}, {
        fetchImpl, hadSession: () => true, setAuthState: (s) => { state = s; },
      }),
      (err) => err instanceof SessionEnded
    );
    assert.strictEqual(state.status, 'offline');
  });

  // --- structural: the credential must not come back ------------------------

  const clientFiles = ['app/admin/page.tsx', 'app/admin/queue/page.tsx',
                       'app/admin/components/AdminAuthGate.tsx',
                       'app/admin/components/Providers.tsx'];

  check('no client component references a NEXT_PUBLIC credential', () => {
    for (const f of clientFiles) {
      const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), '');
      assert.ok(!/NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN)/.test(src),
        `${f} references a NEXT_PUBLIC credential`);
    }
  });

  check('every admin fetch in client components sends credentials', () => {
    for (const f of ['app/admin/page.tsx', 'app/admin/queue/page.tsx']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const fetches = (src.match(/fetch\(/g) || []).length;
      const creds = (src.match(/credentials: 'same-origin'/g) || []).length;
      assert.ok(fetches > 0, `${f} has no fetch calls -- parser may be wrong`);
      assert.strictEqual(creds, fetches,
        `${f}: ${fetches} fetch calls but ${creds} send credentials`);
    }
  });

  check('the admin surface is mounted inside GdsProvider', () => {
    const providers = fs.readFileSync(
      path.join(__dirname, '..', 'app/admin/components/Providers.tsx'), 'utf8');
    assert.match(providers, /GdsProvider/);
    assert.match(providers, /@sovereignsquad\/gds-theme/);
    const layout = fs.readFileSync(path.join(__dirname, '..', 'app/admin/layout.tsx'), 'utf8');
    assert.match(layout, /<Providers>/, 'Providers is imported but never rendered');
  });

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) { console.error('FAILURES ABOVE'); process.exit(1); }
})();

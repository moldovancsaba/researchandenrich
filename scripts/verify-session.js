#!/usr/bin/env node
/**
 * Standalone regression check for admin session tokens.
 *
 * The session exists because the previous design authenticated the browser with
 * NEXT_PUBLIC_SLG_API_KEY, which Next.js inlines into the client bundle -- the
 * page published its own key. The token here is opaque, carries no credential
 * material, and cannot be replayed against the x-api-key header path.
 */

const assert = require('assert');
const {
  createSession, verifySession, serializeSessionCookie, clearSessionCookie,
  readSessionCookie, SESSION_COOKIE, SESSION_TTL_SECONDS,
} = require('../lib/session.ts');

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (err) { console.error(`FAIL  ${label}\n      ${err.message}`); process.exitCode = 1; }
}

const SECRET = 'session-secret-value-32-bytes-long!!';
const NOW = 1_800_000_000;

check('a freshly issued token verifies', () => {
  const { token } = createSession(SECRET, NOW);
  const r = verifySession(token, SECRET, NOW);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.payload.sub, 'operator');
});

check('the token carries no credential material', () => {
  const { token } = createSession(SECRET, NOW);
  const decoded = Buffer.from(token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString();
  assert.ok(!decoded.includes(SECRET), 'session secret leaked into the token');
  assert.ok(!token.includes(SECRET));
  // Only the four documented fields.
  assert.deepStrictEqual(Object.keys(JSON.parse(decoded)).sort(), ['exp','iat','jti','sub']);
});

check('a token signed with a different secret is rejected', () => {
  const { token } = createSession('another-secret-entirely-abcdefghij', NOW);
  assert.deepStrictEqual(verifySession(token, SECRET, NOW), { ok: false, reason: 'bad_signature' });
});

check('a tampered payload is rejected', () => {
  const { token } = createSession(SECRET, NOW);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    sub: 'operator', iat: NOW, exp: NOW + 999999, jti: 'x',
  })).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  assert.strictEqual(verifySession(`${forged}.${sig}`, SECRET, NOW).ok, false);
});

check('an expired token is rejected exactly at exp', () => {
  const { token, payload } = createSession(SECRET, NOW, 100);
  assert.strictEqual(verifySession(token, SECRET, payload.exp - 1).ok, true);
  assert.deepStrictEqual(verifySession(token, SECRET, payload.exp), { ok: false, reason: 'expired' });
});

check('signature is checked before expiry', () => {
  // A forged token must not learn whether its payload would otherwise be in date.
  const { token } = createSession('wrong-secret-wrong-secret-wrong!!', NOW - 100000);
  assert.strictEqual(verifySession(token, SECRET, NOW).reason, 'bad_signature');
});

check('malformed input is rejected without throwing', () => {
  for (const t of [null, undefined, 42, '', 'no-dot', 'a.b.c', {}, []]) {
    assert.doesNotThrow(() => verifySession(t, SECRET, NOW), `threw for ${JSON.stringify(t)}`);
    assert.strictEqual(verifySession(t, SECRET, NOW).ok, false);
  }
});

check('a non-JSON payload is rejected', () => {
  const body = Buffer.from('not json').toString('base64').replace(/=+$/,'');
  const crypto = require('node:crypto');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  assert.strictEqual(verifySession(`${body}.${sig}`, SECRET, NOW).reason, 'malformed');
});

check('an unconfigured secret rejects rather than accepting anything', () => {
  const { token } = createSession(SECRET, NOW);
  for (const s of ['', '   ', undefined]) {
    assert.deepStrictEqual(verifySession(token, s, NOW), { ok: false, reason: 'unconfigured' });
  }
});

check('each session gets a distinct jti', () => {
  const a = createSession(SECRET, NOW).payload.jti;
  const b = createSession(SECRET, NOW).payload.jti;
  assert.notStrictEqual(a, b);
});

check('default TTL is 8 hours', () => {
  const { payload } = createSession(SECRET, NOW);
  assert.strictEqual(payload.exp - payload.iat, SESSION_TTL_SECONDS);
  assert.strictEqual(SESSION_TTL_SECONDS, 8 * 60 * 60);
});

// --- cookie ---------------------------------------------------------------

check('the cookie is HttpOnly, SameSite=Strict, Path=/ with an explicit Max-Age', () => {
  const c = serializeSessionCookie('tok', 100, { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);   // the CSRF control for state-changing routes
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=100/);
  assert.match(c, /Secure/);
});

check('Secure is omitted only when explicitly disabled', () => {
  // Browsers reject Secure cookies on http://localhost; without this, local
  // development could not authenticate at all.
  assert.ok(!serializeSessionCookie('tok', 100, { secure: false }).includes('Secure'));
});

check('clearing the cookie sets Max-Age=0', () => {
  assert.match(clearSessionCookie({ secure: true }), /Max-Age=0/);
});

check('readSessionCookie finds its cookie among others and ignores empties', () => {
  assert.strictEqual(readSessionCookie(`a=1; ${SESSION_COOKIE}=tok.en; b=2`), 'tok.en');
  assert.strictEqual(readSessionCookie('a=1; b=2'), null);
  assert.strictEqual(readSessionCookie(`${SESSION_COOKIE}=`), null);
  assert.strictEqual(readSessionCookie(null), null);
});

// --- route wiring ----------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./verify-helpers');
const routeSrc = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'admin', 'session', 'route.ts'), 'utf8'),
  'safeEqual');

check('the session route does NOT call requireApiKey', () => {
  // It is the path by which authorization is obtained; gating it would make
  // sign-in impossible.
  assert.ok(!/requireApiKey/.test(routeSrc));
});

check('the session route compares in constant time', () => {
  assert.match(routeSrc, /safeEqual\(/);
  assert.ok(!/presented === secret/.test(routeSrc), 'naive equality comparison');
});

check('the sign-in path is covered by the strict rate-limit bucket', () => {
  const { bucketFor } = require('../lib/rate-limit.ts');
  assert.strictEqual(bucketFor('/api/admin/session', 'POST').name, 'signin');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) { console.error('FAILURES ABOVE'); process.exit(1); }

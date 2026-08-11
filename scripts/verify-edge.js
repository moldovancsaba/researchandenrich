#!/usr/bin/env node
/**
 * Standalone regression check for the edge hardening layer.
 *
 * The application set NO security headers and applied NO rate limit anywhere.
 * There was also no place to express either: no next.config.js, an empty
 * vercel.json, no middleware.
 */

const assert = require('assert');
const {
  checkLimit, clientKey, bucketFor, retryAfterText, resetLimiter, buckets,
} = require('../lib/rate-limit.ts');
const {
  securityHeaders, buildCsp, policyFromEnv, SECURITY_HEADER_NAMES,
} = require('../lib/security-headers.ts');

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (err) { console.error(`FAIL  ${label}\n      ${err.message}`); process.exitCode = 1; }
}
const headers = (m = {}) => ({ get: (n) => m[n.toLowerCase()] ?? null });

// --- limiter ---------------------------------------------------------------

check('allows exactly `limit` requests then denies', () => {
  resetLimiter();
  const b = { name: 't', limit: 3, windowMs: 1000 };
  const outcomes = [1, 2, 3, 4].map(() => checkLimit(b, 'ip', 1000).allowed);
  assert.deepStrictEqual(outcomes, [true, true, true, false]);
});

check('remaining decreases and floors at zero', () => {
  resetLimiter();
  const b = { name: 't2', limit: 2, windowMs: 1000 };
  assert.strictEqual(checkLimit(b, 'ip', 0).remaining, 1);
  assert.strictEqual(checkLimit(b, 'ip', 0).remaining, 0);
  assert.strictEqual(checkLimit(b, 'ip', 0).remaining, 0);
});

check('the window rolls over and resets the counter', () => {
  resetLimiter();
  const b = { name: 't3', limit: 1, windowMs: 1000 };
  assert.strictEqual(checkLimit(b, 'ip', 0).allowed, true);
  assert.strictEqual(checkLimit(b, 'ip', 500).allowed, false);
  assert.strictEqual(checkLimit(b, 'ip', 1000).allowed, true, 'window did not roll over');
});

check('resetMs decreases monotonically within a window', () => {
  resetLimiter();
  const b = { name: 't4', limit: 10, windowMs: 1000 };
  checkLimit(b, 'ip', 0);
  assert.ok(checkLimit(b, 'ip', 400).resetMs > checkLimit(b, 'ip', 700).resetMs);
});

check('separate client keys hold separate counters', () => {
  resetLimiter();
  const b = { name: 't5', limit: 1, windowMs: 1000 };
  assert.strictEqual(checkLimit(b, 'a', 0).allowed, true);
  assert.strictEqual(checkLimit(b, 'b', 0).allowed, true, 'buckets leaked across clients');
  assert.strictEqual(checkLimit(b, 'a', 0).allowed, false);
});

check('clientKey falls back x-forwarded-for -> x-real-ip -> unknown', () => {
  assert.strictEqual(clientKey(headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
  assert.strictEqual(clientKey(headers({ 'x-real-ip': '9.9.9.9' })), '9.9.9.9');
  assert.strictEqual(clientKey(headers()), 'unknown');
  // Unattributable traffic shares one bucket on purpose: hiding your origin
  // must not earn a fresh quota.
  assert.strictEqual(clientKey(headers({ 'x-forwarded-for': '  ' })), 'unknown');
});

// --- bucket routing --------------------------------------------------------

check('/api/health is never rate limited', () => {
  assert.strictEqual(bucketFor('/api/health', 'GET'), null);
  assert.strictEqual(bucketFor('/api/health', 'POST'), null);
});

check('the sign-in route gets the strict bucket', () => {
  assert.strictEqual(bucketFor('/api/admin/session', 'POST').name, 'signin');
});

check('admin writes are limited, admin reads are not', () => {
  assert.strictEqual(bucketFor('/api/admin/tenants', 'POST').name, 'admin-write');
  assert.strictEqual(bucketFor('/api/admin/tenants', 'DELETE').name, 'admin-write');
  assert.strictEqual(bucketFor('/api/admin/tenants', 'GET'), null);
});

check('non-admin paths are unlimited', () => {
  assert.strictEqual(bucketFor('/', 'GET'), null);
  assert.strictEqual(bucketFor('/admin', 'GET'), null);
});

check('sign-in defaults bound online guessing to ~20 attempts/hour', () => {
  const { signin } = buckets();
  const perHour = (signin.limit / signin.windowMs) * 3_600_000;
  assert.ok(perHour <= 25, `${perHour} attempts/hour is too permissive`);
});

check('retryAfterText renders a duration, not an epoch', () => {
  assert.strictEqual(retryAfterText(1000), '1 second');
  assert.strictEqual(retryAfterText(30_000), '30 seconds');
  assert.strictEqual(retryAfterText(14 * 60_000), '14 minutes');
  assert.match(retryAfterText(0), /second/, 'must never render a zero or negative wait');
});

// --- headers ---------------------------------------------------------------

check('every documented security header is present', () => {
  const h = securityHeaders('abc', policyFromEnv());
  for (const name of SECURITY_HEADER_NAMES) {
    assert.ok(h[name], `${name} missing`);
  }
});

check('CSP is report-only by default and enforceable by configuration', () => {
  const reportOnly = securityHeaders('abc', { cspReportOnly: true, hstsMaxAge: 1, hstsPreload: false });
  assert.ok(reportOnly['Content-Security-Policy-Report-Only']);
  assert.ok(!reportOnly['Content-Security-Policy']);

  const enforced = securityHeaders('abc', { cspReportOnly: false, hstsMaxAge: 1, hstsPreload: false });
  assert.ok(enforced['Content-Security-Policy']);
});

check('script-src permits neither unsafe-inline nor unsafe-eval', () => {
  const csp = buildCsp('abc');
  const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'));
  assert.ok(!scriptSrc.includes('unsafe-inline'), 'script-src allows unsafe-inline');
  assert.ok(!scriptSrc.includes('unsafe-eval'), 'script-src allows unsafe-eval');
  assert.ok(scriptSrc.includes("'nonce-abc'"), 'nonce not applied to script-src');
});

check('the CSP allows the mandated ImgBB image host', () => {
  // classscout provider records must use i.ibb.co; blocking it would break
  // image previews in the admin surface.
  assert.match(buildCsp('n'), /img-src[^;]*https:\/\/i\.ibb\.co/);
});

check('framing and object embedding are denied', () => {
  const csp = buildCsp('n');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

check('HSTS ships short and without preload by default', () => {
  // preload is difficult to reverse; the long value is only appropriate once
  // no HTTP-only dependency remains.
  const h = securityHeaders('n', policyFromEnv());
  const hsts = h['Strict-Transport-Security'];
  const maxAge = Number(hsts.match(/max-age=(\d+)/)[1]);
  assert.ok(maxAge <= 86400, `max-age ${maxAge} is a long-term commitment by default`);
  assert.ok(!hsts.includes('preload'), 'preload enabled by default');
});

check('a distinct nonce produces a distinct policy', () => {
  assert.notStrictEqual(buildCsp('a'), buildCsp('b'));
});

// --- middleware wiring -----------------------------------------------------

const fs = require('fs');
const path = require('path');
const mw = fs.readFileSync(path.join(__dirname, '..', 'middleware.ts'), 'utf8');

check('middleware excludes static assets from the matcher', () => {
  assert.match(mw, /_next\/static/);
});

check('middleware performs no I/O on the request path', () => {
  // It runs on every non-static request; an await on I/O here would be a
  // latency regression on every page load.
  assert.ok(!/await\s+(fetch|getDb)/.test(mw), 'middleware performs I/O');
});

check('a rate-limited response carries Retry-After and the limit headers', () => {
  assert.match(mw, /["']Retry-After["']/);
  assert.match(mw, /X-RateLimit-Limit/);
  assert.match(mw, /X-RateLimit-Reset/);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) { console.error('FAILURES ABOVE'); process.exit(1); }

#!/usr/bin/env node
/**
 * Standalone regression check for admin authorization.
 *
 * Covers the defect that `lib/api-auth.ts` was `return null` — an
 * unconditional pass — while every admin route called it, and the second-order
 * defect that filling the stub in against NEXT_PUBLIC_SLG_API_KEY would have
 * been theatre, because Next.js inlines NEXT_PUBLIC_* into the client bundle.
 *
 * The structural check at the bottom is the load-bearing one: it enumerates
 * route files from the filesystem rather than a hand-maintained list, so a NEW
 * admin route that forgets the check fails here instead of shipping.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  decideAuth,
  safeEqual,
  extractCredential,
  extractSessionCookie,
  fingerprint,
} = require('../lib/auth-core.ts');

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

/** Minimal Headers stand-in; case-insensitive like the real thing. */
function headers(map = {}) {
  const lower = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

const SECRET = 'a'.repeat(43) + 'Z';
const ENABLED = { enabled: true, secret: SECRET };

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

check('a valid credential via x-api-key passes', () => {
  const d = decideAuth(headers({ 'x-api-key': SECRET }), ENABLED);
  assert.equal(d.outcome, 'pass');
  assert.equal(d.status, null);
});

check('a valid credential via Authorization: Bearer passes', () => {
  const d = decideAuth(headers({ authorization: `Bearer ${SECRET}` }), ENABLED);
  assert.equal(d.outcome, 'pass');
});

check('a missing credential is 401 missing_credential', () => {
  const d = decideAuth(headers(), ENABLED);
  assert.equal(d.status, 401);
  assert.equal(d.code, 'missing_credential');
});

check('an empty or whitespace-only header reads as missing, not invalid', () => {
  // The distinction matters: "provide a credential" is actionable, "your
  // credential was rejected" sends the operator looking for the wrong problem.
  for (const v of ['', '   ']) {
    const d = decideAuth(headers({ 'x-api-key': v }), ENABLED);
    assert.equal(d.code, 'missing_credential', `for ${JSON.stringify(v)}`);
  }
  const bearer = decideAuth(headers({ authorization: 'Bearer    ' }), ENABLED);
  assert.equal(bearer.code, 'missing_credential');
});

check('a wrong credential of the same length is 401 invalid_credential', () => {
  const wrong = 'b'.repeat(SECRET.length);
  assert.equal(wrong.length, SECRET.length);
  const d = decideAuth(headers({ 'x-api-key': wrong }), ENABLED);
  assert.equal(d.status, 401);
  assert.equal(d.code, 'invalid_credential');
});

check('a wrong credential of a different length is 401 invalid_credential', () => {
  const d = decideAuth(headers({ 'x-api-key': 'short' }), ENABLED);
  assert.equal(d.code, 'invalid_credential');
});

check('enforcement on with no configured secret is 503, never a pass', () => {
  for (const secret of ['', '   ']) {
    const d = decideAuth(headers({ 'x-api-key': SECRET }), { enabled: true, secret });
    assert.equal(d.status, 503, 'fails open on an unconfigured secret');
    assert.equal(d.code, 'auth_misconfigured');
  }
});

check('enforcement off passes and records a bypass outcome', () => {
  const d = decideAuth(headers(), { enabled: false, secret: SECRET });
  assert.equal(d.outcome, 'bypass');
  assert.equal(d.status, null);
});

check('x-api-key takes documented precedence over Authorization', () => {
  const d = decideAuth(
    headers({ 'x-api-key': SECRET, authorization: 'Bearer wrong-value-entirely' }),
    ENABLED
  );
  assert.equal(d.outcome, 'pass', 'precedence is order-dependent');
});

check('a surrounding-whitespace credential is trimmed before comparison', () => {
  const d = decideAuth(headers({ 'x-api-key': `  ${SECRET}\n` }), ENABLED);
  assert.equal(d.outcome, 'pass');
});

// ---------------------------------------------------------------------------
// Comparison and disclosure
// ---------------------------------------------------------------------------

check('safeEqual compares UTF-8 bytes, not UTF-16 code units', () => {
  // 'é' is 1 code unit but 2 bytes. A String.length guard would mis-handle it.
  assert.equal(safeEqual('é', 'é'), true);
  assert.equal(safeEqual('é', 'e'), false);
  assert.equal(safeEqual('日本', '日本'), true);
  assert.equal(safeEqual('日本', '日x'), false);
});

check('safeEqual returns false rather than throwing on unequal lengths', () => {
  // timingSafeEqual throws on mismatched buffers; the length guard must
  // short-circuit before it.
  assert.doesNotThrow(() => safeEqual('a', 'aaaaaaaa'));
  assert.equal(safeEqual('a', 'aaaaaaaa'), false);
});

check('no rejection message reveals why the credential failed', () => {
  const wrongLength = decideAuth(headers({ 'x-api-key': 'x' }), ENABLED);
  const wrongValue = decideAuth(
    headers({ 'x-api-key': 'b'.repeat(SECRET.length) }), ENABLED);
  assert.equal(wrongLength.message, wrongValue.message,
    'messages differ, leaking comparison detail');
  for (const d of [wrongLength, wrongValue]) {
    assert.ok(!d.message.includes('length'));
    assert.ok(!d.message.includes(SECRET));
  }
});

check('no decision ever carries the credential itself', () => {
  for (const d of [
    decideAuth(headers({ 'x-api-key': SECRET }), ENABLED),
    decideAuth(headers({ 'x-api-key': 'guess' }), ENABLED),
  ]) {
    assert.ok(!JSON.stringify(d).includes(SECRET));
    assert.ok(!JSON.stringify(d).includes('guess'));
  }
});

check('fingerprint is short, stable, and not reversible to the input', () => {
  const fp = fingerprint(SECRET);
  assert.equal(fp.length, 6);
  assert.equal(fp, fingerprint(SECRET));
  assert.notEqual(fp, fingerprint(`${SECRET}x`));
  assert.ok(!SECRET.includes(fp));
});

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

check('extractCredential handles absent, empty and malformed headers', () => {
  assert.equal(extractCredential(headers()), null);
  assert.equal(extractCredential(headers({ authorization: 'Basic abc' })), null);
  assert.equal(extractCredential(headers({ authorization: 'Bearer' })), null);
  assert.equal(extractCredential(headers({ authorization: 'Bearer x' })), 'x');
});

check('extractSessionCookie finds its cookie among others', () => {
  assert.equal(
    extractSessionCookie(headers({ cookie: 'a=1; rae_admin=tok.en; b=2' })),
    'tok.en');
  assert.equal(extractSessionCookie(headers({ cookie: 'a=1; b=2' })), null);
  assert.equal(extractSessionCookie(headers({ cookie: 'rae_admin=' })), null);
  assert.equal(extractSessionCookie(headers()), null);
});

// ---------------------------------------------------------------------------
// Structural coverage — the load-bearing check
// ---------------------------------------------------------------------------

const ADMIN_DIR = path.join(__dirname, '..', 'app', 'api', 'admin');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function routeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

const files = routeFiles(ADMIN_DIR);

check('admin route files are discovered (guards against a vacuous pass)', () => {
  // An enumeration bug returning [] would make every loop below pass silently —
  // the same failure mode as the anti-contamination gate this repo already fixed.
  assert.ok(files.length >= 5, `only found ${files.length} admin route files`);
});

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  const source = fs.readFileSync(file, 'utf8');

  check(`${rel} imports requireApiKey`, () => {
    assert.match(source, /requireApiKey/,
      'route file does not reference requireApiKey at all');
  });

  const exported = HTTP_METHODS.filter((m) =>
    new RegExp(`export\\s+(const|async\\s+function)\\s+${m}\\b`).test(source)
  );

  check(`${rel} exports at least one HTTP method`, () => {
    assert.ok(exported.length > 0, 'no HTTP method exports found — parser may be wrong');
  });

  for (const method of exported) {
    check(`${rel} ${method} calls requireApiKey before doing work`, () => {
      // Slice from the export to the next export (or EOF) and require the check
      // to appear before any database access in that handler.
      const start = source.search(
        new RegExp(`export\\s+(const|async\\s+function)\\s+${method}\\b`)
      );
      const rest = source.slice(start + 1);
      const nextExport = rest.search(/\nexport\s+(const|async\s+function)\s+[A-Z]/);
      const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

      const authAt = body.indexOf('requireApiKey');
      assert.notEqual(authAt, -1, `${method} does not call requireApiKey`);

      const dbAt = body.indexOf('getDb(');
      if (dbAt !== -1) {
        assert.ok(authAt < dbAt,
          `${method} acquires a database connection before authorizing`);
      }
    });
  }
}

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILURES ABOVE');
  process.exit(1);
}

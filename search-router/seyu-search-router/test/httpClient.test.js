import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  fetchWithRetry,
  readCapped,
  fetchFollowing,
  HttpError,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
} from '../src/httpClient.js';
import { buildAllowHost } from '../src/engines/restRunner.js';

/**
 * Bounds on outbound HTTP.
 *
 * This package is the only component in the system that fetches
 * attacker-influenceable content: search results are chosen by third-party
 * engines from the open web, and the router then reads whatever comes back.
 * Before these bounds it read bodies with an unbounded res.text() and followed
 * redirects with the default policy (up to 20 hops, no destination check).
 */

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const base = (server) => `http://127.0.0.1:${server.address().port}`;

test('a body under the cap is returned intact', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  try {
    const r = await fetchWithRetry(`${base(server)}/`, {}, { retries: 0 });
    assert.equal(r.bodyText, 'hello');
  } finally {
    server.close();
  }
});

test('a body exactly at the cap is accepted', async () => {
  const size = 1024;
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('a'.repeat(size));
  });
  try {
    const r = await fetchWithRetry(`${base(server)}/`, {}, { retries: 0, maxBodyBytes: size });
    assert.equal(r.bodyText.length, size);
  } finally {
    server.close();
  }
});

test('a body one byte over the cap is rejected as body_too_large', async () => {
  const size = 1024;
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('a'.repeat(size + 1));
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/`, {}, { retries: 0, maxBodyBytes: size }),
      (err) => err instanceof HttpError && err.type === 'body_too_large',
    );
  } finally {
    server.close();
  }
});

test('an oversized Content-Length is rejected before the body is read', async () => {
  let bytesWritten = 0;
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' });
    // Never actually send the payload; the declared length alone must trip it.
    res.end('short');
    bytesWritten += 5;
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/`, {}, { retries: 0, maxBodyBytes: 1024 }),
      (err) => err.type === 'body_too_large' && /declares 999999/.test(err.message),
    );
  } finally {
    server.close();
  }
});

test('an understated Content-Length cannot overflow the cap', async () => {
  // Documents a real boundary rather than asserting a defence we do not have:
  // the HTTP layer stops reading at the declared Content-Length, so a response
  // claiming fewer bytes than it sends is truncated before our counter ever
  // sees the excess. The streaming cap is what covers the case the transport
  // does NOT bound -- chunked responses with no declared length (below).
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
    res.end('a'.repeat(5000));
  });
  try {
    const r = await fetchWithRetry(`${base(server)}/`, {}, { retries: 0, maxBodyBytes: 1024 });
    assert.equal(r.bodyText.length, 10, 'transport did not truncate to Content-Length');
  } finally {
    server.close();
  }
});

test('a chunked response with no Content-Length is still capped', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
    for (let i = 0; i < 50; i++) res.write('a'.repeat(200));
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/`, {}, { retries: 0, maxBodyBytes: 1024 }),
      (err) => err.type === 'body_too_large',
    );
  } finally {
    server.close();
  }
});

test('multi-byte UTF-8 split across chunk boundaries decodes correctly', async () => {
  // Decoding per chunk instead of over the concatenated buffer would corrupt
  // any character straddling a read boundary -- real for non-English queries.
  const text = 'ünïcödé — 日本語 — Ελληνικά '.repeat(200);
  const server = await startServer((req, res) => {
    const buf = Buffer.from(text, 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    for (let i = 0; i < buf.length; i += 7) res.write(buf.subarray(i, i + 7));
    res.end();
  });
  try {
    const r = await fetchWithRetry(`${base(server)}/`, {}, { retries: 0 });
    assert.equal(r.bodyText, text);
    assert.ok(!r.bodyText.includes('�'), 'replacement character found — decode corrupted');
  } finally {
    server.close();
  }
});

test('body_too_large is not retried', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('a'.repeat(5000));
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/`, {}, { retries: 3, maxBodyBytes: 100 }),
    );
    assert.equal(hits, 1, `retried an oversized body ${hits} times`);
  } finally {
    server.close();
  }
});

test('a redirect chain within the bound is followed', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end(); return; }
    if (req.url === '/b') { res.writeHead(302, { location: '/c' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('arrived');
  });
  try {
    const r = await fetchWithRetry(`${base(server)}/a`, {}, { retries: 0, maxRedirects: 3 });
    assert.equal(r.bodyText, 'arrived');
  } finally {
    server.close();
  }
});

test('a redirect chain exceeding the bound is rejected', async () => {
  const server = await startServer((req, res) => {
    const n = Number(req.url.slice(1)) || 0;
    res.writeHead(302, { location: `/${n + 1}` });
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/0`, {}, { retries: 0, maxRedirects: 3 }),
      (err) => err.type === 'too_many_redirects',
    );
  } finally {
    server.close();
  }
});

test('a redirect to a non-HTTP scheme is blocked', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(302, { location: 'file:///etc/passwd' });
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(server)}/`, {}, { retries: 0 }),
      (err) => err.type === 'redirect_blocked' && /non-HTTP scheme/.test(err.message),
    );
  } finally {
    server.close();
  }
});

test('a redirect off a pinned origin is blocked', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(302, { location: 'http://example.com/exfiltrate' });
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchFollowing(`${base(server)}/`, {}, { allowHost: (h) => h === '127.0.0.1' }),
      (err) => err.type === 'redirect_blocked' && /example\.com/.test(err.message),
    );
  } finally {
    server.close();
  }
});

test('a same-origin redirect is allowed when a host pin is present', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end(); return; }
    res.writeHead(200); res.end('ok');
  });
  try {
    const res = await fetchFollowing(`${base(server)}/a`, {}, { allowHost: (h) => h === '127.0.0.1' });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('redirect_blocked is not retried', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(302, { location: 'file:///etc/passwd' });
    res.end();
  });
  try {
    await assert.rejects(() => fetchWithRetry(`${base(server)}/`, {}, { retries: 3 }));
    assert.equal(hits, 1, `retried a deterministic redirect failure ${hits} times`);
  } finally {
    server.close();
  }
});

test('buildAllowHost pins only configured self-hosted engines', () => {
  const selfHosted = { requiresConfig: ['baseUrl'] };
  const pin = buildAllowHost(selfHosted, { baseUrl: 'http://localhost:8080' });
  assert.equal(typeof pin, 'function');
  assert.equal(pin('localhost'), true);
  assert.equal(pin('evil.example'), false);

  // Public engines have hardcoded hosts and must stay unpinned.
  assert.equal(buildAllowHost({}, {}), undefined);
  // A self-hosted engine with no configured baseUrl cannot be pinned.
  assert.equal(buildAllowHost(selfHosted, {}), undefined);
  // A malformed baseUrl must not produce a predicate that rejects everything.
  assert.equal(buildAllowHost(selfHosted, { baseUrl: 'not a url' }), undefined);
});

test('existing timeout, 429 and non-retryable 4xx behaviour is unchanged', async () => {
  const slow = await startServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('late'); }, 3000);
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(slow)}/`, {}, { retries: 0, timeoutMs: 150 }),
      (err) => err.type === 'timeout',
    );
  } finally {
    slow.close();
  }

  let attempts = 0;
  const rate = await startServer((req, res) => {
    attempts++;
    res.writeHead(429, { 'retry-after': '0' });
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(rate)}/`, {}, { retries: 1 }),
      (err) => err.type === 'http_error' && err.status === 429,
    );
    assert.equal(attempts, 2, 'a 429 should be retried exactly once at retries: 1');
  } finally {
    rate.close();
  }

  let forbidden = 0;
  const auth = await startServer((req, res) => {
    forbidden++;
    res.writeHead(403);
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchWithRetry(`${base(auth)}/`, {}, { retries: 3 }),
      (err) => err.type === 'http_error' && err.status === 403,
    );
    assert.equal(forbidden, 1, 'a 403 must surface immediately, not be masked by retries');
  } finally {
    auth.close();
  }
});

test('the documented defaults are the ones actually applied', () => {
  assert.equal(MAX_BODY_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_REDIRECTS, 3);
});

test('readCapped returns an empty string for a body-less response', async () => {
  const server = await startServer((req, res) => { res.writeHead(204); res.end(); });
  try {
    const res = await fetch(`${base(server)}/`);
    assert.equal(await readCapped(res), '');
  } finally {
    server.close();
  }
});

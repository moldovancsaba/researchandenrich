export class HttpError extends Error {
  constructor(message, { type, status, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    // type: 'timeout' | 'http_error' | 'network_error'
    //     | 'body_too_large' | 'too_many_redirects' | 'redirect_blocked'
    this.type = type;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Outbound limits.
 *
 * MAX_BODY_BYTES is set against real payloads: the largest legitimate response
 * across the eleven engines is a Common Crawl or Wayback CDX index page, which
 * runs to low hundreds of kilobytes. 5 MiB is an order of magnitude above that,
 * so it bounds abuse without touching real traffic.
 *
 * MAX_REDIRECTS at 3 covers ordinary canonicalisation (http->https->www)
 * without permitting a long pivot chain.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

function parseRetryAfter(headers) {
  const val = headers.get('retry-after');
  if (!val) return null;
  const seconds = Number(val);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = new Date(val);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a response body with a hard byte cap, aborting mid-stream on breach.
 *
 * Reading fully and then measuring would already have allocated the memory the
 * cap exists to prevent. The Content-Length check is only a fast path: a
 * chunked or lying response is caught by the streaming counter regardless.
 *
 * TextDecoder is applied to the CONCATENATED buffer, not per chunk. Decoding
 * per chunk would corrupt any multi-byte character split across a read
 * boundary, which matters for a router serving non-English queries.
 */
export async function readCapped(res, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(
      `response body declares ${declared} bytes (cap ${maxBytes})`,
      { type: 'body_too_large', status: res.status },
    );
  }
  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {}); // stop pulling bytes immediately
        throw new HttpError(
          `response body exceeded ${maxBytes} bytes`,
          { type: 'body_too_large', status: res.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel */ }
  }
  return new TextDecoder().decode(concat(chunks, total));
}

/**
 * Follow redirects explicitly so each hop's destination can be inspected.
 *
 * `allowHost` is supplied only for CONFIGURED self-hosted engines (Fess, YaCy),
 * whose baseUrl typically points at localhost -- a redirect from one of those
 * to an external host is not legitimate behaviour and is a real SSRF pivot.
 * Public engines target hardcoded hosts and their redirects are ordinary web
 * behaviour, so pinning them would break real results.
 */
export async function fetchFollowing(url, fetchOpts = {}, { maxRedirects = MAX_REDIRECTS, allowHost } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, { ...fetchOpts, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get('location');
    if (!location) return res;

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new HttpError(`redirect to an unparseable location: ${location}`, {
        type: 'redirect_blocked',
      });
    }

    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      throw new HttpError(`redirect to non-HTTP scheme: ${next.protocol}`, {
        type: 'redirect_blocked',
      });
    }
    if (allowHost && !allowHost(next.hostname)) {
      throw new HttpError(`redirect to disallowed host: ${next.hostname}`, {
        type: 'redirect_blocked',
      });
    }
    current = next.toString();
  }
  throw new HttpError(`exceeded ${maxRedirects} redirects`, { type: 'too_many_redirects' });
}

/**
 * fetch() with a hard timeout, bounded retries on timeouts/network errors/429/5xx
 * (honoring Retry-After when present), and NO retry on other 4xx — because an
 * unexpected 401/403 on an engine documented as anonymous is itself an important
 * signal (the engine's operating assumptions may have changed) and should
 * surface immediately rather than being masked by a retry loop.
 *
 * body_too_large, too_many_redirects and redirect_blocked are likewise NOT
 * retried: they are deterministic, and retrying an oversized body simply
 * downloads it again.
 */
export async function fetchWithRetry(
  url,
  fetchOpts = {},
  { timeoutMs = 10000, retries = 1, backoffBaseMs = 500, maxBodyBytes = MAX_BODY_BYTES, maxRedirects = MAX_REDIRECTS, allowHost } = {},
) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;

    try {
      res = await fetchFollowing(
        url,
        { ...fetchOpts, signal: controller.signal },
        { maxRedirects, allowHost },
      );
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err; // redirect_blocked / too_many_redirects: deterministic
      lastErr = err.name === 'AbortError'
        ? new HttpError(`timeout after ${timeoutMs}ms`, { type: 'timeout' })
        : new HttpError(err.message, { type: 'network_error' });
      if (attempt < retries) {
        await sleep(backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (res.status === 429 || res.status >= 500) {
      clearTimeout(timer);
      const retryAfterMs = parseRetryAfter(res.headers);
      lastErr = new HttpError(`HTTP ${res.status}`, { type: 'http_error', status: res.status, retryAfterMs });
      if (attempt < retries) {
        await sleep(retryAfterMs ?? backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      clearTimeout(timer);
      // Other 4xx (401/403/404/...): don't retry, surface immediately.
      throw new HttpError(`HTTP ${res.status}`, { type: 'http_error', status: res.status });
    }

    try {
      const bodyText = await readCapped(res, maxBodyBytes);
      return { ok: true, status: res.status, headers: res.headers, bodyText };
    } finally {
      // Cleared only after the body is read: the timeout must bound the whole
      // exchange, not just the response headers.
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

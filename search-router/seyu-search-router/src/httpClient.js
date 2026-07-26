export class HttpError extends Error {
  constructor(message, { type, status, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    // type: 'timeout' | 'http_error' | 'network_error'
    this.type = type;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

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

/**
 * fetch() with a hard timeout, bounded retries on timeouts/network errors/429/5xx
 * (honoring Retry-After when present), and NO retry on other 4xx — because an
 * unexpected 401/403 on an engine documented as anonymous is itself an important
 * signal (the engine's operating assumptions may have changed) and should
 * surface immediately rather than being masked by a retry loop.
 */
export async function fetchWithRetry(url, fetchOpts = {}, { timeoutMs = 10000, retries = 1, backoffBaseMs = 500 } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;

    try {
      res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError'
        ? new HttpError(`timeout after ${timeoutMs}ms`, { type: 'timeout' })
        : new HttpError(err.message, { type: 'network_error' });
      if (attempt < retries) {
        await sleep(backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      const retryAfterMs = parseRetryAfter(res.headers);
      lastErr = new HttpError(`HTTP ${res.status}`, { type: 'http_error', status: res.status, retryAfterMs });
      if (attempt < retries) {
        await sleep(retryAfterMs ?? backoffBaseMs * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      // Other 4xx (401/403/404/...): don't retry, surface immediately.
      throw new HttpError(`HTTP ${res.status}`, { type: 'http_error', status: res.status });
    }

    const bodyText = await res.text();
    return { ok: true, status: res.status, headers: res.headers, bodyText };
  }

  throw lastErr;
}

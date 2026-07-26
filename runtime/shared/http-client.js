/**
 * Shared HTTP client for ContentCreator.
 * Used by worker runtime, verifier, and search router for all API calls.
 */

const DEFAULT_TIMEOUT_MS = 10000;  // 10 second default timeout
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/**
 * Fetch with timeout, retry/backoff, and 429 handling.
 *
 * @param {string} url
 * @param {object} options
 * @param {number} [options.timeoutMs=10000]
 * @param {object} [options.headers={}]
 * @param {string} [options.method='GET']
 * @param {object} [options.body]
 * @param {number} [options.maxRetries=3]
 * @returns {Promise<object>} Parsed JSON response
 */
async function httpClient(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    method = 'GET',
    body,
    maxRetries = MAX_RETRIES,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOptions = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      // Handle 429 rate limiting with backoff
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        const delay = Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
        if (attempt < maxRetries) {
          await sleep(delay);
          continue;
        }
        return { error: 'RATE_LIMITED', status: 429, retriesExhausted: true };
      }

      // Handle 5xx errors with retry
      if (response.status >= 500 && attempt < maxRetries) {
        const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        await sleep(delay);
        continue;
      }

      const data = await response.json();
      return { data, status: response.status };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;

      // Don't retry on abort (timeout)
      if (err.name === 'AbortError') {
        return { error: 'TIMEOUT', status: 0, message: err.message };
      }

      // Retry on network errors
      if (attempt < maxRetries) {
        const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        await sleep(delay);
        continue;
      }
    }
  }

  return { error: 'RETRIES_EXHAUSTED', message: lastError?.message, status: 0 };
}

/**
 * Sleep helper for backoff delays.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { httpClient };
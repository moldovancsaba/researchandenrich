/**
 * Response-based verification utilities, for tenants whose target API has no
 * ingest-credential-readable list/get endpoint to re-fetch against (classscout's
 * `/api/ingest` is write-only under `INGEST_API_KEY` -- its readable routes are
 * gated by a staff session or a publish-status filter, neither reachable with
 * the ingest credential). Unlike `list-based.js` (re-fetch a list and search it),
 * this verifies directly off the POST response's per-operation `{ok, error?}`
 * result -- `/api/ingest` returns that for every operation in the batch, so a
 * separate read-back call isn't needed (and isn't possible) to confirm a write.
 *
 * Auth header differs from list-based's `x-api-key` too: classscout's
 * `requireIngestKey` accepts `Authorization: Bearer <key>` or `X-Ingest-Key: <key>`.
 */

const { parseEndpoint, buildUrl } = require('../shared/endpoint');

/**
 * Verify a batch of `/api/ingest` operations from the POST response body.
 *
 * @param {object} params
 * @param {object} params.responseBody - Parsed JSON body of the POST /api/ingest response: { ok, results: [{index, ok, error?, data?}] }
 * @param {string[]} [params.expectedIds] - The `id` values submitted, in the same order as the operations. When
 *   provided, a `results` array shorter than `expectedIds` (the API silently dropping an operation) fails
 *   confirmation instead of `.every()` vacuously passing over whatever partial subset did come back.
 * @returns {object} Verification result with confirmed boolean and per-operation detail
 */
function verifyFromIngestResponse({ responseBody, expectedIds = [] }) {
  const results = Array.isArray(responseBody?.results) ? responseBody.results : [];
  const expectedCount = expectedIds.length > 0 ? expectedIds.length : results.length;

  const perOperation = results.map((r, i) => ({
    index: r.index ?? i,
    id: expectedIds[i] ?? null,
    confirmed: r.ok === true,
    error: r.ok === false ? r.error : null,
  }));

  const confirmedCount = perOperation.filter((r) => r.confirmed).length;

  return {
    confirmed: results.length > 0 && results.length === expectedCount && perOperation.every((r) => r.confirmed),
    confirmedCount,
    totalCount: perOperation.length,
    expectedCount,
    results: perOperation,
  };
}

/**
 * Quick health/capability check against classscout's ingest API.
 *
 * @param {object} params
 * @param {string} params.apiBase
 * @param {string} params.endpoint - e.g. "GET /api/ingest"
 * @param {string} params.apiKey - INGEST_API_KEY
 * @param {number} [params.expectedStatus=200]
 * @returns {Promise<object>} Health check result
 */
async function healthCheck({ apiBase, endpoint, apiKey, expectedStatus = 200, timeoutMs = 10000 }) {
  const startTime = Date.now();

  // Was a local replace(/^GET\s+/, ''), which silently fails on any non-GET
  // prefix. Shared with list-based.js so the two cannot drift again.
  let url;
  let method;
  try {
    const parsed = parseEndpoint(endpoint);
    method = parsed.method;
    url = buildUrl(apiBase, parsed.path);
  } catch (err) {
    return {
      healthy: false,
      status: 0,
      expectedStatus,
      durationMs: Date.now() - startTime,
      error: err.message,
      failure: 'configuration',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const healthy = response.status === expectedStatus;
    return {
      healthy,
      status: response.status,
      expectedStatus,
      durationMs: Date.now() - startTime,
      error: healthy ? null : `expected ${expectedStatus}, received ${response.status}`,
      failure: healthy ? null : 'unexpected-status',
      url,
    };
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err.name === 'AbortError';
    return {
      healthy: false,
      status: 0,
      expectedStatus,
      durationMs: Date.now() - startTime,
      error: timedOut ? `timed out after ${timeoutMs}ms` : err.message,
      failure: timedOut ? 'timeout' : 'network',
      url,
    };
  }
}

module.exports = { verifyFromIngestResponse, healthCheck };

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

/**
 * Verify a batch of `/api/ingest` operations from the POST response body.
 *
 * @param {object} params
 * @param {object} params.responseBody - Parsed JSON body of the POST /api/ingest response: { ok, results: [{index, ok, error?, data?}] }
 * @param {string[]} [params.expectedIds] - The `id` values submitted, in the same order as the operations, for reporting only
 * @returns {object} Verification result with confirmed boolean and per-operation detail
 */
function verifyFromIngestResponse({ responseBody, expectedIds = [] }) {
  const results = Array.isArray(responseBody?.results) ? responseBody.results : [];

  const perOperation = results.map((r, i) => ({
    index: r.index ?? i,
    id: expectedIds[i] ?? null,
    confirmed: r.ok === true,
    error: r.ok === false ? r.error : null,
  }));

  const confirmedCount = perOperation.filter((r) => r.confirmed).length;

  return {
    confirmed: results.length > 0 && perOperation.every((r) => r.confirmed),
    confirmedCount,
    totalCount: perOperation.length,
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
async function healthCheck({ apiBase, endpoint, apiKey, expectedStatus = 200 }) {
  const startTime = Date.now();
  const path = endpoint.replace(/^GET\s+/, '');

  try {
    const response = await fetch(apiBase + path, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
    });
    const duration = Date.now() - startTime;

    return {
      healthy: response.status === expectedStatus,
      status: response.status,
      expectedStatus,
      durationMs: duration,
      error: null,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      healthy: false,
      status: 0,
      expectedStatus,
      durationMs: duration,
      error: err.message,
    };
  }
}

module.exports = { verifyFromIngestResponse, healthCheck };

/**
 * List-based verification utilities for ContentCreator.
 *
 * All discovery and enrichment runs must use these functions.
 * Direct GET-by-ID endpoints (/api/leads/<id>, /api/programs/<id>)
 * are unreliable and must not be used for verification.
 */

const { parseEndpoint, buildUrl } = require('../shared/endpoint');

/**
 * Fetch a single record and verify the write succeeded
 * by using the list endpoint instead of direct GET-by-ID.
 *
 * @param {object} params
 * @param {string} params.apiBase - API base URL
 * @param {string} params.brand - Tenant ID (cogmap, seyu, classscout-api)
 * @param {string} params.recordId - The _id of the record just written/updated
 * @param {string} params.collectionType - 'leads' or 'programs'
 * @param {string} params.apiKey - The API key for x-api-key header
 * @returns {Promise<object>} Verification result with confirmed boolean and details
 */
async function verifyViaList({ apiBase, brand, recordId, collectionType, apiKey }) {
  // brand is encoded: an unencoded value containing & or = would inject query
  // parameters into a request that carries SLG_API_KEY.
  const path = collectionType === 'leads'
    ? `/api/leads?brand=${encodeURIComponent(brand)}&limit=1000`
    : `/api/programs?limit=100`;
  const url = buildUrl(apiBase, path);

  try {
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      return {
        confirmed: false,
        status: response.status,
        error: `HTTP ${response.status} on list verification`,
        recordId,
      };
    }

    const data = await response.json();
    const records = data?.data?.leads || data?.data?.programs || data?.leads || data?.programs || [];

    const record = records.find(r => {
      // Match by _id first (most stable), then by id field
      return (r._id && r._id === recordId) || (r.id && r.id === recordId);
    });

    return {
      confirmed: !!record,
      status: 'ok',
      totalRecords: records.length,
      matched: !!record,
      recordId,
      collectionType,
    };
  } catch (err) {
    return {
      confirmed: false,
      status: 'error',
      error: err.message,
      recordId,
    };
  }
}

/**
 * Verify multiple records exist in the system via list endpoint.
 * Used for batch verification after multiple writes in a single run.
 *
 * @param {object} params - Same as verifyViaList, but with an array of recordIds
 * @param {string[]} params.recordIds - Array of _id values to look for
 * @returns {Promise<object>} Verification result per record
 */
async function verifyBatchViaList({ apiBase, brand, recordIds, collectionType, apiKey }) {
  const results = [];
  for (const id of recordIds) {
    const result = await verifyViaList({ apiBase, brand, recordId: id, collectionType, apiKey });
    results.push(result);
  }

  const allConfirmed = results.every(r => r.confirmed);
  const confirmedCount = results.filter(r => r.confirmed).length;

  return {
    confirmed: allConfirmed,
    confirmedCount,
    totalCount: results.length,
    results,
  };
}

/**
 * Quick health check against the API.
 *
 * The `failure` discriminator matters: previously every failure mode collapsed
 * to `healthy: false`, so a malformed endpoint string and a genuine outage were
 * the same signal -- which is why this function's URL-construction bug survived.
 * `configuration` and `unexpected-status` are NOT retryable; `network` and
 * `timeout` are.
 *
 * @param {object} params
 * @param {string} params.apiBase
 * @param {string} params.endpoint - e.g. "GET /api/leads?brand=cogmap&limit=1"
 * @param {string} params.apiKey
 * @param {number} [params.expectedStatus=200]
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<object>} { healthy, status, expectedStatus, durationMs, error, failure, url }
 */
async function healthCheck({ apiBase, endpoint, apiKey, expectedStatus = 200, timeoutMs = 10000 }) {
  const startTime = Date.now();

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
        'x-api-key': apiKey,
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

module.exports = { verifyViaList, verifyBatchViaList, healthCheck };

/**
 * List-based verification utilities for ContentCreator.
 *
 * All discovery and enrichment runs must use these functions.
 * Direct GET-by-ID endpoints (/api/leads/<id>, /api/programs/<id>)
 * are unreliable and must not be used for verification.
 */

const VERIFICATION_ERRORS = new Set();

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
 * @param {number} params.expectedCount - Minimum expected count in list to confirm record exists
 * @returns {Promise<object>} Verification result with confirmed boolean and details
 */
async function verifyViaList({ apiBase, brand, recordId, collectionType, apiKey, expectedCount = 1 }) {
  const path = collectionType === 'leads' ? `/api/leads?brand=${brand}&limit=1000` : `/api/programs?limit=100`;
  const url = apiBase + path;

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
 * @param {object} params
 * @param {string} params.apiBase
 * @param {string} params.endpoint - e.g. GET /api/leads?brand=cogmap&limit=1
 * @param {string} params.apiKey
 * @param {number} [params.expectedStatus=200]
 * @returns {Promise<object>} Health check result
 */
async function healthCheck({ apiBase, endpoint, apiKey, expectedStatus = 200 }) {
  const startTime = Date.now();

  try {
    const response = await fetch(apiBase + endpoint, {
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
    });
    const duration = Date.now() - startTime;

    const status = response.status === expectedStatus ? 'ok' : 'unexpected-status';
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

module.exports = { verifyViaList, verifyBatchViaList, healthCheck };

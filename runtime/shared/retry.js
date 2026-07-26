/**
 * Shared retry utilities for ContentCreator.
 * Exponential backoff with configurable max attempts and delay.
 */

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry.
 *
 * @param {Function} fn - Async function to retry
 * @param {object} options
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts
 * @param {number} [options.initialDelayMs=1000] - Initial delay between retries
 * @param {number} [options.maxDelayMs=30000] - Maximum delay between retries
 * @param {number} [options.multiplier=2] - Exponential backoff multiplier
 * @param {Function} [options.shouldRetry] - Custom retry predicate (err, attempt) => boolean
 * @returns {Promise<{success: boolean, result?: any, error?: Error, attempts: number}>}
 */
async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    multiplier = 2,
    shouldRetry = (err, attempt) => attempt < maxAttempts,
  } = options;

  let lastError;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    try {
      const result = await fn();
      return { success: true, result, attempts };
    } catch (err) {
      lastError = err;

      if (!shouldRetry(err, attempt)) {
        return { success: false, error: err, attempts };
      }

      if (attempt < maxAttempts) {
        const delay = Math.min(initialDelayMs * Math.pow(multiplier, attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }
  }

  return { success: false, error: lastError, attempts };
}

module.exports = { retry, sleep };

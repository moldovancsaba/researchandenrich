/**
 * Shared cache utilities for ContentCreator.
 * Simple in-memory TTL cache with LRU eviction.
 */

/**
 * Create a new TTL cache.
 *
 * @param {object} options
 * @param {number} [options.defaultTTL=300000] - Default TTL in milliseconds (5 min)
 * @param {number} [options.maxEntries=1000] - Maximum number of cached entries
 */
function createCache(options = {}) {
  const { defaultTTL = 300000, maxEntries = 1000 } = options;
  const cache = new Map(); // key -> { value, expiresAt }

  return {
    /**
     * Set a value in the cache.
     */
    set(key, value, ttlMs = defaultTTL) {
      // Evict oldest entries if at capacity
      if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    },

    /**
     * Get a value from the cache. Returns undefined if expired or missing.
     */
    get(key) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },

    /**
     * Check if a key exists and is not expired.
     */
    has(key) {
      return this.get(key) !== undefined;
    },

    /**
     * Delete a key from the cache.
     */
    delete(key) {
      return cache.delete(key);
    },

    /**
     * Clear all entries.
     */
    clear() {
      cache.clear();
    },

    /**
     * Get current number of non-expired entries.
     */
    get size() {
      let count = 0;
      const now = Date.now();
      for (const [, entry] of cache) {
        if (now <= entry.expiresAt) count++;
      }
      return count;
    },
  };
}

module.exports = { createCache };

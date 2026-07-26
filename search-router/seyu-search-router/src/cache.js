/** Minimal in-memory TTL cache. Per-process only — see README for the persistence note. */
export class TtlCache {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  size() {
    return this.map.size;
  }
}

/** opts.mode (fast/thorough) doesn't change what an engine would return, so it's excluded from the key. */
export function buildCacheKey(engineId, query, opts = {}) {
  const normalizedQuery = query.trim().toLowerCase();
  const relevantOpts = { ...opts };
  delete relevantOpts.mode;
  delete relevantOpts.query;
  return `${engineId}::${normalizedQuery}::${JSON.stringify(relevantOpts)}`;
}

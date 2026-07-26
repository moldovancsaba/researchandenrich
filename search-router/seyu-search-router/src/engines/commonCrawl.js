import { fetchWithRetry } from '../httpClient.js';
import { makeResult } from '../resultSchema.js';

// Common Crawl collections rotate; hard-coding one goes stale. Resolve the
// current collection id from collinfo.json and cache it for a few hours.
let cachedCollection = null;
let cachedAt = 0;
const COLLECTION_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveCollection() {
  if (cachedCollection && Date.now() - cachedAt < COLLECTION_TTL_MS) return cachedCollection;
  const res = await fetchWithRetry('https://index.commoncrawl.org/collinfo.json', {}, { timeoutMs: 8000, retries: 1 });
  const list = JSON.parse(res.bodyText);
  if (!Array.isArray(list) || list.length === 0) throw new Error('collinfo.json returned no collections');
  cachedCollection = list[0].id || list[0].name;
  cachedAt = Date.now();
  return cachedCollection;
}

export function _resetCommonCrawlCollectionCache() {
  cachedCollection = null;
  cachedAt = 0;
}

export const commonCrawlSpec = {
  id: 'commonCrawl',
  label: 'Common Crawl URL Index',
  type: 'custom',
  verified: 'stable-public-api',
  notes: 'Not for open-ended keyword search — exact URL/host/prefix patterns only.',
  timeoutMs: 10000,
  retries: 1,
  cacheTtlMs: 12 * 60 * 60 * 1000, // historical/archival data is immutable — safe to cache long
  rateLimit: { kind: 'minInterval', minIntervalMs: 1100 },

  async run(query, opts) {
    const collection = await resolveCollection();
    const params = new URLSearchParams({ url: query, output: 'json' });
    if (opts.status) params.set('filter', `status:${opts.status}`);
    const url = `https://index.commoncrawl.org/${collection}-index?${params.toString()}`;

    const res = await fetchWithRetry(url, {}, { timeoutMs: this.timeoutMs, retries: this.retries });
    const lines = res.bodyText.split('\n').map((l) => l.trim()).filter(Boolean);

    const results = lines.map((line, i) => {
      const rec = JSON.parse(line);
      return makeResult({
        url: rec.url,
        title: rec.url,
        snippet: `${rec.mime || ''} \u00b7 status ${rec.status || ''} \u00b7 ${rec.timestamp || ''} \u00b7 warc=${rec.filename || ''}`,
        engine: 'commonCrawl',
        rank: i + 1,
        timestamp: rec.timestamp,
        extra: rec,
      });
    });

    const parseWarning = results.length === 0 && res.bodyText.trim().length > 40
      ? 'no records parsed from a non-empty response — verify manually (see scripts/live-smoke-test.js)'
      : null;

    return { results, parseWarning, rawLength: res.bodyText.length, collection, url };
  },
};

import { makeResult } from '../resultSchema.js';

// Per the source doc's operating rule for Wayback: "every automated request
// should use a descriptive User-Agent containing the agent name, version,
// model, and a contact reference." Set SEYU_SEARCH_CONTACT to a real URL.
const CONTACT = process.env.SEYU_SEARCH_CONTACT || 'contact-not-configured';
const USER_AGENT = `SeyuSearchRouter/1.0 (agentic search router; contact=${CONTACT})`;

function parseYacy(bodyText, engineId) {
  const data = JSON.parse(bodyText);
  const items = data.channels?.[0]?.items || [];
  return items.map((item, i) => makeResult({
    url: item.link,
    title: item.title,
    snippet: item.description,
    engine: engineId,
    rank: i + 1,
    timestamp: item.pubDate,
  }));
}

/**
 * Every engine here maps 1:1 to a service in the source document. `verified`
 * records what could actually be checked from this build environment:
 *
 *  - 'stable-public-api'        long-standing, well-documented public API;
 *                                consistent with known behavior, but exact
 *                                current field names were not re-confirmed
 *                                live (no network access in this sandbox).
 *  - 'unverified-in-this-build' newer/hosted claim (anonymous MCP endpoint)
 *                                that could not be reached at all from here.
 *  - 'requires-local-deployment' correctness depends on your own Fess/YaCy
 *                                 instance and crawl config, not on us.
 *
 * None of this is a claim that anything is broken — only an honest record
 * of what was and wasn't independently checked before you rely on it.
 */
export const ENGINES = {
  // --- Hosted, keyless MCP search servers (doc items 1-2) ---
  parallel: {
    id: 'parallel',
    label: 'Parallel Search MCP',
    type: 'mcp',
    verified: 'unverified-in-this-build',
    serverUrl: 'https://search.parallel.ai/mcp',
    toolName: 'web_search',
    rateLimit: { kind: 'minInterval', minIntervalMs: 500 },
    timeoutMs: 10000,
    retries: 1,
    cacheTtlMs: 15 * 60 * 1000,
    buildArgs: (query, opts) => ({ query, ...(opts.maxResults ? { max_results: opts.maxResults } : {}) }),
    parseResult: (joinedText) => {
      let data;
      try { data = JSON.parse(joinedText); } catch { data = null; }
      const arr = Array.isArray(data) ? data : data?.results;
      if (!Array.isArray(arr)) return [];
      return arr.map((item, i) => makeResult({
        url: item.url || item.link,
        title: item.title,
        snippet: item.snippet || item.description,
        engine: 'parallel',
        rank: i + 1,
      })).filter((r) => r.url);
    },
  },

  youcom: {
    id: 'youcom',
    label: 'You.com Free Search MCP',
    type: 'mcp',
    verified: 'unverified-in-this-build',
    serverUrl: 'https://api.you.com/mcp?profile=free',
    toolName: 'you-search',
    // Published limit is 100/day; the doc recommends a 90/day soft budget. Persisted across restarts via router.js.
    rateLimit: { kind: 'dailyBudget', dailyBudget: 90 },
    timeoutMs: 10000,
    retries: 1,
    cacheTtlMs: 15 * 60 * 1000,
    buildArgs: (query) => ({ query }),
    parseResult: (joinedText) => {
      let data;
      try { data = JSON.parse(joinedText); } catch { data = null; }
      const arr = Array.isArray(data) ? data : data?.results;
      if (!Array.isArray(arr)) return [];
      return arr.map((item, i) => makeResult({
        url: item.url || item.link,
        title: item.title,
        snippet: item.snippet || item.description,
        engine: 'youcom',
        rank: i + 1,
        timestamp: item.date,
      })).filter((r) => r.url);
    },
  },

  // --- Wiby (doc item 3) ---
  wiby: {
    id: 'wiby',
    label: 'Wiby JSON API',
    type: 'rest',
    verified: 'stable-public-api',
    attribution: 'Source: Wiby \u2014 https://wiby.me/',
    method: 'GET',
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({ q: query });
      if (opts.page) params.set('p', String(opts.page));
      return `https://wiby.me/json/?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 1100 },
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 30 * 60 * 1000,
    parseResult: (bodyText) => {
      const data = JSON.parse(bodyText);
      const arr = Array.isArray(data) ? data : (data.results || data.Results || []);
      return arr.map((item, i) => makeResult({
        url: item.URL || item.url || item.link,
        title: item.Title || item.title,
        snippet: item.Snippet || item.snippet || item.description,
        engine: 'wiby',
        rank: i + 1,
      })).filter((r) => r.url);
    },
  },

  // --- Wayback (doc item 7) — two distinct capabilities ---
  waybackAvailable: {
    id: 'waybackAvailable',
    label: 'Wayback Availability API',
    type: 'rest',
    verified: 'stable-public-api',
    method: 'GET',
    headers: () => ({ 'User-Agent': USER_AGENT }),
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({ url: query });
      if (opts.timestamp) params.set('timestamp', opts.timestamp);
      return `https://archive.org/wayback/available?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 1100 },
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    looksLikeNoResults: (bodyText) => {
      try { return !JSON.parse(bodyText)?.archived_snapshots?.closest; } catch { return false; }
    },
    parseResult: (bodyText, opts) => {
      const data = JSON.parse(bodyText);
      const snap = data.archived_snapshots?.closest;
      if (!snap) return [];
      return [makeResult({
        url: snap.url,
        title: `Archived capture of ${opts.query || ''}`.trim(),
        snippet: `status ${snap.status} \u00b7 captured ${snap.timestamp}`,
        engine: 'waybackAvailable',
        rank: 1,
        timestamp: snap.timestamp,
        extra: snap,
      })];
    },
  },

  waybackCdx: {
    id: 'waybackCdx',
    label: 'Wayback CDX Server',
    type: 'rest',
    verified: 'stable-public-api',
    method: 'GET',
    headers: () => ({ 'User-Agent': USER_AGENT }),
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({
        url: query,
        output: 'json',
        collapse: 'digest',
        fl: 'timestamp,original,statuscode,digest',
        limit: String(opts.limit || 100),
      });
      if (opts.matchType) params.set('matchType', opts.matchType); // e.g. 'prefix' to enumerate a whole domain
      if (opts.filter) params.set('filter', opts.filter);
      return `https://web.archive.org/cdx/search/cdx?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 1100 },
    timeoutMs: 10000,
    retries: 1,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    looksLikeNoResults: (bodyText) => bodyText.trim() === '' || bodyText.trim() === '[]',
    parseResult: (bodyText) => {
      const rows = JSON.parse(bodyText);
      if (!Array.isArray(rows) || rows.length < 2) return [];
      const [header, ...data] = rows;
      const idx = Object.fromEntries(header.map((h, i) => [h, i]));
      return data.map((row, i) => makeResult({
        url: row[idx.original],
        title: row[idx.original],
        snippet: `captured ${row[idx.timestamp]} \u00b7 status ${row[idx.statuscode]}`,
        engine: 'waybackCdx',
        rank: i + 1,
        timestamp: row[idx.timestamp],
        extra: { digest: row[idx.digest] },
      }));
    },
  },

  // --- GDELT (doc item 8) ---
  gdelt: {
    id: 'gdelt',
    label: 'GDELT DOC 2.0',
    type: 'rest',
    verified: 'stable-public-api',
    notes: 'Not for comprehensive general-web search — recent global news only.',
    method: 'GET',
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({
        query,
        mode: opts.mode || 'artlist',
        format: 'json',
        maxrecords: String(opts.maxrecords || 25),
        sort: opts.sort || 'datedesc',
      });
      if (opts.startdatetime) params.set('startdatetime', opts.startdatetime);
      if (opts.enddatetime) params.set('enddatetime', opts.enddatetime);
      if (!opts.startdatetime) params.set('timespan', opts.timespan || '3d');
      return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 1100 },
    timeoutMs: 10000,
    retries: 1,
    cacheTtlMs: 5 * 60 * 1000, // news — keep this fresh
    parseResult: (bodyText) => {
      const data = JSON.parse(bodyText);
      const arr = data.articles || [];
      return arr.map((a, i) => makeResult({
        url: a.url,
        title: a.title,
        snippet: `${a.domain || ''} \u00b7 ${a.seendate || ''} \u00b7 ${a.sourcecountry || ''}`,
        engine: 'gdelt',
        rank: i + 1,
        timestamp: a.seendate,
        extra: a,
      }));
    },
  },

  // --- Openverse (doc item 9) ---
  openverseImages: {
    id: 'openverseImages',
    label: 'Openverse Images',
    type: 'rest',
    verified: 'stable-public-api',
    attribution: 'Made using Openverse',
    method: 'GET',
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({ q: query, page_size: String(opts.pageSize || 20) });
      if (opts.license) params.set('license', opts.license);
      return `https://api.openverse.org/v1/images/?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 500 },
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 30 * 60 * 1000,
    parseResult: (bodyText) => {
      const data = JSON.parse(bodyText);
      const arr = data.results || [];
      return arr.map((item, i) => makeResult({
        url: item.foreign_landing_url || item.url,
        title: item.title,
        snippet: `${(item.license || 'unknown').toUpperCase()} ${item.license_version || ''} \u00b7 creator: ${item.creator || 'unknown'} \u2014 re-verify license on source page before reuse`,
        engine: 'openverseImages',
        rank: i + 1,
        extra: { directFileUrl: item.url, license: item.license, licenseVersion: item.license_version, creator: item.creator, creatorUrl: item.creator_url },
      }));
    },
  },

  openverseAudio: {
    id: 'openverseAudio',
    label: 'Openverse Audio',
    type: 'rest',
    verified: 'stable-public-api',
    attribution: 'Made using Openverse',
    method: 'GET',
    buildUrl: (query, opts) => {
      const params = new URLSearchParams({ q: query, page_size: String(opts.pageSize || 20) });
      return `https://api.openverse.org/v1/audio/?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 500 },
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 30 * 60 * 1000,
    parseResult: (bodyText) => {
      const data = JSON.parse(bodyText);
      const arr = data.results || [];
      return arr.map((item, i) => makeResult({
        url: item.foreign_landing_url || item.url,
        title: item.title,
        snippet: `${(item.license || 'unknown').toUpperCase()} \u00b7 creator: ${item.creator || 'unknown'} \u2014 re-verify license before reuse`,
        engine: 'openverseAudio',
        rank: i + 1,
        extra: { directFileUrl: item.url, license: item.license, creator: item.creator },
      }));
    },
  },

  // --- Fess (doc item 4) — self-hosted, disabled until baseUrl is configured ---
  fess: {
    id: 'fess',
    label: 'Fess (self-hosted)',
    type: 'rest',
    verified: 'requires-local-deployment',
    requiresConfig: ['baseUrl'],
    method: 'GET',
    buildUrl: (query, opts) => {
      if (!opts.baseUrl) throw Object.assign(new Error('fess baseUrl not configured'), { type: 'not_configured' });
      const params = new URLSearchParams({ q: query, num: String(opts.num || 10) });
      return `${opts.baseUrl.replace(/\/$/, '')}/api/v2/search?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 300 },
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 10 * 60 * 1000,
    parseResult: (bodyText) => {
      const data = JSON.parse(bodyText);
      const arr = data.response?.result || [];
      return arr.map((item, i) => makeResult({
        url: item.url,
        title: item.title,
        snippet: item.content_description || item.digest,
        engine: 'fess',
        rank: i + 1,
      }));
    },
  },

  // --- YaCy (doc item 5) — self-hosted, disabled until baseUrl is configured ---
  yacyLocal: {
    id: 'yacyLocal',
    label: 'YaCy (local index)',
    type: 'rest',
    verified: 'requires-local-deployment',
    requiresConfig: ['baseUrl'],
    method: 'GET',
    buildUrl: (query, opts) => {
      if (!opts.baseUrl) throw Object.assign(new Error('yacy baseUrl not configured'), { type: 'not_configured' });
      const params = new URLSearchParams({ query, resource: 'local', maximumRecords: String(opts.maximumRecords || 10) });
      return `${opts.baseUrl.replace(/\/$/, '')}/yacysearch.json?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 300 },
    timeoutMs: 10000,
    retries: 1,
    cacheTtlMs: 15 * 60 * 1000,
    parseResult: (bodyText) => parseYacy(bodyText, 'yacyLocal'),
  },

  yacyGlobal: {
    id: 'yacyGlobal',
    label: 'YaCy (P2P global recall)',
    type: 'rest',
    verified: 'requires-local-deployment',
    requiresConfig: ['baseUrl'],
    method: 'GET',
    buildUrl: (query, opts) => {
      if (!opts.baseUrl) throw Object.assign(new Error('yacy baseUrl not configured'), { type: 'not_configured' });
      const params = new URLSearchParams({ query, resource: 'global', maximumRecords: String(opts.maximumRecords || 10) });
      return `${opts.baseUrl.replace(/\/$/, '')}/yacysearch.json?${params.toString()}`;
    },
    rateLimit: { kind: 'minInterval', minIntervalMs: 500 },
    timeoutMs: 12000,
    retries: 0, // P2P recall is inherently variable in latency/quality — don't hammer it with retries
    cacheTtlMs: 10 * 60 * 1000,
    parseResult: (bodyText) => parseYacy(bodyText, 'yacyGlobal'),
  },
};

/**
 * The doc's "Recommended agent routing policy" table, encoded as ordered
 * fallback chains. `search(query, { queryType })` picks one of these.
 */
export const ROUTES = {
  general: ['parallel', 'youcom', 'wiby'],
  news: ['gdelt', 'parallel', 'youcom'],
  small_web: ['wiby', 'parallel', 'youcom'],
  domain_repeat: ['fess', 'yacyLocal'],
  decentralized: ['yacyGlobal'],
  url_inventory: ['commonCrawl', 'waybackCdx'],
  historical: ['waybackAvailable', 'waybackCdx', 'commonCrawl'],
  media_images: ['openverseImages'],
  media_audio: ['openverseAudio'],
};

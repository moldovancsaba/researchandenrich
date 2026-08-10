/**
 * Shared endpoint parsing and URL construction for the runtime verifiers.
 *
 * Every producer of a health-check endpoint string in this repo emits a
 * verb-prefixed form -- `apps.yaml`'s healthCheckTemplate, the /admin queue
 * route, and every workers/<tenant>/*.yaml all write
 * `GET /api/leads?brand=<tenant>&limit=1`.
 *
 * list-based.js used to concatenate `apiBase + endpoint` without stripping the
 * verb, producing `https://hostGET /api/leads?...`, which throws on fetch and
 * was caught by its own try/catch and reported as `{ healthy: false }` -- i.e.
 * indistinguishable from a genuinely unhealthy API. response-based.js stripped
 * the verb with a local `replace(/^GET\s+/, '')`, which is why classscout's
 * health checks worked and the three sales-lead tenants' did not.
 *
 * That local regex is also verb-specific: it silently fails on any non-GET
 * prefix. Both verifiers now share this module so the two cannot drift again.
 */

const VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

/**
 * Split a `"<VERB> <path>"` endpoint string. A bare path with no verb is
 * accepted and defaults to GET, so callers already passing a plain path keep
 * working.
 *
 * @param {string} endpoint
 * @returns {{ method: string, path: string }}
 */
function parseEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new TypeError('endpoint must be a non-empty string');
  }
  const trimmed = endpoint.trim();
  const match = trimmed.match(VERB);
  if (!match) return { method: 'GET', path: trimmed };
  return { method: match[1].toUpperCase(), path: trimmed.slice(match[0].length).trim() };
}

/**
 * Join a base URL and a path into a validated absolute URL. Throws if the
 * result is not a well-formed URL, so a malformed apiBase surfaces as a
 * configuration error at construction rather than as a fetch failure.
 *
 * @param {string} apiBase
 * @param {string} path
 * @returns {string}
 */
function buildUrl(apiBase, path) {
  if (typeof apiBase !== 'string' || apiBase.trim() === '') {
    throw new TypeError('apiBase must be a non-empty string');
  }
  const base = apiBase.trim().replace(/\/+$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${rel}`;
  new URL(url); // throws on a scheme-less or otherwise malformed base
  return url;
}

module.exports = { parseEndpoint, buildUrl };

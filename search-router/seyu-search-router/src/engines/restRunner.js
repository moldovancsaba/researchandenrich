import { fetchWithRetry } from '../httpClient.js';

/**
 * Produce a host predicate for engines whose target is operator-configured.
 *
 * Returns undefined for engines with hardcoded public hosts, leaving their
 * redirect behaviour unchanged -- constraining those would break legitimate
 * results (canonicalisation, CDN hops, archive redirects).
 */
export function buildAllowHost(spec, opts) {
  if (!spec.requiresConfig || !spec.requiresConfig.includes('baseUrl')) return undefined;
  const base = opts && opts.baseUrl;
  if (!base) return undefined;
  let configuredHost;
  try {
    configuredHost = new URL(base).hostname;
  } catch {
    return undefined;
  }
  return (hostname) => hostname === configuredHost;
}

/**
 * Runs a declarative REST engine spec (see registry.js) and normalizes its output.
 *
 * Critically: if parsing yields 0 results from a non-trivial response body,
 * that's flagged as a `parseWarning` rather than silently reported as "the
 * engine found nothing". APIs drift; a parser silently returning [] on a
 * changed response shape is indistinguishable from a real empty result set
 * unless we watch for this specifically.
 */
export async function runRestEngine(spec, query, opts) {
  const url = spec.buildUrl(query, opts);
  const fetchOpts = {
    method: spec.method || 'GET',
    headers: spec.headers ? spec.headers(opts) : undefined,
  };

  const res = await fetchWithRetry(url, fetchOpts, {
    timeoutMs: spec.timeoutMs,
    retries: spec.retries ?? 1,
    backoffBaseMs: spec.backoffBaseMs ?? 500,
    // Pin redirects to the configured origin for self-hosted engines only.
    // Their baseUrl typically points at localhost, so a redirect off-origin is
    // not legitimate behaviour -- it is an SSRF pivot. Public engines target
    // hardcoded hosts and redirect legitimately, so they stay unpinned.
    allowHost: buildAllowHost(spec, opts),
  });

  let parsed;
  let parseWarning = null;
  try {
    parsed = spec.parseResult(res.bodyText, opts);
  } catch (err) {
    parseWarning = `parseResult threw: ${err.message}`;
    parsed = [];
  }

  const looksEmpty = !parsed || parsed.length === 0;
  const bodyIsNonTrivial = res.bodyText && res.bodyText.trim().length > 40;
  const explicitlyNoResults = spec.looksLikeNoResults ? spec.looksLikeNoResults(res.bodyText) : false;

  if (looksEmpty && bodyIsNonTrivial && !explicitlyNoResults) {
    parseWarning = parseWarning || 'parser returned 0 results from a non-trivial response body — possible schema drift, verify manually (see scripts/live-smoke-test.js)';
  }

  return { results: parsed || [], parseWarning, rawLength: res.bodyText?.length ?? 0, url };
}

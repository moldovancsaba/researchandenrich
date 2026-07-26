import { fetchWithRetry } from '../httpClient.js';

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

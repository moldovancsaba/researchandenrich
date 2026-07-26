/** Normalized shape every engine adapter converts its response into. */
export function makeResult({ url, title, snippet, engine, rank, timestamp, extra }) {
  return {
    url: (url || '').trim(),
    title: title || '',
    snippet: snippet || '',
    engine,
    rank: rank ?? null,
    timestamp: timestamp || null,
    extra: extra || {},
  };
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`.toLowerCase().replace(/\/$/, '');
  } catch {
    return (url || '').trim().toLowerCase();
  }
}

/**
 * Merge results from multiple engines by URL. This is the "deduplicate URLs
 * without deleting source provenance" rule from the source doc: every
 * contributing engine's rank/snippet is kept under `sources`, not discarded.
 * Items seen by more engines are ranked higher as a relevance signal.
 */
export function mergeResults(allResults) {
  const byUrl = new Map();

  for (const r of allResults) {
    if (!r.url) continue;
    const key = normalizeUrlKey(r.url);
    if (!byUrl.has(key)) {
      byUrl.set(key, { url: r.url, title: r.title, snippet: r.snippet, sources: [] });
    }
    const merged = byUrl.get(key);
    merged.sources.push({ engine: r.engine, rank: r.rank, snippet: r.snippet, timestamp: r.timestamp });
    if (!merged.title && r.title) merged.title = r.title;
    if (!merged.snippet && r.snippet) merged.snippet = r.snippet;
  }

  const merged = [...byUrl.values()];
  merged.forEach((m) => {
    const ranks = m.sources.map((s) => s.rank).filter((x) => x != null);
    m.bestRank = ranks.length ? Math.min(...ranks) : null;
    m.sourceCount = m.sources.length;
  });

  merged.sort((a, b) => {
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (a.bestRank == null) return 1;
    if (b.bestRank == null) return -1;
    return a.bestRank - b.bestRank;
  });

  return merged;
}

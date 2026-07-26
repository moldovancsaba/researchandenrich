import path from 'node:path';
import fs from 'node:fs';
import { CircuitBreaker } from './circuitBreaker.js';
import { MinIntervalLimiter, DailyBudgetLimiter } from './rateLimiter.js';
import { TtlCache, buildCacheKey } from './cache.js';
import { mergeResults } from './resultSchema.js';
import { runRestEngine } from './engines/restRunner.js';
import { runMcpUpstreamEngine } from './engines/mcpUpstreamAdapter.js';
import { ENGINES as DEFAULT_ENGINES, ROUTES as DEFAULT_ROUTES } from './engines/registry.js';
import { commonCrawlSpec } from './engines/commonCrawl.js';

const DEFAULT_CUSTOM_ENGINES = { commonCrawl: commonCrawlSpec };

export class SearchRouter {
  /**
   * @param config        per-engine option overrides, e.g. { fess: { baseUrl: 'http://localhost:8080' } }
   * @param persistDir    where daily rate-limit budgets are persisted across restarts (null = in-memory only)
   * @param clientFactory injectable MCP client factory, for testing without real network
   * @param engines/customEngines/routes  injectable registry, for testing with fake engines
   */
  constructor({
    config = {},
    persistDir = null,
    clientFactory = null,
    engines = DEFAULT_ENGINES,
    customEngines = DEFAULT_CUSTOM_ENGINES,
    routes = DEFAULT_ROUTES,
  } = {}) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.engines = engines;
    this.customEngines = customEngines;
    this.routes = routes;

    this.cache = new TtlCache();
    this.breakers = new Map();
    this.limiters = new Map();

    for (const spec of this._allSpecs()) {
      this.breakers.set(spec.id, new CircuitBreaker({ id: spec.id }));
      if (spec.rateLimit?.kind === 'minInterval') {
        this.limiters.set(spec.id, new MinIntervalLimiter({ id: spec.id, minIntervalMs: spec.rateLimit.minIntervalMs }));
      } else if (spec.rateLimit?.kind === 'dailyBudget') {
        const persistPath = persistDir ? path.join(persistDir, `${spec.id}.budget.json`) : null;
        if (persistPath) fs.mkdirSync(persistDir, { recursive: true });
        this.limiters.set(spec.id, new DailyBudgetLimiter({ id: spec.id, dailyBudget: spec.rateLimit.dailyBudget, persistPath }));
      }
    }
  }

  _allSpecs() {
    return [...Object.values(this.engines), ...Object.values(this.customEngines)];
  }

  _specFor(id) {
    return this.engines[id] || this.customEngines[id];
  }

  /** Circuit/rate-limit/config status for every engine — the basis of the engine_health tool. */
  getHealth() {
    return this._allSpecs().map((spec) => ({
      id: spec.id,
      label: spec.label,
      verified: spec.verified,
      circuit: this.breakers.get(spec.id).getStatus(),
      rateLimit: this.limiters.get(spec.id)?.getStatus() ?? null,
    }));
  }

  /**
   * @param query
   * @param queryType   one of the keys in ROUTES (default 'general')
   * @param mode        'fast' (default: stop at the first engine that returns results)
   *                     or 'thorough' (query every applicable engine and merge, for diversity)
   * @param maxResultsPerEngine
   * @param engineOpts  per-call per-engine overrides, merged over constructor config, e.g. { fess: { baseUrl } }
   */
  async search(query, { queryType = 'general', mode = 'fast', maxResultsPerEngine = 10, engineOpts = {} } = {}) {
    const route = this.routes[queryType];
    if (!route) {
      return {
        status: 'error',
        error: `unknown queryType "${queryType}". Valid: ${Object.keys(this.routes).join(', ')}`,
        results: [],
        attempted: [],
      };
    }

    const attempted = [];
    const collected = [];
    const warnings = [];
    let anyCoverageGap = false;

    for (const engineId of route) {
      const spec = this._specFor(engineId);
      if (!spec) continue;

      const breaker = this.breakers.get(engineId);
      const opts = {
        ...(this.config[engineId] || {}),
        ...(engineOpts[engineId] || {}),
        query,
        maxResults: maxResultsPerEngine,
      };

      if (!breaker.canAttempt()) {
        attempted.push({ engine: engineId, outcome: 'skipped', reason: 'circuit_open', circuit: breaker.getStatus() });
        anyCoverageGap = true;
        continue;
      }

      const limiter = this.limiters.get(engineId);
      if (limiter) {
        const acquired = limiter.tryAcquire();
        if (!acquired.ok) {
          attempted.push({ engine: engineId, outcome: 'skipped', reason: acquired.reason });
          anyCoverageGap = true;
          continue;
        }
      }

      const cacheKey = buildCacheKey(engineId, query, opts);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        attempted.push({ engine: engineId, outcome: 'cache_hit', count: cached.results.length });
        collected.push(...cached.results);
        if (mode === 'fast' && cached.results.length > 0) break;
        continue;
      }

      const startedAt = Date.now();
      try {
        let outcome;
        if (spec.type === 'rest') {
          outcome = await runRestEngine(spec, query, opts);
        } else if (spec.type === 'mcp') {
          outcome = await runMcpUpstreamEngine(spec, query, opts, { clientFactory: this.clientFactory });
        } else if (spec.type === 'custom') {
          outcome = await spec.run(query, opts);
        } else {
          throw new Error(`unknown engine type for ${engineId}`);
        }

        breaker.onSuccess();
        this.cache.set(cacheKey, { results: outcome.results }, spec.cacheTtlMs ?? 10 * 60 * 1000);
        attempted.push({
          engine: engineId,
          outcome: 'ok',
          count: outcome.results.length,
          latencyMs: Date.now() - startedAt,
          warning: outcome.parseWarning || undefined,
        });
        if (outcome.parseWarning) warnings.push({ engine: engineId, warning: outcome.parseWarning });
        collected.push(...outcome.results);
        if (mode === 'fast' && outcome.results.length > 0) break;
      } catch (err) {
        if (err.type === 'not_configured') {
          // Permanent config gap, not a transient fault — don't penalize the circuit breaker or count it as a coverage gap.
          attempted.push({ engine: engineId, outcome: 'skipped', reason: 'not_configured' });
          continue;
        }
        breaker.onFailure(err);
        anyCoverageGap = true;
        attempted.push({
          engine: engineId,
          outcome: 'failed',
          reason: err.type || 'error',
          status: err.status,
          message: err.message,
          latencyMs: Date.now() - startedAt,
        });
      }
    }

    const merged = mergeResults(collected);
    const status = merged.length === 0 ? 'coverage_incomplete' : (anyCoverageGap ? 'partial' : 'ok');

    return {
      status,
      queryType,
      mode,
      query,
      results: merged,
      attempted,
      warnings,
      note: status === 'coverage_incomplete'
        ? `No usable results for "${query}" (queryType: ${queryType}). Every applicable engine was unavailable, rate-limited, or circuit-open \u2014 see "attempted" for the reason per engine. By design this router does not fall back to an unapproved scraper.`
        : undefined,
    };
  }
}

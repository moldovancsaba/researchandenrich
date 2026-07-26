import fs from 'node:fs';

/**
 * Simple "don't call more often than every N ms" limiter.
 * Used for Wiby, Wayback, Common Crawl, GDELT, Parallel (~1 req/sec or a
 * conservative default where no published limit exists).
 */
export class MinIntervalLimiter {
  constructor({ id, minIntervalMs = 1000 } = {}) {
    this.id = id;
    this.minIntervalMs = minIntervalMs;
    this.lastCallAt = 0;
  }

  tryAcquire() {
    const now = Date.now();
    if (now - this.lastCallAt >= this.minIntervalMs) {
      this.lastCallAt = now;
      return { ok: true };
    }
    return {
      ok: false,
      reason: `min interval ${this.minIntervalMs}ms not elapsed`,
      retryAfterMs: this.minIntervalMs - (now - this.lastCallAt),
    };
  }

  getStatus() {
    return { id: this.id, type: 'min_interval', minIntervalMs: this.minIntervalMs, lastCallAt: this.lastCallAt || null };
  }
}

/**
 * Daily quota limiter, e.g. You.com's published 100/day (we default the
 * budget to 90 to leave headroom, per the source doc's own recommendation).
 *
 * Persists to a small JSON file if persistPath is given, so the budget
 * survives process restarts instead of silently resetting every time the
 * MCP server is relaunched.
 */
export class DailyBudgetLimiter {
  constructor({ id, dailyBudget = 100, persistPath = null } = {}) {
    this.id = id;
    this.dailyBudget = dailyBudget;
    this.persistPath = persistPath;
    this.count = 0;
    this.windowStart = this._todayKey();
    this._load();
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10); // UTC calendar day
  }

  _load() {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.windowStart === this._todayKey()) {
        this.windowStart = data.windowStart;
        this.count = data.count;
      }
    } catch {
      // No persisted state yet, or it's unreadable — start fresh, best-effort.
    }
  }

  _save() {
    if (!this.persistPath) return;
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify({ windowStart: this.windowStart, count: this.count }));
    } catch {
      // Persistence is a nice-to-have, not load-bearing — ignore write failures.
    }
  }

  _rollIfNeeded() {
    const key = this._todayKey();
    if (key !== this.windowStart) {
      this.windowStart = key;
      this.count = 0;
    }
  }

  tryAcquire() {
    this._rollIfNeeded();
    if (this.count < this.dailyBudget) {
      this.count += 1;
      this._save();
      return { ok: true };
    }
    return { ok: false, reason: `daily budget ${this.dailyBudget} exhausted (resets at next UTC day)` };
  }

  getStatus() {
    this._rollIfNeeded();
    return {
      id: this.id,
      type: 'daily_budget',
      dailyBudget: this.dailyBudget,
      used: this.count,
      remaining: this.dailyBudget - this.count,
      windowStart: this.windowStart,
    };
  }
}

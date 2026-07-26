import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MinIntervalLimiter, DailyBudgetLimiter } from '../src/rateLimiter.js';

test('MinIntervalLimiter blocks a second immediate call, allows after interval', async () => {
  const lim = new MinIntervalLimiter({ id: 'x', minIntervalMs: 30 });
  assert.equal(lim.tryAcquire().ok, true);
  const second = lim.tryAcquire();
  assert.equal(second.ok, false);
  assert.ok(second.retryAfterMs > 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(lim.tryAcquire().ok, true);
});

test('DailyBudgetLimiter blocks once the budget is exhausted', () => {
  const lim = new DailyBudgetLimiter({ id: 'x', dailyBudget: 2 });
  assert.equal(lim.tryAcquire().ok, true);
  assert.equal(lim.tryAcquire().ok, true);
  const third = lim.tryAcquire();
  assert.equal(third.ok, false);
  assert.match(third.reason, /exhausted/);
});

test('DailyBudgetLimiter persists usage across instances via persistPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seyu-rl-'));
  const persistPath = path.join(dir, 'budget.json');

  const lim1 = new DailyBudgetLimiter({ id: 'x', dailyBudget: 5, persistPath });
  lim1.tryAcquire();
  lim1.tryAcquire();
  lim1.tryAcquire();

  const lim2 = new DailyBudgetLimiter({ id: 'x', dailyBudget: 5, persistPath });
  const status = lim2.getStatus();
  assert.equal(status.used, 3);
  assert.equal(status.remaining, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

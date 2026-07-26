import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuitBreaker.js';

test('stays closed under threshold', () => {
  const cb = new CircuitBreaker({ id: 'x', failureThreshold: 3, baseCooldownMs: 50 });
  cb.onFailure(new Error('a'));
  cb.onFailure(new Error('b'));
  assert.equal(cb.canAttempt(), true);
  assert.equal(cb.getStatus().state, 'closed');
});

test('opens after threshold consecutive failures and blocks attempts', () => {
  const cb = new CircuitBreaker({ id: 'x', failureThreshold: 3, baseCooldownMs: 1000 });
  cb.onFailure(new Error('a'));
  cb.onFailure(new Error('b'));
  cb.onFailure(new Error('c'));
  assert.equal(cb.getStatus().state, 'open');
  assert.equal(cb.canAttempt(), false);
});

test('half-opens after cooldown, closes again on a successful trial', async () => {
  const cb = new CircuitBreaker({ id: 'x', failureThreshold: 1, baseCooldownMs: 20 });
  cb.onFailure(new Error('a'));
  assert.equal(cb.canAttempt(), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cb.canAttempt(), true); // transitions to half_open
  assert.equal(cb.getStatus().state, 'half_open');
  cb.onSuccess();
  assert.equal(cb.getStatus().state, 'closed');
  assert.equal(cb.getStatus().consecutiveFailures, 0);
});

test('a failed half-open trial reopens with a longer cooldown', async () => {
  const cb = new CircuitBreaker({ id: 'x', failureThreshold: 1, baseCooldownMs: 20, maxCooldownMs: 1000 });
  cb.onFailure(new Error('a'));
  await new Promise((r) => setTimeout(r, 30));
  cb.canAttempt(); // -> half_open
  cb.onFailure(new Error('trial failed'));
  const status = cb.getStatus();
  assert.equal(status.state, 'open');
  assert.equal(status.cooldownMs, 40); // doubled from 20
  assert.equal(cb.canAttempt(), false);
});

test('cooldown is capped at maxCooldownMs', async () => {
  const cb = new CircuitBreaker({ id: 'x', failureThreshold: 1, baseCooldownMs: 100, maxCooldownMs: 150 });
  for (let i = 0; i < 6; i++) {
    cb.onFailure(new Error('a'));
    // Force past whatever the current cooldown is so the next onFailure() finds it half-open.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, cb.cooldownMs + 5));
    cb.canAttempt();
  }
  assert.ok(cb.getStatus().cooldownMs <= 150);
});

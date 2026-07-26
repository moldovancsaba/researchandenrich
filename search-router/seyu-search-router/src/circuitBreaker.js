const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

/**
 * Per-engine circuit breaker.
 *
 * - CLOSED: normal operation.
 * - OPEN: engine is skipped entirely until the cooldown elapses.
 * - HALF_OPEN: one trial call is allowed; success closes the circuit,
 *   failure reopens it with a longer cooldown (capped at maxCooldownMs).
 *
 * This is what lets the router say "skip this engine, don't even try it"
 * instead of paying a timeout on every single call once something is down.
 */
export class CircuitBreaker {
  constructor({ id, failureThreshold = 3, baseCooldownMs = 30_000, maxCooldownMs = 10 * 60_000 } = {}) {
    this.id = id;
    this.failureThreshold = failureThreshold;
    this.baseCooldownMs = baseCooldownMs;
    this.maxCooldownMs = maxCooldownMs;

    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.tripCount = 0;
    this.openedAt = null;
    this.cooldownMs = baseCooldownMs;
    this.lastError = null;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
  }

  canAttempt() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow exactly one trial attempt through.
    return true;
  }

  onSuccess() {
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.lastSuccessAt = Date.now();
  }

  onFailure(error) {
    this.consecutiveFailures += 1;
    this.lastError = error;
    this.lastFailureAt = Date.now();

    if (this.state === STATE.HALF_OPEN) {
      // The trial call failed: reopen with a longer cooldown.
      this.tripCount += 1;
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.tripCount += 1;
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
    }
  }

  getStatus() {
    return {
      id: this.id,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      tripCount: this.tripCount,
      cooldownMs: this.cooldownMs,
      openedAt: this.openedAt,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }
}

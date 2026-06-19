// Circuit breaker — mirrors backend/app/circuit_breaker.CircuitBreaker.
// Per-provider (provider_id:model) breaker with closed/open/half_open states.

import type { CircuitSnapshot } from "../types/provider";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutSeconds: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  timeoutSeconds: 60,
};

type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  state: BreakerState = "closed";
  consecutiveFailures = 0;
  consecutiveSuccesses = 0;
  openedAt = 0;
  private readonly now: () => number;

  constructor(
    private readonly config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now() / 1000);
  }

  allowRequest(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half_open") return true;
    if (this.now() - this.openedAt >= this.config.timeoutSeconds) {
      this.state = "half_open";
      this.consecutiveSuccesses = 0;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half_open") {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.state = "closed";
        this.consecutiveSuccesses = 0;
      }
    } else {
      this.state = "closed";
    }
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.openedAt,
    };
  }
}

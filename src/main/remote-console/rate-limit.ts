/**
 * Rate limiting for the Remote Console (#254, spec §5 rule 7 and §7).
 *
 * Pure, clock injected. The numbers live in `LIMITS` in one place so the
 * session, the server and the tests read the same table.
 *
 * Two shapes, for two different questions. A token bucket answers "is this
 * burst acceptable" and is what the per-message limits use: a phone that sends
 * three keys in a row must not be refused, one that sends forty a second must.
 * A sliding window answers "how many in the last N seconds", which is what a
 * trip counter and a failure count need — a bucket forgets a failed pairing
 * the moment it refills, and forgetting is the one thing a brute-force guard
 * must not do.
 */

export const LIMITS = Object.freeze({
  /** Frames per connection. */
  frame: { rate: 50, burst: 100 },
  /** `send` per device. */
  send: { rate: 5, burst: 5 },
  /** Composer text per device: 64 KiB a minute. */
  sendBytes: { rate: 65536 / 60, burst: 65536 },
  key: { rate: 20, burst: 20 },
  answer: { rate: 2, burst: 2 },
  /** Limit trips (or forbidden attempts) that close a socket with 4429. */
  trips: { limit: 3, windowMs: 60_000 },
  /** Unauthenticated HTTP, per remote address. */
  unauth: { limit: 60, windowMs: 10_000 },
  /** Failed pairs/upgrades per peer before the penalty box. */
  penalty: { failures: 10, windowMs: 60_000, boxMs: 5 * 60_000 },
  /** Pairing attempts, all peers together. */
  pairGlobal: { limit: 20, windowMs: 60 * 60_000 },
});

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Take `n` tokens if they are all there; a refusal takes nothing. */
  take(n = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * Events in the last `windowMs`. Never stores more than `limit + 1` stamps, so
 * a flood costs a bounded array rather than one entry per request.
 */
export class WindowCounter {
  private stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }

  /** Record one event; true while the window is still within the limit. */
  hit(): boolean {
    const t = this.now();
    this.prune(t);
    if (this.stamps.length <= this.limit) this.stamps.push(t);
    return this.stamps.length <= this.limit;
  }

  count(): number {
    this.prune(this.now());
    return this.stamps.length;
  }
}

/** A `WindowCounter` per key (remote address), pruned so the map cannot grow without bound. */
export class KeyedWindowLimiter {
  private readonly counters = new Map<string, WindowCounter>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 1024,
  ) {}

  hit(key: string): boolean {
    let c = this.counters.get(key);
    if (!c) {
      if (this.counters.size >= this.maxKeys) this.sweep();
      c = new WindowCounter(this.limit, this.windowMs, this.now);
      this.counters.set(key, c);
    }
    return c.hit();
  }

  private sweep(): void {
    for (const [k, c] of this.counters) if (c.count() === 0) this.counters.delete(k);
    // Still full of live keys: drop the oldest insertion rather than grow.
    while (this.counters.size >= this.maxKeys) {
      const first = this.counters.keys().next().value as string;
      this.counters.delete(first);
    }
  }
}

/**
 * Failed pairs and failed upgrades per peer. `failures` of them inside
 * `windowMs` boxes the peer for `boxMs`, during which it is refused before any
 * secret or cookie is even looked at.
 */
export class PenaltyBox {
  private readonly fails: KeyedWindowLimiter;
  private readonly boxed = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly cfg: { failures: number; windowMs: number; boxMs: number } = LIMITS.penalty,
  ) {
    // The counter's limit is failures-1 so the Nth failure is the one that trips.
    this.fails = new KeyedWindowLimiter(cfg.failures - 1, cfg.windowMs, now);
  }

  fail(key: string): void {
    if (!this.fails.hit(key)) this.boxed.set(key, this.now() + this.cfg.boxMs);
  }

  isBoxed(key: string): boolean {
    const until = this.boxed.get(key);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.boxed.delete(key);
      return false;
    }
    return true;
  }
}

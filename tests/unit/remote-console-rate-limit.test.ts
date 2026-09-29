import { describe, it, expect } from 'vitest';
import { KeyedWindowLimiter, LIMITS, PenaltyBox, TokenBucket, WindowCounter } from '../../src/main/remote-console/rate-limit';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('TokenBucket (#254)', () => {
  it('allows the burst, then refuses until it refills at the rate', () => {
    const c = clock();
    const b = new TokenBucket(LIMITS.send.rate, LIMITS.send.burst, c.now);
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    c.advance(200); // 5/s → one token
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('never refills past the burst', () => {
    const c = clock();
    const b = new TokenBucket(2, 2, c.now);
    c.advance(60_000);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('a refused multi-token take consumes nothing (64 KiB/min text budget)', () => {
    const c = clock();
    const b = new TokenBucket(LIMITS.sendBytes.rate, LIMITS.sendBytes.burst, c.now);
    expect(b.take(60_000)).toBe(true);
    expect(b.take(10_000)).toBe(false);
    expect(b.take(5_000)).toBe(true);
  });

  it('frame bucket: 100 burst at 50/s', () => {
    const c = clock();
    const b = new TokenBucket(LIMITS.frame.rate, LIMITS.frame.burst, c.now);
    let n = 0;
    while (b.take()) n++;
    expect(n).toBe(100);
    c.advance(1000);
    n = 0;
    while (b.take()) n++;
    expect(n).toBe(50);
  });
});

describe('WindowCounter', () => {
  it('counts events in the window and forgets old ones', () => {
    const c = clock();
    const w = new WindowCounter(3, 60_000, c.now);
    expect(w.hit()).toBe(true);
    expect(w.hit()).toBe(true);
    expect(w.hit()).toBe(true);
    expect(w.hit()).toBe(false);
    expect(w.count()).toBe(4);
    c.advance(60_001);
    expect(w.count()).toBe(0);
    expect(w.hit()).toBe(true);
  });

  it('stores a bounded number of stamps under a flood', () => {
    const c = clock();
    const w = new WindowCounter(2, 60_000, c.now);
    for (let i = 0; i < 10_000; i++) w.hit();
    expect(w.count()).toBe(3);
  });
});

describe('KeyedWindowLimiter', () => {
  it('limits per key (60 per 10 s unauthenticated)', () => {
    const c = clock();
    const l = new KeyedWindowLimiter(LIMITS.unauth.limit, LIMITS.unauth.windowMs, c.now);
    for (let i = 0; i < 60; i++) expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(false);
    expect(l.hit('b')).toBe(true);
    c.advance(10_001);
    expect(l.hit('a')).toBe(true);
  });

  it('does not grow past maxKeys', () => {
    const c = clock();
    const l = new KeyedWindowLimiter(1, 1000, c.now, 4);
    for (let i = 0; i < 100; i++) l.hit('k' + i);
    expect((l as unknown as { counters: Map<string, unknown> }).counters.size).toBeLessThanOrEqual(4);
  });
});

// Peers are keyed by remote address in production; any string is a key here.
describe('PenaltyBox', () => {
  it('boxes a peer on the 10th failure in a minute, for 5 minutes', () => {
    const c = clock();
    const p = new PenaltyBox(c.now);
    for (let i = 0; i < 9; i++) p.fail('peer-a');
    expect(p.isBoxed('peer-a')).toBe(false);
    p.fail('peer-a');
    expect(p.isBoxed('peer-a')).toBe(true);
    expect(p.isBoxed('peer-b')).toBe(false);
    c.advance(5 * 60_000 - 1);
    expect(p.isBoxed('peer-a')).toBe(true);
    c.advance(1);
    expect(p.isBoxed('peer-a')).toBe(false);
  });

  it('failures spread beyond the window do not box', () => {
    const c = clock();
    const p = new PenaltyBox(c.now);
    for (let i = 0; i < 20; i++) {
      p.fail('x');
      c.advance(10_000);
    }
    expect(p.isBoxed('x')).toBe(false);
  });
});

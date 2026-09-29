import { describe, it, expect } from 'vitest';
import {
  createFlingVelocityTracker,
  startFling,
  stepFling,
  type Fling,
  VELOCITY_WINDOW_MS,
  PAUSE_BEFORE_LIFT_MS,
  MIN_FLING_VELOCITY,
  MAX_FLING_VELOCITY,
  FLING_TIME_CONSTANT_MS,
  FLING_STOP_VELOCITY,
  MAX_FLING_FRAME_GAP_MS,
} from '../../src/renderer/utils/touch-fling';
import { MAX_PAN_STEP_PX } from '../../src/renderer/utils/touch-pan';

// Issue #248. Momentum cannot be felt on the machine CI runs on, so every rule
// that decides whether a flick flings, how fast and how far is pinned here.

/** Feed a constant-speed drag: `v` px/ms, one sample every `frame` ms, ending at `tEnd`. */
function drag(v: number, tEnd: number, frame = 16, duration = 200) {
  const t = createFlingVelocityTracker();
  // Counted back from tEnd so the LAST sample lands exactly on it.
  for (let i = Math.floor(duration / frame); i >= 0; i--) {
    const at = tEnd - i * frame;
    t.add(at, 500 + v * at);
  }
  return t;
}

/** Run a fling to completion at a fixed frame interval; returns total wheel delta and frames. */
function runOut(f: Fling, frameMs: number) {
  let fling: Fling | null = f;
  let total = 0;
  let frames = 0;
  while (fling && frames < 100_000) {
    const step = stepFling(fling, frameMs);
    total += step.deltaY;
    fling = step.next;
    frames++;
  }
  return { total, frames };
}

describe('release velocity', () => {
  it('measures a steady drag', () => {
    const t = drag(1.5, 1000);
    expect(t.releaseVelocity(1005)).toBeCloseTo(1.5, 5);
  });

  it('is signed like the finger: moving UP is negative', () => {
    expect(drag(-2, 1000).releaseVelocity(1000)).toBeCloseTo(-2, 5);
  });

  it('is not decided by one noisy final sample', () => {
    const t = createFlingVelocityTracker();
    // 2 px/ms for 100 ms, then a last report that barely moved.
    for (let at = 0; at <= 96; at += 16) t.add(at, at * 2);
    t.add(100, 96 * 2 + 0.5);
    const two = (96 * 2 + 0.5 - 96 * 2) / (100 - 96); // what a two-sample estimate would say
    const v = t.releaseVelocity(100);
    expect(two).toBeLessThan(MIN_FLING_VELOCITY);
    expect(v).toBeGreaterThan(1);
  });

  it('only looks at the last window, so a slow drag that ends in a flick is judged on the flick', () => {
    const t = createFlingVelocityTracker();
    let y = 0;
    for (let at = 0; at < 1000; at += 16) { y += 0.1 * 16; t.add(at, y); }
    const flickStart = 1000;
    for (let at = flickStart; at <= flickStart + VELOCITY_WINDOW_MS; at += 16) {
      t.add(at, y + 3 * (at - flickStart));
    }
    expect(t.releaseVelocity(flickStart + VELOCITY_WINDOW_MS)).toBeGreaterThan(2.5);
  });

  it('a finger that paused before lifting has no velocity', () => {
    const t = drag(3, 1000);
    expect(t.releaseVelocity(1000 + PAUSE_BEFORE_LIFT_MS + 1)).toBe(0);
    // ...but a lift right on the heels of the last move does.
    expect(t.releaseVelocity(1000 + PAUSE_BEFORE_LIFT_MS)).toBeGreaterThan(0);
  });

  it('needs two samples and a time base', () => {
    const t = createFlingVelocityTracker();
    expect(t.releaseVelocity(0)).toBe(0);
    t.add(10, 100);
    expect(t.releaseVelocity(10)).toBe(0);
    t.add(10, 200); // coalesced: same timestamp
    expect(t.releaseVelocity(10)).toBe(0);
  });

  it('reset forgets the previous gesture', () => {
    const t = drag(3, 1000);
    t.reset();
    expect(t.releaseVelocity(1000)).toBe(0);
  });
});

describe('starting a fling', () => {
  it('a slow release is not a fling', () => {
    expect(startFling(MIN_FLING_VELOCITY * 0.9)).toBeNull();
    expect(startFling(-MIN_FLING_VELOCITY * 0.9)).toBeNull();
    expect(startFling(0)).toBeNull();
  });

  it('a release at the threshold is one', () => {
    expect(startFling(MIN_FLING_VELOCITY)?.velocity).toBe(MIN_FLING_VELOCITY);
  });

  it('caps the velocity, keeping the sign', () => {
    expect(startFling(50)?.velocity).toBe(MAX_FLING_VELOCITY);
    expect(startFling(-50)?.velocity).toBe(-MAX_FLING_VELOCITY);
  });

  it('refuses a non-finite velocity', () => {
    expect(startFling(Number.NaN)).toBeNull();
    expect(startFling(Infinity)).toBeNull();
  });
});

describe('stepping a fling', () => {
  it('direction is natural: a finger flung DOWN keeps revealing what is above (negative wheel delta)', () => {
    const step = stepFling({ velocity: 2 }, 16);
    expect(step.deltaY).toBeLessThan(0);
    expect(stepFling({ velocity: -2 }, 16).deltaY).toBeGreaterThan(0);
  });

  it('decays every frame and eventually stops', () => {
    const { frames } = runOut({ velocity: MAX_FLING_VELOCITY }, 16);
    expect(frames).toBeGreaterThan(10);
    // ln(4 / 0.02) * 325 ≈ 1722 ms of fling — well under a few seconds.
    expect(frames * 16).toBeLessThan(2500);
    const a = stepFling({ velocity: 2 }, 16);
    expect(Math.abs(a.next!.velocity)).toBeLessThan(2);
  });

  it('travels ~v0 * tau in total', () => {
    const v0 = 2;
    const { total } = runOut({ velocity: v0 }, 16);
    const expected = v0 * FLING_TIME_CONSTANT_MS;
    // Short of the full integral only by the tail below the stop velocity.
    expect(Math.abs(total)).toBeGreaterThan(expected - FLING_STOP_VELOCITY * FLING_TIME_CONSTANT_MS - 1);
    expect(Math.abs(total)).toBeLessThanOrEqual(expected);
  });

  it('is frame-rate independent: 60 Hz and 120 Hz carry a flick the same distance', () => {
    const at60 = runOut({ velocity: 3 }, 1000 / 60).total;
    const at120 = runOut({ velocity: 3 }, 1000 / 120).total;
    const at144 = runOut({ velocity: 3 }, 1000 / 144).total;
    // Only the final partial step differs (where each crosses the stop floor).
    expect(Math.abs(at60 - at120)).toBeLessThan(1);
    expect(Math.abs(at60 - at144)).toBeLessThan(1);
  });

  it('a cancelled/stalled frame gap ends the fling instead of jumping', () => {
    const step = stepFling({ velocity: 3 }, MAX_FLING_FRAME_GAP_MS + 1);
    expect(step.next).toBeNull();
    expect(step.deltaY).toBe(0);
    // A dropped frame or two is still integrated.
    expect(stepFling({ velocity: 3 }, MAX_FLING_FRAME_GAP_MS).next).not.toBeNull();
  });

  it('refuses a negative or NaN dt rather than scrolling backwards', () => {
    expect(stepFling({ velocity: 3 }, -5)).toEqual({ deltaY: 0, next: null });
    expect(stepFling({ velocity: 3 }, Number.NaN)).toEqual({ deltaY: 0, next: null });
  });

  it('a zero-length frame emits nothing and keeps going', () => {
    const step = stepFling({ velocity: 3 }, 0);
    expect(step.deltaY).toBe(0);
    expect(Object.is(step.deltaY, -0)).toBe(false);
    expect(step.next?.velocity).toBe(3);
  });

  it('no single frame exceeds the pan step clamp', () => {
    const step = stepFling({ velocity: MAX_FLING_VELOCITY }, MAX_FLING_FRAME_GAP_MS);
    expect(Math.abs(step.deltaY)).toBeLessThanOrEqual(MAX_PAN_STEP_PX);
  });

  it('bounds a capped flick to a sane total', () => {
    const f = startFling(1000)!;
    const { total } = runOut(f, 16);
    expect(Math.abs(total)).toBeLessThanOrEqual(MAX_FLING_VELOCITY * FLING_TIME_CONSTANT_MS);
  });
});

describe('end to end: samples → fling', () => {
  it('a fast flick flings, a slow drag does not, a paused flick does not', () => {
    expect(startFling(drag(2, 1000).releaseVelocity(1008))).not.toBeNull();
    expect(startFling(drag(0.1, 1000).releaseVelocity(1008))).toBeNull();
    expect(startFling(drag(2, 1000).releaseVelocity(1000 + 150))).toBeNull();
  });
});

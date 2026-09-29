/**
 * Touch pan momentum — the physics half (issue #248).
 *
 * #243 made a finger drag scroll a pane, but the scroll stopped dead the moment
 * the finger lifted. Every touch surface the reporter uses (a ThinkPad Z16)
 * keeps going after a flick and decays, so a terminal that does not reads as
 * sticky — and a long scrollback takes a dozen drags where a phone would take
 * one flick.
 *
 * This module is pure for the same reason `touch-pan.ts` is: the machine that
 * can feel the result is not the one CI runs on, so everything that decides
 * WHETHER a fling starts, HOW FAST, and HOW FAR is pinned by unit tests with no
 * DOM, no rAF and no touchscreen. The driver in `useTerminal.ts` only feeds it
 * timestamps and turns its output into the SAME synthetic, touch-tagged wheel
 * events the pan already dispatches — so a fling inherits scrollback, SGR mouse
 * reports and alt-screen arrows exactly as the pan did, and the fractional
 * pixel deltas it produces land in `wheelDeltaToLines`' per-surface accumulator
 * rather than a second one here. Nothing in this file knows what a cell is.
 *
 * Units: pixels and milliseconds throughout, on the `event.timeStamp` /
 * `performance.now()` / rAF timeline (Chromium puts all three on one clock).
 * Velocity is FINGER velocity, positive = finger moving down the screen; the
 * sign flip to a wheel delta happens in exactly one place, `stepFling`, and it
 * is the same natural-direction rule `touch-pan.ts` documents.
 */

import { MAX_PAN_STEP_PX } from './touch-pan';

/**
 * How far back the release velocity looks.
 *
 * NOT just the last two samples: the final pointermove before a lift is often
 * a tiny, noisy one (the finger decelerating off the glass, or a digitizer
 * report that straddles the lift), and a two-sample velocity turns that noise
 * into either a dead flick or a wild one. ~100 ms is 6 frames at 60 Hz — long
 * enough to average the noise, short enough that a drag which was slow for a
 * second and then flicked is judged on the flick. Android's VelocityTracker
 * uses the same horizon.
 */
export const VELOCITY_WINDOW_MS = 100;

/**
 * A finger that stopped before it lifted means "put it here", not "throw it".
 * pointermove stops arriving while a finger is stationary, so the gap between
 * the last sample and the lift IS the pause. 80 ms is under the ~100 ms window
 * above on purpose — any longer and the window would already be judging a
 * stationary finger on motion from before it stopped.
 */
export const PAUSE_BEFORE_LIFT_MS = 80;

/**
 * Below this release speed (px/ms) a lift is a lift, not a flick. 0.25 px/ms is
 * 250 px/s — about 15 rows a second at 17 px/cell. Slower than that, a user is
 * positioning the view deliberately, and a drift afterwards would move it off
 * the line they were placing.
 */
export const MIN_FLING_VELOCITY = 0.25;

/**
 * Ceiling on the release speed (px/ms). With the time constant below the total
 * travel of a fling is `v0 * FLING_TIME_CONSTANT_MS`, so 4 px/ms caps a single
 * flick at ~1300 px — ~75 rows. That is a lot of scrollback, and it is also the
 * ceiling on what one flick can do on the alt screen, where `writeWheelToPty`
 * turns every line into an arrow key written to the PTY: an uncapped digitizer
 * glitch would be hundreds of keystrokes into somebody's editor.
 */
export const MAX_FLING_VELOCITY = 4;

/**
 * Exponential decay time constant, ms. v(t) = v0 * exp(-t / tau). 325 ms is the
 * classic kinetic-scrolling constant (the one iOS-feel reimplementations
 * converge on): a fling is ~95% spent after ~1 s, which reads as momentum
 * rather than either a skid or a runaway.
 */
export const FLING_TIME_CONSTANT_MS = 325;

/**
 * A fling ends when it is slower than this (px/ms) — 0.02 px/ms is 20 px/s,
 * about one row a second, which is below what anyone perceives as motion. The
 * tail of an exponential is infinite; without a floor the rAF loop would run
 * forever emitting nothing.
 */
export const FLING_STOP_VELOCITY = 0.02;

/**
 * A frame gap longer than this ends the fling instead of being integrated.
 * rAF does not run while the window is hidden or occluded, so the "next frame"
 * after a minimise can be seconds later — integrating that would deliver the
 * whole remaining fling in one jump, into a pane the user comes back to and
 * never asked to move. A dropped frame or two (≤ 100 ms) is still integrated
 * normally; that is what makes the decay frame-rate independent.
 */
export const MAX_FLING_FRAME_GAP_MS = 100;

interface Sample { t: number; y: number }

export interface FlingVelocityTracker {
  /** Record the finger's position at time `t` (only while a pan is committed). */
  add(t: number, y: number): void;
  /**
   * The finger velocity at release, px/ms (positive = finger moving DOWN), or
   * 0 if there is not enough recent motion to say — including a finger that
   * paused before it lifted.
   */
  releaseVelocity(tUp: number): number;
  /** Forget everything (a new pointerdown). */
  reset(): void;
}

export function createFlingVelocityTracker(): FlingVelocityTracker {
  let samples: Sample[] = [];

  return {
    add(t, y) {
      samples.push({ t, y });
      // Keep only what the window can use: anything older is irrelevant to
      // the release velocity, and the array must stay bounded on a long drag.
      // The newest sample always survives, whatever its timestamp.
      const cutoff = t - VELOCITY_WINDOW_MS;
      let drop = 0;
      while (drop < samples.length - 1 && samples[drop].t < cutoff) drop++;
      if (drop > 0) samples = samples.slice(drop);
    },

    releaseVelocity(tUp) {
      if (samples.length < 2) return 0;
      const last = samples[samples.length - 1];
      if (tUp - last.t > PAUSE_BEFORE_LIFT_MS) return 0;
      const recent = samples.filter((s) => s.t >= last.t - VELOCITY_WINDOW_MS);
      if (recent.length < 2) return 0;
      // Least-squares slope of y over t: every sample in the window votes, so
      // one noisy final report cannot decide the fling on its own.
      const n = recent.length;
      let st = 0; let sy = 0;
      for (const s of recent) { st += s.t; sy += s.y; }
      const mt = st / n; const my = sy / n;
      let num = 0; let den = 0;
      for (const s of recent) {
        const dt = s.t - mt;
        num += dt * (s.y - my);
        den += dt * dt;
      }
      // All samples at one timestamp (a coalesced burst): no time base, no
      // velocity. Never divide by it.
      if (den === 0) return 0;
      return num / den;
    },

    reset() {
      samples = [];
    },
  };
}

/** A fling in flight: the current finger-equivalent velocity, px/ms. */
export interface Fling { readonly velocity: number }

/**
 * Turn a release velocity into a fling, or null if it is too slow to be one.
 * The cap is applied here, once, so every later step works from a sane value.
 */
export function startFling(releaseVelocity: number): Fling | null {
  if (!Number.isFinite(releaseVelocity)) return null;
  if (Math.abs(releaseVelocity) < MIN_FLING_VELOCITY) return null;
  const v = Math.sign(releaseVelocity) * Math.min(Math.abs(releaseVelocity), MAX_FLING_VELOCITY);
  return { velocity: v };
}

export interface FlingStep {
  /** Wheel deltaY in pixels to dispatch this frame (natural direction), possibly fractional, possibly 0. */
  deltaY: number;
  /** The fling to continue with, or null when it is over. */
  next: Fling | null;
}

/**
 * Advance a fling by `dtMs` of wall time.
 *
 * The distance is the EXACT integral of the exponential over the step,
 * `v * tau * (1 - e^(-dt/tau))`, not `v * dt`: the exact form makes the sum
 * over any partition of the same time span identical, so a 120 Hz panel and a
 * 60 Hz one carry a flick exactly as far. Euler integration would travel
 * further at lower frame rates.
 */
export function stepFling(fling: Fling, dtMs: number): FlingStep {
  if (Number.isNaN(dtMs) || dtMs < 0 || dtMs > MAX_FLING_FRAME_GAP_MS) return { deltaY: 0, next: null };
  const decay = Math.exp(-dtMs / FLING_TIME_CONSTANT_MS);
  const travel = fling.velocity * FLING_TIME_CONSTANT_MS * (1 - decay);
  const v = fling.velocity * decay;
  // Natural direction, as in touch-pan.ts: a finger moving DOWN reveals what
  // is ABOVE, which is a NEGATIVE wheel delta. `+ 0` folds -0 into 0.
  const deltaY = Math.max(-MAX_PAN_STEP_PX, Math.min(MAX_PAN_STEP_PX, -travel)) + 0;
  return {
    deltaY,
    next: Math.abs(v) < FLING_STOP_VELOCITY ? null : { velocity: v },
  };
}

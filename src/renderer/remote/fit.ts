/**
 * How big the phone's terminal mirror draws (#254).
 *
 * The phone never resizes the PTY (I4): the desktop owns cols×rows, and a
 * phone that sent its own would reflow the agent the user is sitting in front
 * of. So the mirror has the desktop's grid and only the FONT is the phone's to
 * choose, and there are exactly two honest choices:
 *
 *  - `fit`: shrink until the whole width is visible. A monospace cell is about
 *    0.6 em wide, so `floor(width / (cols · 0.6))`, clamped to 7–16 px. Below 7
 *    px it is not text any more; above 16 it is wasting the width that `fit`
 *    exists to use.
 *  - `pan`: a readable 13 px (× the user's font scale), wider than the screen,
 *    panned sideways with a finger.
 *
 * Which one a surface wants depends on what is in it — a 200-column build log
 * is unreadable fitted, a 90-column agent is fine — so the choice is
 * remembered per surface rather than globally.
 */

export const MIN_FONT_PX = 7;
export const MAX_FONT_PX = 16;
export const READABLE_FONT_PX = 13;
/** Advance width of a monospace cell, in em. Close enough for every font xterm is likely to get. */
export const CELL_WIDTH_EM = 0.6;

export type FitMode = 'fit' | 'pan';

export function fitFontSize(widthPx: number, cols: number): number {
  // isFinite first: NaN would slip past a plain `<= 0` and floor to NaN.
  if (!Number.isFinite(widthPx) || !Number.isFinite(cols) || widthPx <= 0 || cols <= 0) return READABLE_FONT_PX;
  const size = Math.floor(widthPx / (cols * CELL_WIDTH_EM));
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, size));
}

/** The font for a mode. `scale` is the Prefs font scale and applies to the readable size only. */
export function fontForMode(mode: FitMode, widthPx: number, cols: number, scale = 1): number {
  if (mode === 'fit') return fitFontSize(widthPx, cols);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round(READABLE_FONT_PX * s);
}

/** True when the fitted size had to hit the floor, i.e. `fit` still cannot show every column. */
export function fitOverflows(widthPx: number, cols: number): boolean {
  return widthPx > 0 && cols > 0 && Math.floor(widthPx / (cols * CELL_WIDTH_EM)) < MIN_FONT_PX;
}

export interface FitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FIT_PREFIX = 'wmux-remote-fit:';

export function loadFitMode(storage: FitStorage | null, surfaceId: string): FitMode {
  try {
    return storage?.getItem(FIT_PREFIX + surfaceId) === 'pan' ? 'pan' : 'fit';
  } catch {
    return 'fit';
  }
}

export function saveFitMode(storage: FitStorage | null, surfaceId: string, mode: FitMode): void {
  try {
    storage?.setItem(FIT_PREFIX + surfaceId, mode);
  } catch { /* a remembered preference is a convenience, never a failure */ }
}

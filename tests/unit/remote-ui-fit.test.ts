import { describe, it, expect } from 'vitest';
import {
  fitFontSize,
  fitOverflows,
  fontForMode,
  loadFitMode,
  saveFitMode,
  MAX_FONT_PX,
  MIN_FONT_PX,
  READABLE_FONT_PX,
} from '../../src/renderer/remote/fit';

describe('fit math', () => {
  it('is floor(width / (cols · 0.6)) inside the clamp', () => {
    // 390 px phone, 40-column pane: 390 / 24 = 16.25 → 16
    expect(fitFontSize(390, 40)).toBe(16);
    // 390 / (60·0.6 = 36) = 10.83 → 10
    expect(fitFontSize(390, 60)).toBe(10);
    // 400 / (80·0.6 = 48) = 8.33 → 8
    expect(fitFontSize(400, 80)).toBe(8);
  });

  it('clamps to 7–16 px', () => {
    expect(fitFontSize(400, 200)).toBe(MIN_FONT_PX);
    expect(fitFontSize(2000, 20)).toBe(MAX_FONT_PX);
  });

  it('falls back to the readable size on nonsense input', () => {
    for (const [w, c] of [[0, 80], [400, 0], [Number.NaN, 80], [400, -3], [Infinity, 80]]) {
      expect(fitFontSize(w, c)).toBe(READABLE_FONT_PX);
    }
  });

  it('pan mode is the readable 13 px times the font scale', () => {
    expect(fontForMode('pan', 400, 200)).toBe(13);
    expect(fontForMode('pan', 400, 200, 1.25)).toBe(16);
    expect(fontForMode('pan', 400, 200, Number.NaN)).toBe(13);
    expect(fontForMode('fit', 400, 80, 2)).toBe(8);
  });

  it('reports when fit still cannot show every column', () => {
    expect(fitOverflows(400, 200)).toBe(true);
    expect(fitOverflows(400, 80)).toBe(false);
  });

  it('remembers the mode per surface, defaulting to fit, and survives a throwing Storage', () => {
    const data = new Map<string, string>();
    const st = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    expect(loadFitMode(st, 'surf-a')).toBe('fit');
    saveFitMode(st, 'surf-a', 'pan');
    expect(loadFitMode(st, 'surf-a')).toBe('pan');
    expect(loadFitMode(st, 'surf-b')).toBe('fit');
    const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadFitMode(boom, 'surf-a')).toBe('fit');
    expect(() => saveFitMode(boom, 'surf-a', 'pan')).not.toThrow();
  });
});

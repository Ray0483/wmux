import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pickNoticeTarget } from '../../src/main/remote-console/notice-target';

const win = (name: string, destroyed = false) => ({ name, isDestroyed: () => destroyed });

/**
 * A Remote Console desktop bell goes to ONE window (#254): every window that
 * receives it raises its own toast, flash and sound.
 */
describe('pickNoticeTarget (#254)', () => {
  it('prefers the focused window', () => {
    const a = win('a');
    const b = win('b');
    expect(pickNoticeTarget([a, b], b)).toBe(b);
  });

  it('falls back to the first live window when none is focused', () => {
    const a = win('a', true);
    const b = win('b');
    const c = win('c');
    expect(pickNoticeTarget([a, b, c], null)).toBe(b);
  });

  it('never picks a destroyed focused window', () => {
    const a = win('a');
    expect(pickNoticeTarget([a], win('gone', true))).toBe(a);
  });

  it('no live window: nobody', () => {
    expect(pickNoticeTarget([win('a', true)], null)).toBeNull();
  });
});

describe('notifyDesktop wiring (#254)', () => {
  // index.ts needs a real Electron to load, so the wiring is pinned at source level.
  it('sends the notice to the picked window, never a broadcast', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');
    const start = src.indexOf('notifyDesktop: (notice) =>');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('lanAddresses:', start));
    expect(block).toContain('pickNoticeTarget(');
    expect(block).not.toContain('broadcastMetadataUpdate');
  });
});

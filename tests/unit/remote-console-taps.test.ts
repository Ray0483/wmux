import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WebContents } from 'electron';
import { installRemoteTaps, remoteTaps, resetRemoteTaps } from '../../src/main/remote-console/taps';

afterEach(() => resetRemoteTaps());

const wc = {} as WebContents;

describe('remoteTaps (#254)', () => {
  it('defaults are no-ops', () => {
    expect(() => {
      remoteTaps.bindSurface('s', wc);
      remoteTaps.deliver('s', 'data');
      remoteTaps.exit('s', 0);
      remoteTaps.noteResize('s');
      remoteTaps.noteDesktopInput('s');
      remoteTaps.unbindSurface('s');
    }).not.toThrow();
    expect(remoteTaps.deliver('s', 'x')).toBeUndefined();
  });

  it('routes calls to installed functions, leaving the rest as defaults', () => {
    const deliver = vi.fn();
    installRemoteTaps({ deliver });
    remoteTaps.deliver('s', 'abc');
    expect(deliver).toHaveBeenCalledWith('s', 'abc');
    expect(() => remoteTaps.exit('s', 1)).not.toThrow();
  });

  it('swallows a throwing tap and reports it', () => {
    const onError = vi.fn();
    installRemoteTaps({ deliver: () => { throw new Error('boom'); } }, onError);
    expect(() => remoteTaps.deliver('s', 'x')).not.toThrow();
    expect(onError).toHaveBeenCalledWith('deliver', expect.any(Error));
  });

  it('a throwing error reporter is swallowed too', () => {
    installRemoteTaps({ exit: () => { throw new Error('a'); } }, () => { throw new Error('b'); });
    expect(() => remoteTaps.exit('s', 0)).not.toThrow();
  });

  it('reset restores the defaults', () => {
    const deliver = vi.fn();
    installRemoteTaps({ deliver });
    resetRemoteTaps();
    remoteTaps.deliver('s', 'x');
    expect(deliver).not.toHaveBeenCalled();
  });
});

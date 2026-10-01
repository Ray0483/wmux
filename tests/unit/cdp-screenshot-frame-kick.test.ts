import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({ webContents: { fromId: () => undefined } }));

import {
  withFrameKick, FRAME_KICK_DELAY_MS, FRAME_KICK_INTERVAL_MS, SCREENSHOT_DEADLINE_MS,
} from '../../src/main/cdp-bridge';

// #262: Page.captureScreenshot waits for the NEXT compositor frame, and an
// occluded wmux window produces none, so the capture hung until the CLI's 10 s
// deadline. The fix invalidates the guest until a frame lands.
describe('withFrameKick (#262)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeWc() {
    return { invalidate: vi.fn(), isDestroyed: () => false };
  }

  it('never touches a page that answers promptly', async () => {
    const wc = fakeWc();
    await expect(withFrameKick(wc, Promise.resolve('png'))).resolves.toBe('png');
    await vi.advanceTimersByTimeAsync(SCREENSHOT_DEADLINE_MS * 2);
    expect(wc.invalidate).not.toHaveBeenCalled();
  });

  it('invalidates a stalled page until the frame arrives, then stops', async () => {
    const wc = fakeWc();
    let deliver!: (v: string) => void;
    // A frame "arrives" as soon as anyone invalidates: the real behaviour the
    // harness measured.
    wc.invalidate.mockImplementation(() => deliver('png'));
    const capture = new Promise<string>((r) => { deliver = r; });
    const p = withFrameKick(wc, capture);
    await vi.advanceTimersByTimeAsync(FRAME_KICK_DELAY_MS);
    await expect(p).resolves.toBe('png');
    expect(wc.invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FRAME_KICK_INTERVAL_MS * 4);
    expect(wc.invalidate).toHaveBeenCalledTimes(1);
  });

  it('keeps nudging, then names the cause under the CLI deadline', async () => {
    const wc = fakeWc();
    const p = withFrameKick(wc, new Promise<string>(() => {}));
    const outcome = expect(p).rejects.toThrow(/produced no frame/);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_DEADLINE_MS + FRAME_KICK_INTERVAL_MS);
    await outcome;
    expect(wc.invalidate.mock.calls.length).toBeGreaterThan(5);
    expect(SCREENSHOT_DEADLINE_MS + FRAME_KICK_INTERVAL_MS).toBeLessThan(10_000);
  });

  it('passes a capture error through untouched', async () => {
    const wc = fakeWc();
    await expect(withFrameKick(wc, Promise.reject(new Error('browser_not_open')))).rejects.toThrow('browser_not_open');
  });
});

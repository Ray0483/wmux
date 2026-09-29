import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: unknown[] = [];
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_ch: string, p: unknown) => sent.push(p) } }],
  },
}));

import { onAgentStateBroadcast, reportAgent, resetAgentState, clearAgentState } from '../../src/main/agent-state';
import type { SurfaceId } from '../../src/shared/types';

const SID = 'surf-1' as SurfaceId;

/**
 * `onAgentStateBroadcast` is how the Remote Console learns a declared state
 * changed without polling (#254). It rides the same `send()` the renderer
 * broadcast does, so "the sidebar changed" and "the phone was told" cannot
 * disagree about WHEN.
 */
describe('onAgentStateBroadcast (#254)', () => {
  beforeEach(() => {
    resetAgentState();
    sent.length = 0;
  });

  it('fires on every broadcast, after the renderer has been sent the state', () => {
    let calls = 0;
    let sentWhenCalled = -1;
    const off = onAgentStateBroadcast(() => { calls++; sentWhenCalled = sent.length; });
    reportAgent(SID, { awaitingHuman: true, reason: 'permission: Bash' });
    expect(calls).toBe(1);
    expect(sentWhenCalled).toBe(1);
    // A forgotten pane announces `unknown` through the same send().
    clearAgentState(SID);
    expect(calls).toBe(2);
    off();
  });

  it('stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = onAgentStateBroadcast(listener);
    off();
    reportAgent(SID, { runDelta: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a listener that throws — the report and the other listeners still land', () => {
    const offBad = onAgentStateBroadcast(() => { throw new Error('console bug'); });
    const good = vi.fn();
    const offGood = onAgentStateBroadcast(good);
    expect(() => reportAgent(SID, { awaitingHuman: true })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    offBad();
    offGood();
  });
});

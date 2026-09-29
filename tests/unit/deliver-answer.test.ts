import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
}));

import { deliverAnswer, setAnswerWriter } from '../../src/main/agent-state-rpc';
import { reportAgent, resetAgentState, getAgentState, currentPromptId } from '../../src/main/agent-state';
import type { SurfaceId } from '../../src/shared/types';

const SID = 'surf-1' as SurfaceId;
const CHOICES = [
  { id: 'allow', label: 'Allow', key: '1' },
  { id: 'deny', label: 'Deny', text: 'no' },
];

let written: Array<{ surfaceId: string; payload: { key?: string; text?: string } }>;

function block(choices: unknown[] = CHOICES): void {
  reportAgent(SID, { awaitingHuman: true, reason: 'permission: Bash', choices: choices as any });
}

/**
 * `deliverAnswer` is the Remote Console's only way to answer a prompt (#254,
 * I4): the same guard as `pane.answer_agent`, with a narrower result so the
 * choice's payload never reaches the console runtime (I7).
 */
describe('deliverAnswer (#254)', () => {
  beforeEach(() => {
    resetAgentState();
    written = [];
    setAnswerWriter((surfaceId, payload) => { written.push({ surfaceId, payload }); });
  });

  it('a prompt id the pane is no longer asking is stale and writes nothing (#254)', async () => {
    block();
    const p = currentPromptId(SID)!;
    expect(await deliverAnswer(SID, 'allow', p + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(await deliverAnswer(SID, 'allow', 0)).toEqual({ ok: false, reason: 'stale' });
    expect(written).toEqual([]);
    expect(await deliverAnswer(SID, 'allow', p)).toEqual({ ok: true });
  });

  it('writes the declared payload and answers only { ok: true }', async () => {
    block();
    const res = await deliverAnswer(SID, 'allow');
    expect(res).toEqual({ ok: true });
    expect(written).toEqual([{ surfaceId: SID, payload: { key: '1', text: undefined } }]);
  });

  it('consumes the choices — a second answer is refused and writes nothing', async () => {
    block();
    await deliverAnswer(SID, 'allow');
    const again = await deliverAnswer(SID, 'allow');
    expect(again.ok).toBe(false);
    expect(written).toHaveLength(1);
  });

  it('never clears blocked — the agent confirms that itself (#128)', async () => {
    block();
    await deliverAnswer(SID, 'deny');
    expect(getAgentState(SID)?.state).toBe('blocked');
  });

  it.each([
    ['unknown-surface', () => {}, 'allow'],
    ['not-blocked', () => reportAgent(SID, { runDelta: 1 }), 'allow'],
    ['no-choices', () => block([]), 'allow'],
    ['unknown-choice', () => block(), 'rm-rf'],
  ] as const)('maps %s', async (reason, setup, choiceId) => {
    setup();
    expect(await deliverAnswer(SID, choiceId)).toEqual({ ok: false, reason });
    expect(written).toEqual([]);
  });

  it('maps a throwing writer to write-failed, carrying no message', async () => {
    setAnswerWriter(() => { throw new Error('the agent declared an unknown key name: "wat"'); });
    block();
    expect(await deliverAnswer(SID, 'allow')).toEqual({ ok: false, reason: 'write-failed' });
  });

  it.each(['', '   ', 'has space', 'x'.repeat(33)])(
    'refuses an unnamed or malformed choice id %j — never the default (I4)',
    async (choiceId) => {
      // One choice, flagged default: exactly what answerAgent resolves an
      // UNNAMED answer to. The console must never reach that branch.
      block([{ id: 'allow', label: 'Allow', key: '1', isDefault: true }]);
      expect(await deliverAnswer(SID, choiceId)).toEqual({ ok: false, reason: 'unknown-choice' });
      expect(written).toEqual([]);
      // Nothing consumed: the real button still works afterwards.
      expect(await deliverAnswer(SID, 'allow')).toEqual({ ok: true });
    },
  );

  it('consumes the choices in the SAME tick as the call, before any await', () => {
    block();
    void deliverAnswer(SID, 'allow');
    expect(getAgentState(SID)?.choices).toEqual([]);
  });

  it('maps a rejecting writer to write-failed', async () => {
    setAnswerWriter(async () => { throw new Error('gone'); });
    block();
    expect(await deliverAnswer(SID, 'allow')).toEqual({ ok: false, reason: 'write-failed' });
  });
});

describe('deliverAnswer with no writer wired (#254)', () => {
  it('is write-failed, and still consumed the choices', async () => {
    vi.resetModules();
    const rpc = await import('../../src/main/agent-state-rpc');
    const state = await import('../../src/main/agent-state');
    state.resetAgentState();
    state.reportAgent(SID, { awaitingHuman: true, choices: CHOICES as any });
    expect(await rpc.deliverAnswer(SID, 'allow')).toEqual({ ok: false, reason: 'write-failed' });
    expect(state.getAgentState(SID)?.state).toBe('blocked');
  });
});

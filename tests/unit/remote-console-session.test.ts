import { describe, it, expect, vi } from 'vitest';
import { ConsoleSession, createDeviceSessionState, NonceLru, SUBMIT_GAP_MS } from '../../src/main/remote-console/session';
import type { SessionDeps, SessionOps } from '../../src/main/remote-console/session';
import type { RemoteScope, ServerMessage } from '../../src/shared/remote-console-protocol';
import { CLOSE_CODES, MAX_TEXT } from '../../src/shared/remote-console-protocol';

const S = 'surf-00000001-0000-4000-8000-000000000000';
let nonceSeq = 0;
const nonce = (): string => `nonce-${String(++nonceSeq).padStart(4, '0')}`;

interface Harness {
  session: ConsoleSession;
  sent: ServerMessage[];
  calls: string[];
  closed: { code: number; reason: string }[];
  state: { blocked: boolean; live: boolean; runDepth: number; bracketed: boolean | 'none' };
  ops: SessionOps & { deliverAnswer: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };
  deps: SessionDeps;
  advance: (ms: number) => void;
  frame: (msg: unknown) => Promise<void>;
  acks: () => Extract<ServerMessage, { t: 'ack' }>[];
}

function harness(opts: { scope?: RemoteScope; effective?: RemoteScope; hello?: boolean; clearBlockedOnInput?: boolean } = {}): Harness {
  let t = 1_000_000;
  const sent: ServerMessage[] = [];
  const calls: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  const state = { blocked: false, live: true, runDepth: 0, bracketed: true as boolean | 'none' };
  const ops = {
    isLivePty: () => state.live,
    isBlocked: () => state.blocked,
    runDepth: () => state.runDepth,
    isAnsweringInput: (b: string) => b === '\r' || b === 'y' || b === 'n' || /^[\x20-\x7e]/.test(b),
    noteHumanInput: (_s: string, b: string) => {
      calls.push(`note:${JSON.stringify(b)}`);
      // The real agent-state clears blocked when a human answers (#128): this is
      // the fake that would expose a wasBlocked read AFTER noteHumanInput.
      if (opts.clearBlockedOnInput !== false) state.blocked = false;
    },
    write: (_s: string, b: string) => {
      calls.push(`write:${JSON.stringify(b)}`);
    },
    deliverAnswer: vi.fn(async () => ({ ok: true as const })),
    log: vi.fn(),
  };
  const deps: SessionDeps = {
    ops,
    device: { id: 'dev-1', name: 'Phone', scope: opts.scope ?? 'operator' },
    effectiveScope: opts.effective ?? opts.scope ?? 'operator',
    deviceState: createDeviceSessionState(() => t),
    host: 'HOST',
    version: '9.9.9',
    send: (m) => sent.push(m),
    close: (code, reason) => closed.push({ code, reason }),
    queryModes: async () => (state.bracketed === 'none' ? { error: 'no-terminal' as const } : { bracketedPaste: state.bracketed }),
    onHello: vi.fn(),
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    onSeen: vi.fn(),
    now: () => t,
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
  };
  const session = new ConsoleSession(deps);
  const h: Harness = {
    session, sent, calls, closed, state, ops, deps,
    advance: (ms) => { t += ms; },
    frame: (msg) => session.handleFrame(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    acks: () => sent.filter((m): m is Extract<ServerMessage, { t: 'ack' }> => m.t === 'ack'),
  };
  return h;
}

async function greeted(opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(opts);
  await h.frame({ t: 'hello', v: 1 });
  h.sent.length = 0;
  return h;
}

describe('session: hello gate (#254 rule 1)', () => {
  it('the first frame must be hello; anything else closes 4400', async () => {
    const h = harness();
    await h.frame({ t: 'ping' });
    expect(h.closed).toEqual([{ code: CLOSE_CODES.HELLO, reason: 'hello-required' }]);
    await h.frame({ t: 'hello', v: 1 });
    expect(h.sent).toEqual([]);
  });

  it('a version mismatch closes 4400; garbage before hello closes 4400', async () => {
    const a = harness();
    await a.frame({ t: 'hello', v: 2 });
    expect(a.closed[0].code).toBe(4400);
    const b = harness();
    await b.frame('{nope');
    expect(b.closed[0].code).toBe(4400);
  });

  it('welcome carries device, effective scope, host, version and limits', async () => {
    const h = harness({ scope: 'operator', effective: 'viewer' });
    await h.frame({ t: 'hello', v: 1 });
    expect(h.sent).toEqual([{
      t: 'welcome', v: 1, device: { id: 'dev-1', name: 'Phone', scope: 'operator' },
      effectiveScope: 'viewer', host: 'HOST', version: '9.9.9', limits: { maxText: MAX_TEXT },
    }]);
    expect(h.deps.onHello).toHaveBeenCalledTimes(1);
  });

  it('after hello a bad frame is an error, not a close', async () => {
    const h = await greeted();
    await h.frame({ t: 'send', s: S });
    expect(h.sent).toEqual([{ t: 'error', code: 'bad-frame', message: expect.any(String) }]);
    expect(h.closed).toEqual([]);
  });

  it('ping, attach, detach, seen', async () => {
    const h = await greeted();
    await h.frame({ t: 'ping' });
    expect(h.sent).toEqual([{ t: 'pong' }]);
    await h.frame({ t: 'attach', s: S });
    expect(h.deps.onAttach).toHaveBeenCalledWith(S);
    await h.frame({ t: 'seen', s: S });
    expect(h.deps.onSeen).toHaveBeenCalledWith(S);
    await h.frame({ t: 'detach' });
    expect(h.deps.onDetach).toHaveBeenCalled();
  });

  it('attach to a dead surface is term.error{no-terminal}', async () => {
    const h = await greeted();
    h.state.live = false;
    await h.frame({ t: 'attach', s: S });
    expect(h.sent).toEqual([{ t: 'term.error', s: S, code: 'no-terminal', message: expect.any(String) }]);
    expect(h.deps.onAttach).not.toHaveBeenCalled();
  });
});

describe('session: scope', () => {
  it('a viewer can never cause a write, a noteHumanInput or an answer', async () => {
    const h = await greeted({ scope: 'viewer' });
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'rm -rf /', submit: true, force: true });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter', force: true });
    expect(h.calls).toEqual([]);
    expect(h.ops.deliverAnswer).not.toHaveBeenCalled();
    expect(h.acks().every((a) => a.code === 'forbidden' && !a.ok)).toBe(true);
  });

  it('an operator device on an insecure LAN bind is effectively a viewer', async () => {
    const h = await greeted({ scope: 'operator', effective: 'viewer' });
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y' });
    expect(h.ops.deliverAnswer).not.toHaveBeenCalled();
    expect(h.acks()[0].code).toBe('forbidden');
  });

  it('three forbidden attempts in 60 s close 4429', async () => {
    const h = await greeted({ scope: 'viewer' });
    for (let i = 0; i < 3; i++) await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'y' });
    expect(h.closed).toEqual([{ code: CLOSE_CODES.RATE, reason: 'rate' }]);
  });
});

describe('session: send (rule 4)', () => {
  it('noteHumanInput precedes write with identical bytes; submit is a separate \\r after 40 ms', async () => {
    const h = await greeted();
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'hello', submit: true });
    expect(h.calls).toEqual([
      'note:"\\u001b[200~hello\\u001b[201~"', 'write:"\\u001b[200~hello\\u001b[201~"',
      `sleep:${SUBMIT_GAP_MS}`,
      'note:"\\r"', 'write:"\\r"',
    ]);
    expect(h.acks()).toEqual([{ t: 'ack', nonce: expect.any(String), ok: true }]);
  });

  it('CRITICAL: blocked is read before noteHumanInput — a fake that clears blocked still gets confirm and zero writes', async () => {
    const h = await greeted({ clearBlockedOnInput: true });
    h.state.blocked = true;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'y', submit: true });
    expect(h.calls).toEqual([]);
    expect(h.acks()).toEqual([{ t: 'ack', nonce: expect.any(String), ok: false, code: 'confirm', confirm: 'blocked' }]);
    expect(h.state.blocked).toBe(true);
  });

  it('force inserts into a blocked pane', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'note', submit: false, force: true });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
    expect(h.acks()[0].ok).toBe(true);
  });

  it('multiline without bracketed paste asks to confirm; force sends CR-joined lines', async () => {
    const h = await greeted();
    h.state.bracketed = false;
    const n = nonce();
    await h.frame({ t: 'send', s: S, nonce: n, text: 'a\nb', submit: false });
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'multiline' });
    expect(h.calls).toEqual([]);
    // Refusals are not recorded, so the SAME nonce can be resent with force.
    await h.frame({ t: 'send', s: S, nonce: n, text: 'a\nb', submit: false, force: true });
    expect(h.calls).toEqual(['note:"a\\rb"', 'write:"a\\rb"']);
    expect(h.acks()[1]).toEqual({ t: 'ack', nonce: n, ok: true });
  });

  it('a modes timeout/no-terminal reads as not bracketed (never the phone\'s opinion)', async () => {
    const h = await greeted();
    h.state.bracketed = 'none';
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'one line', submit: false });
    expect(h.calls).toEqual(['note:"one line"', 'write:"one line"']);
  });

  it('too-long, empty no-op, gone, sanitisation', async () => {
    const h = await greeted();
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x'.repeat(MAX_TEXT + 1), submit: false });
    expect(h.acks()[0].code).toBe('too-long');
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: '\x1b\x07', submit: false });
    expect(h.acks()[1].ok).toBe(true);
    expect(h.calls).toEqual([]);
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'a\x1b[201~b', submit: false });
    expect(h.calls).toEqual(['note:"\\u001b[200~a[201~b\\u001b[201~"', 'write:"\\u001b[200~a[201~b\\u001b[201~"']);
    h.state.live = false;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: true });
    expect(h.acks().at(-1)?.code).toBe('gone');
  });

  it('re-checks isLivePty after the modes await', async () => {
    const h = await greeted();
    h.deps.queryModes = async () => {
      h.state.live = false;
      return { bracketedPaste: true };
    };
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: false });
    expect(h.acks()[0].code).toBe('gone');
    expect(h.calls).toEqual([]);
  });

  it('a write that throws is write-failed', async () => {
    const h = await greeted();
    h.ops.write = () => { throw new Error('pty gone'); };
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: false });
    expect(h.acks()[0].code).toBe('write-failed');
  });

  it('logs byte counts, never the text', async () => {
    const h = await greeted();
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'my password', submit: true });
    expect(JSON.stringify(h.ops.log.mock.calls)).not.toContain('password');
    expect(h.ops.log).toHaveBeenCalledWith('remote-input', { device: 'dev-1', surface: S, bytes: expect.any(Number), submit: true });
  });
});

describe('session: nonce dedupe (rule 3)', () => {
  it('an executed nonce is acked duplicate with no second write', async () => {
    const h = await greeted();
    const n = nonce();
    await h.frame({ t: 'key', s: S, nonce: n, key: 'up' });
    await h.frame({ t: 'key', s: S, nonce: n, key: 'up' });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
    expect(h.acks()[1]).toEqual({ t: 'ack', nonce: n, ok: true, duplicate: true });
  });

  it('a resend while the original is in flight waits for it and writes once', async () => {
    const h = await greeted();
    let release: () => void = () => undefined;
    h.deps.queryModes = () => new Promise((r) => { release = () => r({ bracketedPaste: false }); });
    const n = nonce();
    const first = h.frame({ t: 'send', s: S, nonce: n, text: 'x', submit: false });
    const second = h.frame({ t: 'send', s: S, nonce: n, text: 'x', submit: false });
    release();
    await Promise.all([first, second]);
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
    expect(h.acks().map((a) => a.duplicate ?? false).sort()).toEqual([false, true]);
  });

  it('the LRU expires after 10 minutes and holds 256', () => {
    let t = 0;
    const lru = new NonceLru(() => t);
    lru.record('a');
    t += 10 * 60_000 + 1;
    expect(lru.has('a')).toBe(false);
    for (let i = 0; i < 300; i++) lru.record('n' + i);
    expect(lru.has('n0')).toBe(false);
    expect(lru.has('n299')).toBe(true);
  });
});

describe('session: key (rule 5)', () => {
  it('Enter while blocked confirms; arrows pass', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter' });
    expect(h.acks()[0]).toMatchObject({ code: 'confirm', confirm: 'blocked' });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'down' });
    expect(h.calls).toEqual(['note:"\\u001b[B"', 'write:"\\u001b[B"']);
  });

  it('y while blocked, with a fake that clears blocked on input, still confirms with no write', async () => {
    const h = await greeted({ clearBlockedOnInput: true });
    h.state.blocked = true;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'y' });
    expect(h.calls).toEqual([]);
    expect(h.acks()[0].confirm).toBe('blocked');
  });

  it('ESC and ^C confirm an interrupt while a run is active; force sends', async () => {
    const h = await greeted();
    h.state.runDepth = 1;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'esc' });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-c' });
    expect(h.acks().map((a) => a.confirm)).toEqual(['interrupt', 'interrupt']);
    expect(h.calls).toEqual([]);
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-c', force: true });
    expect(h.calls).toEqual(['note:"\\u0003"', 'write:"\\u0003"']);
  });

  it('ESC with no run in progress goes straight through', async () => {
    const h = await greeted();
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'esc' });
    expect(h.calls).toEqual(['note:"\\u001b"', 'write:"\\u001b"']);
  });

  it('20 keys a second per device; a trip is ack rate', async () => {
    const h = await greeted();
    for (let i = 0; i < 21; i++) await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'up' });
    expect(h.acks().at(-1)).toMatchObject({ ok: false, code: 'rate' });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(20);
  });
});

describe('session: answer (rule 6)', () => {
  it('goes through deliverAnswer and NEVER calls noteHumanInput', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'yes_1' });
    expect(h.ops.deliverAnswer).toHaveBeenCalledWith(S, 'yes_1');
    expect(h.calls).toEqual([]);
    expect(h.acks()[0].ok).toBe(true);
  });

  it.each([
    ['not-blocked', 'not-blocked'],
    ['no-choices', 'no-choices'],
    ['unknown-choice', 'unknown-choice'],
    ['unknown-surface', 'gone'],
    ['write-failed', 'write-failed'],
  ])('reason %s → ack %s', async (reason, code) => {
    const h = await greeted();
    h.ops.deliverAnswer.mockResolvedValueOnce({ ok: false, reason });
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y' });
    expect(h.acks()[0]).toMatchObject({ ok: false, code });
  });

  it('a throwing deliverAnswer is write-failed, not an unhandled rejection', async () => {
    const h = await greeted();
    h.ops.deliverAnswer.mockRejectedValueOnce(new Error('boom'));
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y' });
    expect(h.acks()[0].code).toBe('write-failed');
  });
});

describe('session: frame rate (rule 7)', () => {
  it('flooding past 100 frames errors with rate, and three trips close 4429', async () => {
    const h = await greeted();
    for (let i = 0; i < 103; i++) await h.frame({ t: 'ping' });
    expect(h.sent.filter((m) => m.t === 'error' && m.code === 'rate')).toHaveLength(3);
    expect(h.closed).toEqual([{ code: CLOSE_CODES.RATE, reason: 'rate' }]);
    const before = h.sent.length;
    await h.frame({ t: 'ping' });
    expect(h.sent.length).toBe(before);
  });

  it('dispose detaches and drops further frames', async () => {
    const h = await greeted();
    h.session.dispose();
    await h.frame({ t: 'ping' });
    expect(h.sent).toEqual([]);
    expect(h.deps.onDetach).toHaveBeenCalled();
  });
});

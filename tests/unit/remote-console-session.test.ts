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
  state: { blocked: boolean; live: boolean; runDepth: number; bracketed: boolean | 'none'; prompt: number };
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
  const state = { blocked: false, live: true, runDepth: 0, bracketed: true as boolean | 'none', prompt: 7 };
  const ops = {
    isLivePty: () => state.live,
    isBlocked: () => state.blocked,
    runDepth: () => state.runDepth,
    promptId: () => (state.blocked ? state.prompt : null),
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

const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

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
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'rm -rf /', submit: true, force: ['blocked', 'multiline'] });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter', force: ['blocked'], prompt: 7 });
    expect(h.calls).toEqual([]);
    expect(h.ops.deliverAnswer).not.toHaveBeenCalled();
    expect(h.acks().every((a) => a.code === 'forbidden' && !a.ok)).toBe(true);
  });

  it('an operator device on an insecure LAN bind is effectively a viewer', async () => {
    const h = await greeted({ scope: 'operator', effective: 'viewer' });
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y', prompt: 7 });
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
    expect(h.acks()).toEqual([{ t: 'ack', nonce: expect.any(String), ok: false, code: 'confirm', confirm: 'blocked', prompt: 7 }]);
    expect(h.state.blocked).toBe(true);
  });

  it('force inserts into a blocked pane', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'note', submit: false, force: ['blocked'], prompt: 7 });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
    expect(h.acks()[0].ok).toBe(true);
  });

  it('multiline without bracketed paste asks to confirm; force sends CR-joined lines', async () => {
    const h = await greeted();
    h.state.bracketed = false;
    const n = nonce();
    await h.frame({ t: 'send', s: S, nonce: n, text: 'a\nb', submit: true });
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'multiline' });
    expect(h.calls).toEqual([]);
    // Refusals are not recorded, so the SAME nonce can be resent with force.
    await h.frame({ t: 'send', s: S, nonce: n, text: 'a\nb', submit: true, force: ['multiline'] });
    expect(h.calls).toEqual(['note:"a\\rb"', 'write:"a\\rb"', `sleep:${SUBMIT_GAP_MS}`, 'note:"\\r"', 'write:"\\r"']);
    expect(h.acks()[1]).toEqual({ t: 'ack', nonce: n, ok: true });
  });

  it('a multiline Insert into a non-bracketed pane is refused outright: every LF would be an Enter', async () => {
    const h = await greeted();
    h.state.bracketed = false;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'a\nb', submit: false, force: ['blocked', 'multiline'] });
    expect(h.calls).toEqual([]);
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'multiline-insert' });
    // A modes timeout reads as not bracketed, so it is refused the same way.
    h.state.bracketed = 'none';
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'a\nb', submit: false });
    expect(h.acks()[1]).toMatchObject({ ok: false, code: 'multiline-insert' });
    expect(h.calls).toEqual([]);
  });

  it('accepting the blocked confirm does not waive the multiline one (and the reverse)', async () => {
    // The reported repro: blocked pane, not bracketed, "a\nb", user accepts
    // "Insert". A single boolean force skipped the multiline check and typed
    // "a\rb" — whose CR answered the prompt.
    const h = await greeted();
    h.state.blocked = true;
    h.state.bracketed = false;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'a\nb', submit: false, force: ['blocked'], prompt: 7 });
    expect(h.calls).toEqual([]);
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'multiline-insert' });
    expect(h.state.blocked).toBe(true);
    // Reverse: multiline accepted while idle, the agent blocks before the resend.
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'a\nb', submit: true, force: ['multiline'] });
    expect(h.calls).toEqual([]);
    expect(h.acks()[1]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked' });
    // Waiving interrupt says nothing about blocked either.
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter', force: ['interrupt'] });
    expect(h.acks()[2]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked' });
    expect(h.calls).toEqual([]);
  });

  it('an agent that blocks during the 40 ms submit gap keeps its prompt: the Enter is withheld and the ack says so', async () => {
    const h = await greeted();
    h.deps.sleep = async (ms) => {
      h.calls.push(`sleep:${ms}`);
      h.state.blocked = true;
    };
    const n = nonce();
    await h.frame({ t: 'send', s: S, nonce: n, text: 'hello', submit: true });
    expect(h.calls).toEqual([
      'note:"\\u001b[200~hello\\u001b[201~"', 'write:"\\u001b[200~hello\\u001b[201~"',
      `sleep:${SUBMIT_GAP_MS}`,
    ]);
    expect(h.state.blocked).toBe(true);
    // ok (the text landed, so it is recorded and a resend is a duplicate), with the Enter withheld.
    expect(h.acks()[0]).toEqual({ t: 'ack', nonce: n, ok: true, submitSkipped: true });
    await h.frame({ t: 'send', s: S, nonce: n, text: 'hello', submit: true });
    expect(h.acks()[1]).toMatchObject({ ok: true, duplicate: true });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(1);
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

  it('re-checks blocked after the modes await: a pane that went blocked meanwhile confirms, zero writes', async () => {
    // Text + Enter landing on a permission prompt that appeared during the
    // (up to 2 s) modes round trip would answer it unasked.
    const h = await greeted();
    h.deps.queryModes = async () => {
      h.state.blocked = true;
      return { bracketedPaste: true };
    };
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'yes', submit: true });
    expect(h.calls).toEqual([]);
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked' });
    // force still goes through.
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'yes', submit: true, force: ['blocked'], prompt: 7 });
    expect(h.calls.filter((c) => c.startsWith('write'))).toHaveLength(2);
  });

  it('a session disposed during the modes await (revoke, stop) writes nothing', async () => {
    const h = await greeted();
    h.deps.queryModes = async () => {
      h.session.dispose();
      return { bracketedPaste: true };
    };
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: true });
    expect(h.calls).toEqual([]);
  });

  it('a session disposed during the submit gap does not send the trailing Enter', async () => {
    const h = await greeted();
    h.deps.sleep = async () => {
      h.session.dispose();
    };
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: true });
    expect(h.calls.filter((c) => c.startsWith('write'))).toEqual(['write:"\\u001b[200~x\\u001b[201~"']);
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
    // The action starts on the device queue, one microtask later.
    await flush();
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

  it('^C and ^D on a declared-blocked pane with NO run open still confirm first (#254)', async () => {
    // The global CLAUDE.md recipe reports --blocked without --run-start, so
    // runDepth is 0 and the interrupt confirm never fires: one tap of ^C used
    // to cancel the permission prompt, and ^D was never confirmed at all.
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-c' });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-d' });
    expect(h.acks().map((a) => a.confirm)).toEqual(['blocked', 'blocked']);
    expect(h.calls).toEqual([]);
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-d', force: ['blocked'], prompt: 7 });
    expect(h.calls).toEqual(['note:"\\u0004"', 'write:"\\u0004"']);
  });

  it('ESC and ^C confirm an interrupt while a run is active; force sends', async () => {
    const h = await greeted();
    h.state.runDepth = 1;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'esc' });
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-c' });
    expect(h.acks().map((a) => a.confirm)).toEqual(['interrupt', 'interrupt']);
    expect(h.calls).toEqual([]);
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'ctrl-c', force: ['interrupt'] });
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
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'yes_1', prompt: 7 });
    expect(h.ops.deliverAnswer).toHaveBeenCalledWith(S, 'yes_1', 7);
    expect(h.calls).toEqual([]);
    expect(h.acks()[0].ok).toBe(true);
  });

  it.each([
    ['not-blocked', 'not-blocked'],
    ['no-choices', 'no-choices'],
    ['unknown-choice', 'unknown-choice'],
    ['unknown-surface', 'gone'],
    ['write-failed', 'write-failed'],
    ['stale', 'stale'],
  ])('reason %s → ack %s', async (reason, code) => {
    const h = await greeted();
    h.ops.deliverAnswer.mockResolvedValueOnce({ ok: false, reason });
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y', prompt: 7 });
    expect(h.acks()[0]).toMatchObject({ ok: false, code });
  });

  it('a throwing deliverAnswer is write-failed, not an unhandled rejection', async () => {
    const h = await greeted();
    h.ops.deliverAnswer.mockRejectedValueOnce(new Error('boom'));
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y', prompt: 7 });
    expect(h.acks()[0].code).toBe('write-failed');
  });

  it('an answer with no prompt id is a bad frame: it cannot say which question it answers', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'answer', s: S, nonce: nonce(), choiceId: 'y' });
    expect(h.ops.deliverAnswer).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ t: 'error', code: 'bad-frame' });
  });
});

describe('session: a blocked waiver is about ONE prompt (#254)', () => {
  it('a confirm names the prompt it is about', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter' });
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked', prompt: 7 });
  });

  it('a key waiver for a prompt the pane moved on from is asked again, not typed', async () => {
    const h = await greeted();
    h.state.blocked = true;
    h.state.prompt = 8;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'enter', force: ['blocked'], prompt: 7 });
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked', prompt: 8 });
    expect(h.calls).toEqual([]);
  });

  it('a key waiver with no prompt at all is asked again', async () => {
    const h = await greeted();
    h.state.blocked = true;
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'y', force: ['blocked'] });
    expect(h.acks()[0]).toMatchObject({ code: 'confirm', confirm: 'blocked' });
    expect(h.calls).toEqual([]);
  });

  it('an Insert waiver for a stale prompt is asked again', async () => {
    const h = await greeted();
    h.state.blocked = true;
    h.state.prompt = 9;
    await h.frame({ t: 'send', s: S, nonce: nonce(), text: 'note', submit: false, force: ['blocked'], prompt: 7 });
    expect(h.acks()[0]).toMatchObject({ code: 'confirm', confirm: 'blocked', prompt: 9 });
    expect(h.calls).toEqual([]);
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

describe('session: review fixes, round 3 (#254)', () => {
  it('Shift+Tab on a blocked pane confirms: its CSI bytes are not navigation there', async () => {
    const h = await greeted();
    h.state.blocked = true;
    // The harness's byte check says no to ESC [ Z, exactly like the real one.
    expect(h.ops.isAnsweringInput('\x1b[Z')).toBe(false);
    await h.frame({ t: 'key', s: S, nonce: nonce(), key: 'shift-tab' });
    expect(h.acks()[0]).toMatchObject({ ok: false, code: 'confirm', confirm: 'blocked', prompt: 7 });
    expect(h.calls).toEqual([]);
    for (const key of ['tab', 'backspace', 'esc'] as const) {
      await h.frame({ t: 'key', s: S, nonce: nonce(), key });
    }
    expect(h.acks().slice(1).map((a) => a.confirm)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(h.calls).toEqual([]);
  });

  it('a key tapped while a send awaits the desktop modes waits for it: text, then its Enter, then the key', async () => {
    const h = await greeted();
    let release: () => void = () => undefined;
    h.deps.queryModes = () => new Promise((r) => { release = () => r({ bracketedPaste: false }); });
    const send = h.frame({ t: 'send', s: S, nonce: nonce(), text: 'hi', submit: true });
    const key = h.frame({ t: 'key', s: S, nonce: nonce(), key: 'up' });
    await flush();
    expect(h.calls).toEqual([]);
    release();
    await Promise.all([send, key]);
    expect(h.calls).toEqual([
      'note:"hi"', 'write:"hi"', `sleep:${SUBMIT_GAP_MS}`, 'note:"\\r"', 'write:"\\r"',
      'note:"\\u001b[A"', 'write:"\\u001b[A"',
    ]);
  });

  it('a queued action whose session was disposed while it waited writes nothing', async () => {
    const h = await greeted();
    let release: () => void = () => undefined;
    h.deps.queryModes = () => new Promise((r) => { release = () => r({ bracketedPaste: true }); });
    const send = h.frame({ t: 'send', s: S, nonce: nonce(), text: 'x', submit: false });
    const key = h.frame({ t: 'key', s: S, nonce: nonce(), key: 'up' });
    h.session.dispose();
    release();
    await Promise.all([send, key]);
    expect(h.calls).toEqual([]);
  });

  it('accepting a confirm does not charge the byte budget twice', async () => {
    const h = await greeted();
    h.state.bracketed = false;
    // 36 KB of three-byte characters, on two lines: a multiline confirm first.
    const text = '字'.repeat(6000) + '\n' + '字'.repeat(6000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(32768);
    const n = nonce();
    await h.frame({ t: 'send', s: S, nonce: n, text, submit: true });
    expect(h.acks()[0]).toMatchObject({ code: 'confirm', confirm: 'multiline' });
    await h.frame({ t: 'send', s: S, nonce: n, text, submit: true, force: ['multiline'] });
    expect(h.acks()[1]).toEqual({ t: 'ack', nonce: n, ok: true });
  });

  it('attach is limited per device: a viewer cannot make the desktop serialize 50 buffers a second', async () => {
    const h = await greeted({ scope: 'viewer' });
    for (let i = 0; i < 6; i++) await h.frame({ t: 'attach', s: S });
    expect(h.deps.onAttach).toHaveBeenCalledTimes(4);
    // Scoped to the surface, so the view waiting on it can say so and retry
    // rather than sit on "Loading screen…" (a bare `error` has no `s`).
    expect(h.sent.filter((m) => m.t === 'term.error' && m.code === 'rate' && m.s === S)).toHaveLength(2);
    expect(h.sent.filter((m) => m.t === 'error')).toEqual([]);
    expect(h.closed).toEqual([]);
    h.advance(1000);
    await h.frame({ t: 'attach', s: S });
    expect(h.deps.onAttach).toHaveBeenCalledTimes(5);
  });
});

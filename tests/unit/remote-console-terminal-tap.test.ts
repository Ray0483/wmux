import { describe, it, expect } from 'vitest';
import { TAP_TIMINGS, TerminalTap } from '../../src/main/remote-console/terminal-tap';
import type { ServerMessage } from '../../src/shared/remote-console-protocol';

const S = 'surf-00000001-0000-4000-8000-000000000000';

/** A deterministic scheduler: timers fire only on `advance`. */
function harness(opts: { bound?: boolean } = {}) {
  let t = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: { clientId: string; msg: ServerMessage }[] = [];
  const requests: { s: string; reqId: string }[] = [];
  const buffered = new Map<string, number>();
  let bound = opts.bound ?? true;
  const tap = new TerminalTap({
    requestSnapshot: (s, reqId) => {
      if (!bound) return false;
      requests.push({ s, reqId });
      return true;
    },
    send: (clientId, msg) => sent.push({ clientId, msg }),
    bufferedAmount: (c) => buffered.get(c) ?? 0,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return {
    tap, sent, requests, buffered, advance, timers,
    setBound: (b: boolean) => { bound = b; },
    lastReq: () => requests.at(-1)?.reqId as string,
    msgs: (clientId = 'c1') => sent.filter((x) => x.clientId === clientId).map((x) => x.msg),
  };
}

const snap = (data = 'SNAP') => ({ data, cols: 80, rows: 24 });

describe('TerminalTap: ordered replay (#254, the four facts)', () => {
  it('reset, then exactly the bytes delivered after the request, then live', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.deliver(S, 'A');
    h.tap.deliver(S, 'B');
    expect(h.msgs()).toEqual([]);
    expect(h.tap.handleReply(h.lastReq(), snap())).toBe(true);
    expect(h.msgs()).toEqual([
      { t: 'term.reset', s: S, cols: 80, rows: 24, data: 'SNAP' },
      { t: 'term.data', s: S, data: 'AB' },
    ]);
    h.tap.deliver(S, 'C');
    h.advance(TAP_TIMINGS.flushMs);
    expect(h.msgs().at(-1)).toEqual({ t: 'term.data', s: S, data: 'C' });
  });

  it('live data coalesces for 50 ms, or flushes at 32 KiB', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), snap());
    h.sent.length = 0;
    h.tap.deliver(S, 'x');
    h.tap.deliver(S, 'y');
    h.advance(49);
    expect(h.sent).toEqual([]);
    h.advance(1);
    expect(h.msgs()).toEqual([{ t: 'term.data', s: S, data: 'xy' }]);
    h.tap.deliver(S, 'z'.repeat(TAP_TIMINGS.flushAt));
    expect(h.msgs()).toHaveLength(2);
  });

  it('a stale reqId is ignored', () => {
    const h = harness();
    h.tap.attach('c1', S);
    const first = h.lastReq();
    h.tap.noteResize(S);
    h.advance(TAP_TIMINGS.resizeDebounceMs);
    expect(h.lastReq()).not.toBe(first);
    expect(h.tap.handleReply(first, snap('OLD'))).toBe(false);
    expect(h.msgs()).toEqual([]);
    h.tap.handleReply(h.lastReq(), snap('NEW'));
    expect(h.msgs()[0]).toMatchObject({ t: 'term.reset', data: 'NEW' });
  });

  it('two clients on one surface each get their own snapshot', () => {
    const h = harness();
    h.tap.attach('c1', S);
    const r1 = h.lastReq();
    h.tap.deliver(S, 'A');
    h.tap.attach('c2', S);
    const r2 = h.lastReq();
    h.tap.deliver(S, 'B');
    h.tap.handleReply(r1, snap('S1'));
    h.tap.handleReply(r2, snap('S2'));
    expect(h.msgs('c1').map((m) => ('data' in m ? m.data : ''))).toEqual(['S1', 'AB']);
    expect(h.msgs('c2').map((m) => ('data' in m ? m.data : ''))).toEqual(['S2', 'B']);
  });

  it('attaching elsewhere detaches the previous surface', () => {
    const h = harness();
    const S2 = 'surf-00000002-0000-4000-8000-000000000000';
    h.tap.attach('c1', S);
    h.tap.attach('c1', S2);
    expect(h.tap.isWatched(S)).toBe(false);
    expect(h.tap.attachedSurface('c1')).toBe(S2);
    h.tap.detach('c1');
    expect(h.tap.isWatched(S2)).toBe(false);
  });
});

describe('TerminalTap: retries and timeouts', () => {
  it('no-terminal retries once after 250 ms, then term.error', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), { error: 'no-terminal' });
    expect(h.requests).toHaveLength(1);
    h.advance(TAP_TIMINGS.noTerminalRetryMs);
    expect(h.requests).toHaveLength(2);
    h.tap.handleReply(h.lastReq(), { error: 'no-terminal' });
    expect(h.msgs()).toEqual([{ t: 'term.error', s: S, code: 'no-terminal', message: expect.any(String) }]);
    expect(h.tap.isWatched(S)).toBe(false);
  });

  it('an unbound surface (no webContents) is the same no-terminal path', () => {
    const h = harness({ bound: false });
    h.tap.attach('c1', S);
    h.advance(TAP_TIMINGS.noTerminalRetryMs);
    expect(h.msgs()).toEqual([{ t: 'term.error', s: S, code: 'no-terminal', message: expect.any(String) }]);
  });

  it('a retry that finds the terminal succeeds', () => {
    const h = harness({ bound: false });
    h.tap.attach('c1', S);
    h.setBound(true);
    h.advance(TAP_TIMINGS.noTerminalRetryMs);
    h.tap.handleReply(h.lastReq(), snap());
    expect(h.msgs()[0]).toMatchObject({ t: 'term.reset' });
  });

  it('10 s timeout, one retry, then term.error{timeout}', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.advance(TAP_TIMINGS.snapshotTimeoutMs - 1);
    expect(h.requests).toHaveLength(1);
    h.advance(1);
    expect(h.requests).toHaveLength(2);
    h.advance(TAP_TIMINGS.snapshotTimeoutMs);
    expect(h.msgs()).toEqual([{ t: 'term.error', s: S, code: 'timeout', message: expect.any(String) }]);
    expect(h.timers.size).toBe(0);
  });

  it('a malformed reply is treated as no-terminal', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), { data: 5, cols: 0 });
    h.advance(TAP_TIMINGS.noTerminalRetryMs);
    expect(h.requests).toHaveLength(2);
  });
});

describe('TerminalTap: overflow, lag and resnapshot', () => {
  it('overflow while snapshotting aborts and resnapshots once, then gives up', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.deliver(S, 'x'.repeat(TAP_TIMINGS.maxBuffer + 1));
    expect(h.requests).toHaveLength(2);
    h.tap.deliver(S, 'x'.repeat(TAP_TIMINGS.maxBuffer + 1));
    expect(h.msgs()).toEqual([{ t: 'term.error', s: S, code: 'timeout', message: expect.any(String) }]);
  });

  it('the resnapshot after an overflow replays only what followed it', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.deliver(S, 'x'.repeat(TAP_TIMINGS.maxBuffer + 1));
    h.tap.deliver(S, 'after');
    h.tap.handleReply(h.lastReq(), snap());
    expect(h.msgs()[1]).toEqual({ t: 'term.data', s: S, data: 'after' });
  });

  it('a slow phone gets term.lag, nothing more, then a fresh snapshot once drained', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), snap());
    h.sent.length = 0;
    h.buffered.set('c1', TAP_TIMINGS.lagHigh + 1);
    h.tap.deliver(S, 'dropped');
    h.advance(TAP_TIMINGS.flushMs);
    expect(h.msgs()).toEqual([{ t: 'term.lag', s: S }]);
    h.tap.deliver(S, 'also dropped');
    h.advance(TAP_TIMINGS.flushMs);
    expect(h.msgs()).toHaveLength(1);
    const before = h.requests.length;
    h.buffered.set('c1', TAP_TIMINGS.lagLow + 1);
    h.advance(TAP_TIMINGS.drainPollMs * 3);
    expect(h.requests).toHaveLength(before);
    h.buffered.set('c1', TAP_TIMINGS.lagLow - 1);
    h.advance(TAP_TIMINGS.drainPollMs);
    expect(h.requests).toHaveLength(before + 1);
    h.tap.handleReply(h.lastReq(), snap('FRESH'));
    expect(h.msgs().at(-1)).toMatchObject({ t: 'term.reset', data: 'FRESH' });
  });

  it('resize is debounced 250 ms into one resnapshot', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), snap());
    for (let i = 0; i < 10; i++) {
      h.tap.noteResize(S);
      h.advance(50);
    }
    expect(h.requests).toHaveLength(1);
    h.advance(TAP_TIMINGS.resizeDebounceMs);
    expect(h.requests).toHaveLength(2);
  });

  it('resize of an unwatched surface costs nothing', () => {
    const h = harness();
    h.tap.noteResize(S);
    h.tap.deliver(S, 'x');
    expect(h.timers.size).toBe(0);
  });
});

describe('TerminalTap: exit', () => {
  it('flushes live data, then term.exit, then forgets the surface', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.handleReply(h.lastReq(), snap());
    h.sent.length = 0;
    h.tap.deliver(S, 'tail');
    h.tap.exit(S, 0);
    expect(h.msgs()).toEqual([{ t: 'term.data', s: S, data: 'tail' }, { t: 'term.exit', s: S, code: 0 }]);
    expect(h.tap.isWatched(S)).toBe(false);
    expect(h.timers.size).toBe(0);
  });

  it('exit during a snapshot abandons it; the late reply is stale', () => {
    const h = harness();
    h.tap.attach('c1', S);
    const req = h.lastReq();
    h.tap.deliver(S, 'buffered');
    h.tap.exit(S, 3);
    expect(h.msgs()).toEqual([{ t: 'term.exit', s: S, code: 3 }]);
    expect(h.tap.handleReply(req, snap())).toBe(false);
    expect(h.msgs()).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });

  it('dispose clears every timer', () => {
    const h = harness();
    h.tap.attach('c1', S);
    h.tap.attach('c2', S);
    h.tap.noteResize(S);
    h.tap.dispose();
    expect(h.timers.size).toBe(0);
    expect(h.tap.isWatched(S)).toBe(false);
  });
});

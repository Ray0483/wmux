import { describe, it, expect, beforeEach } from 'vitest';
import {
  backoffDelay,
  createWsClient,
  newNonce,
  wsUrlFor,
  BACKOFF_MAX_MS,
  PING_INTERVAL_MS,
  RESEND_MAX_AGE_MS,
  ActionUnconfirmedError,
  isUnconfirmed,
  type WsLike,
  type WsClientDeps,
  type ActionFrame,
} from '../../src/renderer/remote/ws-client';
import { NONCE_RE, PROTOCOL_VERSION } from '../../src/shared/remote-console-protocol';

const S1 = 'surf-11111111-2222-3333-4444-555555555555';

class FakeSocket implements WsLike {
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

/** A deterministic clock: timers fire only when advanced. */
class FakeClock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id; };
  clearTimeout = (h: unknown) => { this.timers.delete(h as number); };
  setInterval = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; };
  clearInterval = (h: unknown) => { this.timers.delete(h as number); };
  pendingDelays(): number[] { return [...this.timers.values()].filter((x) => !x.every).map((x) => x.at - this.t); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.t = timer.at;
      if (timer.every) timer.at += timer.every; else this.timers.delete(id);
      timer.fn();
    }
    this.t = end;
  }
}

const welcome = {
  t: 'welcome', v: PROTOCOL_VERSION, device: { id: 'dev-1', name: 'Phone', scope: 'operator' },
  effectiveScope: 'operator', host: 'box', version: '2.15.0', limits: { maxText: 16384 },
};

function setup(extra: Partial<WsClientDeps> = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  let visible = true;
  const deps: WsClientDeps = {
    url: 'ws://h/ws',
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    isVisible: () => visible,
    ...extra,
  };
  const client = createWsClient(deps, () => clock.t);
  const last = () => sockets[sockets.length - 1];
  return { client, clock, sockets, last, setVisible: (v: boolean) => { visible = v; } };
}

const sendFrame = (nonce: string, extra: Partial<ActionFrame> = {}): ActionFrame =>
  ({ t: 'send', s: S1, nonce, text: 'hi', submit: true, ...extra } as ActionFrame);

describe('ws-client helpers', () => {
  it('maps the page scheme to the socket scheme on the page\'s own host', () => {
    expect(wsUrlFor('https:', 'phone.tail.ts.net')).toBe('wss://phone.tail.ts.net/ws');
    expect(wsUrlFor('http:', '192.168.1.5:9790')).toBe('ws://192.168.1.5:9790/ws');
  });

  it('backs off 1 s, 2 s, 4 s … capped at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffDelay(Number.NaN)).toBe(1000);
  });

  it('mints a server-valid nonce with and without randomUUID (plain-http LAN)', () => {
    const insecure = { getRandomValues: <T extends ArrayBufferView>(a: T) => { new Uint8Array(a.buffer).fill(7); return a; } };
    expect(newNonce(insecure as unknown as Crypto)).toMatch(NONCE_RE);
    expect(newNonce()).toMatch(NONCE_RE);
  });
});

describe('ws-client state machine', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });

  it('sends hello as the very first frame, and nothing else before the welcome', () => {
    h.client.attach(S1);
    const queued = h.client.request(sendFrame('nonce-0001'));
    h.client.start();
    h.last().open();
    expect(h.last().sent).toEqual([{ t: 'hello', v: PROTOCOL_VERSION }]);
    h.last().receive(welcome);
    expect(h.last().sent.map((m) => (m as { t: string }).t)).toEqual(['hello', 'attach', 'send']);
    expect(h.client.state.status).toBe('ready');
    h.last().receive({ t: 'ack', nonce: 'nonce-0001', ok: true });
    return expect(queued).resolves.toMatchObject({ ok: true });
  });

  it('backs off exponentially on repeated failures and resets after a welcome', () => {
    h.client.start();
    h.last().drop();
    expect(h.client.state.status).toBe('waiting');
    expect(h.clock.pendingDelays()).toEqual([1000]);
    h.clock.advance(1000);
    h.last().drop();
    expect(h.clock.pendingDelays()).toEqual([2000]);
    h.clock.advance(2000);
    h.last().drop();
    expect(h.clock.pendingDelays()).toEqual([4000]);
    h.clock.advance(4000);
    h.last().open();
    h.last().receive(welcome);
    h.last().drop(1001);
    expect(h.clock.pendingDelays()).toEqual([1000]);
  });

  it('never waits longer than 30 s', () => {
    h.client.start();
    for (let i = 0; i < 10; i++) {
      h.last().drop();
      const [d] = h.clock.pendingDelays();
      expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      h.clock.advance(d);
    }
    expect(h.clock.pendingDelays()).toEqual([]);
    h.last().drop();
    expect(h.clock.pendingDelays()).toEqual([30000]);
  });

  it('resends an un-acked action after reconnect with the SAME nonce, after re-attaching', async () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    h.client.attach(S1);
    const p = h.client.request(sendFrame('nonce-keep-1'));
    const first = h.last();
    expect(first.sent.at(-1)).toMatchObject({ t: 'send', nonce: 'nonce-keep-1' });
    first.drop();
    h.clock.advance(1000);
    const second = h.last();
    expect(second).not.toBe(first);
    second.open();
    second.receive(welcome);
    expect(second.sent).toEqual([
      { t: 'hello', v: PROTOCOL_VERSION },
      { t: 'attach', s: S1 },
      { t: 'send', s: S1, nonce: 'nonce-keep-1', text: 'hi', submit: true },
    ]);
    second.receive({ t: 'ack', nonce: 'nonce-keep-1', ok: true, duplicate: true });
    await expect(p).resolves.toMatchObject({ ok: true, duplicate: true });
    expect(h.client.pendingCount).toBe(0);
  });

  it('resolves one promise per nonce and leaves the others pending', async () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    const a = h.client.request(sendFrame('nonce-aaaa'));
    const other = h.client.request({ t: 'key', s: S1, nonce: 'nonce-bbbb', key: 'esc' });
    h.last().receive({ t: 'ack', nonce: 'nonce-aaaa', ok: false, code: 'confirm', confirm: 'multiline' });
    await expect(a).resolves.toMatchObject({ code: 'confirm', confirm: 'multiline' });
    expect(h.client.pendingCount).toBe(1);
    h.last().receive({ t: 'ack', nonce: 'nonce-bbbb', ok: true });
    await expect(other).resolves.toMatchObject({ nonce: 'nonce-bbbb' });
  });

  it('a force resend under the same nonce replaces the frame and settles both promises', async () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    const first = h.client.request(sendFrame('nonce-same'));
    const second = h.client.request(sendFrame('nonce-same', { force: ['multiline'] }));
    expect(h.client.pendingCount).toBe(1);
    h.last().receive({ t: 'ack', nonce: 'nonce-same', ok: true });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('pings every 20 s only while ready and visible', () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    const pings = () => h.last().sent.filter((m) => (m as { t: string }).t === 'ping').length;
    h.clock.advance(PING_INTERVAL_MS);
    expect(pings()).toBe(1);
    h.setVisible(false);
    h.clock.advance(PING_INTERVAL_MS * 3);
    expect(pings()).toBe(1);
    h.setVisible(true);
    h.clock.advance(PING_INTERVAL_MS);
    expect(pings()).toBe(2);
  });

  it('stops for good on 4401 and on a revoked frame, rejecting pending actions', async () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    const p = h.client.request(sendFrame('nonce-lost'));
    h.last().drop(4401);
    await expect(p).rejects.toThrow(/revoked/);
    expect(h.client.state).toMatchObject({ status: 'stopped', stopReason: 'revoked' });
    expect(h.clock.pendingDelays()).toEqual([]);

    const g = setup();
    g.client.start();
    g.last().open();
    g.last().receive(welcome);
    g.last().receive({ t: 'revoked' });
    expect(g.client.state.stopReason).toBe('revoked');
  });

  it('treats 4400 as an incompatible page, not a blip', () => {
    h.client.start();
    h.last().open();
    h.last().drop(4400);
    expect(h.client.state).toMatchObject({ status: 'stopped', stopReason: 'incompatible' });
  });

  it('asks the session before retrying a socket that never got a welcome', async () => {
    let answer = true;
    const g = setup({ verifySession: () => Promise.resolve(answer) });
    g.client.start();
    g.last().drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(g.clock.pendingDelays()).toEqual([1000]);
    answer = false;
    g.clock.advance(1000);
    g.last().drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(g.client.state).toMatchObject({ status: 'stopped', stopReason: 'unauthorized' });
  });

  it('nudge() reconnects at once instead of waiting out the backoff', () => {
    h.client.start();
    h.last().drop();
    h.clock.advance(1000);
    h.last().drop();
    const before = h.sockets.length;
    h.client.nudge();
    expect(h.sockets.length).toBe(before + 1);
    expect(h.clock.pendingDelays()).toEqual([]);
  });

  it('detach clears the re-attach target', () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    h.client.attach(S1);
    h.client.detach();
    h.last().drop(1001);
    h.clock.advance(1000);
    h.last().open();
    h.last().receive(welcome);
    expect(h.last().sent).toEqual([{ t: 'hello', v: PROTOCOL_VERSION }]);
  });

  it('never resends an action older than RESEND_MAX_AGE_MS — it is rejected as unconfirmed', async () => {
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    const stale = h.client.request({ t: 'answer', s: S1, nonce: 'nonce-stale-1', choiceId: 'yes' });
    h.last().drop();
    // Offline long enough that the server's 10-min nonce LRU may have
    // forgotten it: a resend could answer whatever the agent asks NOW.
    // (The 1 s retry makes a socket that simply stays connecting meanwhile.)
    h.clock.advance(RESEND_MAX_AGE_MS + 1);
    const fresh = h.client.request(sendFrame('nonce-fresh-1'));
    h.last().open();
    h.last().receive(welcome);
    expect(h.last().sent).toEqual([
      { t: 'hello', v: PROTOCOL_VERSION },
      { t: 'send', s: S1, nonce: 'nonce-fresh-1', text: 'hi', submit: true },
    ]);
    const err = await stale.catch((e: unknown) => e);
    expect(isUnconfirmed(err)).toBe(true);
    expect(err).toBeInstanceOf(ActionUnconfirmedError);
    expect(h.client.pendingCount).toBe(1);
    h.last().receive({ t: 'ack', nonce: 'nonce-fresh-1', ok: true });
    await expect(fresh).resolves.toMatchObject({ ok: true });
  });

  it('a throwing listener starves neither the others nor the revoke', () => {
    const seen: string[] = [];
    h.client.subscribe(() => { throw new Error('bad term.reset'); });
    h.client.subscribe((m) => seen.push(m.t));
    h.client.start();
    h.last().open();
    h.last().receive(welcome);
    h.last().receive({ t: 'revoked' });
    expect(seen).toEqual(['welcome', 'revoked']);
    expect(h.client.state).toMatchObject({ status: 'stopped', stopReason: 'revoked' });
  });

  it('ignores malformed server frames', () => {
    const seen: unknown[] = [];
    h.client.subscribe((m) => seen.push(m));
    h.client.start();
    h.last().open();
    h.last().onmessage?.({ data: 'not json' });
    h.last().onmessage?.({ data: JSON.stringify([1, 2]) });
    expect(seen).toEqual([]);
  });
});

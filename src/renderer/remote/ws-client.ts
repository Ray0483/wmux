/**
 * The phone's one WebSocket to the Remote Console (#254) — a state machine with
 * its I/O injected, plus a thin browser adapter at the bottom.
 *
 * Pure-with-injection for the same reason `touch-pan.ts` is: every property
 * worth pinning here is about ORDER and TIME (hello before anything, backoff
 * doubling, the resend after a reconnect carrying the SAME nonce), and none of
 * it is observable in a screenshot. The tests drive a fake socket and a fake
 * clock through it; the browser only ever meets `createBrowserWsClient`.
 *
 * Three rules, each of which exists because the obvious implementation breaks
 * a server invariant:
 *
 *  1. `hello` is the FIRST frame on every socket. The session closes 4400 on
 *     anything else, so a frame queued while connecting must wait for the
 *     `welcome` — not merely for `open`.
 *  2. An un-acked `send`/`key`/`answer` is resent after a reconnect with the
 *     SAME nonce. The server records only EXECUTED actions in its per-device
 *     nonce LRU, so a frame that did land answers `ack{ok, duplicate}` with no
 *     second write, and one that did not lands once. A fresh nonce on resend
 *     is how a flaky train tunnel types a prompt twice into somebody's agent.
 *  3. The re-attach goes out BEFORE the resends. A composer send is aimed at
 *     the attached surface's screen; replaying it before the mirror is back
 *     would be acting on a view the user cannot see.
 *
 * Close codes decide whether to come back: 4401 (revoked) and 4400 (protocol
 * mismatch — the page is older than the desktop) are final; everything else,
 * 1001 "stopping or reconfigured" included, reconnects with backoff.
 */

import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/remote-console-protocol';

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const PING_INTERVAL_MS = 20_000;

/** `min(30 s, 1 s · 2^attempt)` — no jitter: one phone, one desktop, no herd to spread. */
export function backoffDelay(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return BACKOFF_MIN_MS;
  // Cap the exponent too, so a very long outage cannot overflow to Infinity.
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16));
}

/** The socket URL for the page's own origin; never a configured host (the cookie is host-bound). */
export function wsUrlFor(protocol: string, host: string): string {
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

/**
 * A nonce the server's `NONCE_RE` accepts. `crypto.randomUUID` exists only in a
 * SECURE context, and a LAN bind is plain http — so the fallback is not
 * theoretical, it is the LAN case. `getRandomValues` is available either way.
 */
export function newNonce(c: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* insecure context: fall through */ }
  }
  const bytes = c.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Injected I/O ──────────────────────────────────────────────────────────

/** The subset of the DOM WebSocket this client touches. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const WS_OPEN = 1;

export interface WsClientDeps {
  url: string;
  createSocket(url: string): WsLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Pings are for a page somebody is looking at; a hidden tab lets the heartbeat lapse. */
  isVisible(): boolean;
  /**
   * Asked before reconnecting after a socket that died WITHOUT a welcome. An
   * upgrade refused for a bad cookie is a bare HTTP 401, which a browser
   * reports as close 1006 — indistinguishable from a network blip — so the
   * only way to stop retrying a dead credential forever is to ask
   * `/api/session`. Resolving false stops the client as `unauthorized`.
   */
  verifySession?(): Promise<boolean>;
}

export type WsStatus = 'idle' | 'connecting' | 'handshake' | 'ready' | 'waiting' | 'stopped';
export type WsStopReason = 'revoked' | 'incompatible' | 'unauthorized' | 'closed';

export type AckMessage = Extract<ServerMessage, { t: 'ack' }>;
export type WelcomeMessage = Extract<ServerMessage, { t: 'welcome' }>;
/** The frames that carry a nonce and wait for an ack. */
export type ActionFrame = Extract<ClientMessage, { nonce: string }>;

export interface WsClientState {
  status: WsStatus;
  /** Reconnect attempts since the last welcome; drives the backoff. */
  attempt: number;
  /** When the next reconnect fires (for "retrying in 4 s"), or null. */
  retryAt: number | null;
  stopReason: WsStopReason | null;
  welcome: WelcomeMessage | null;
}

export interface WsClient {
  readonly state: WsClientState;
  start(): void;
  /** Final: closes the socket, rejects every pending action, never reconnects. */
  stop(reason?: WsStopReason): void;
  /** Reconnect now if waiting out a backoff (page became visible, network came back). */
  nudge(): void;
  attach(s: string): void;
  detach(): void;
  seen(s: string): void;
  /** Send an action and resolve with its ack — across reconnects, with the same nonce. */
  request(frame: ActionFrame): Promise<AckMessage>;
  subscribe(fn: (msg: ServerMessage) => void): () => void;
  onState(fn: (state: WsClientState) => void): () => void;
  /** Number of actions still waiting for an ack (tests, and the "unsent" hint). */
  readonly pendingCount: number;
}

interface Pending {
  frame: ActionFrame;
  resolve(ack: AckMessage): void;
  reject(err: Error): void;
}

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string') {
      return v as ServerMessage;
    }
  } catch { /* a malformed frame is ignored, not fatal */ }
  return null;
}

/** A close code that means "do not come back". */
function finalReasonFor(code: number): WsStopReason | null {
  if (code === CLOSE_CODES.REVOKED) return 'revoked';
  if (code === CLOSE_CODES.HELLO) return 'incompatible';
  return null;
}

export function createWsClient(deps: WsClientDeps, now: () => number = Date.now): WsClient {
  const state: WsClientState = { status: 'idle', attempt: 0, retryAt: null, stopReason: null, welcome: null };
  const pending = new Map<string, Pending>();
  const listeners = new Set<(msg: ServerMessage) => void>();
  const stateListeners = new Set<(s: WsClientState) => void>();
  let socket: WsLike | null = null;
  let retryTimer: unknown = null;
  let pingTimer: unknown = null;
  let attached: string | null = null;
  // Did the CURRENT socket get as far as a welcome? Decides whether a close
  // needs the session re-checked before retrying.
  let welcomed = false;

  const emitState = (): void => {
    for (const fn of stateListeners) fn(state);
  };
  const setStatus = (status: WsStatus): void => {
    state.status = status;
    emitState();
  };

  const rawSend = (msg: ClientMessage): void => {
    if (socket && socket.readyState === WS_OPEN) socket.send(JSON.stringify(msg));
  };

  const clearRetry = (): void => {
    if (retryTimer !== null) deps.clearTimeout(retryTimer);
    retryTimer = null;
    state.retryAt = null;
  };

  const stopPing = (): void => {
    if (pingTimer !== null) deps.clearInterval(pingTimer);
    pingTimer = null;
  };

  const onWelcome = (msg: WelcomeMessage): void => {
    welcomed = true;
    state.welcome = msg;
    state.attempt = 0;
    setStatus('ready');
    // Rule 3: the mirror first, then whatever the user typed that is not yet acked.
    if (attached) rawSend({ t: 'attach', s: attached });
    for (const p of pending.values()) rawSend(p.frame);
  };

  const onAck = (msg: AckMessage): void => {
    const p = pending.get(msg.nonce);
    if (!p) return;
    pending.delete(msg.nonce);
    p.resolve(msg);
  };

  const handleMessage = (ev: { data: unknown }): void => {
    const msg = parseServerMessage(ev.data);
    if (!msg) return;
    if (msg.t === 'welcome') onWelcome(msg);
    else if (msg.t === 'ack') onAck(msg);
    for (const fn of listeners) fn(msg);
    if (msg.t === 'revoked') stop('revoked');
  };

  function scheduleReconnect(): void {
    const delay = backoffDelay(state.attempt);
    state.attempt += 1;
    state.retryAt = now() + delay;
    setStatus('waiting');
    retryTimer = deps.setTimeout(() => {
      retryTimer = null;
      state.retryAt = null;
      connect();
    }, delay);
  }

  const handleClose = (ev: { code: number }): void => {
    socket = null;
    stopPing();
    if (state.status === 'stopped') return;
    const final = finalReasonFor(ev.code);
    if (final) {
      stop(final);
      return;
    }
    const neverWelcomed = !welcomed;
    if (neverWelcomed && deps.verifySession) {
      setStatus('waiting');
      deps.verifySession().then(
        (ok) => {
          if (state.status === 'stopped') return;
          if (ok) scheduleReconnect();
          else stop('unauthorized');
        },
        // The session probe itself failed (offline): that is a network problem,
        // not a verdict on the credential, so keep backing off.
        () => { if (state.status !== 'stopped') scheduleReconnect(); },
      );
      return;
    }
    scheduleReconnect();
  };

  function connect(): void {
    if (state.status === 'stopped') return;
    welcomed = false;
    state.welcome = null;
    setStatus('connecting');
    let ws: WsLike;
    try {
      ws = deps.createSocket(deps.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      // Rule 1: nothing else may precede this frame.
      setStatus('handshake');
      rawSend({ t: 'hello', v: PROTOCOL_VERSION });
      stopPing();
      pingTimer = deps.setInterval(() => {
        if (state.status === 'ready' && deps.isVisible()) rawSend({ t: 'ping' });
      }, PING_INTERVAL_MS);
    };
    ws.onmessage = handleMessage;
    ws.onclose = handleClose;
    ws.onerror = () => { /* onclose follows and decides */ };
  }

  function stop(reason: WsStopReason = 'closed'): void {
    if (state.status === 'stopped') return;
    state.stopReason = reason;
    clearRetry();
    stopPing();
    const s = socket;
    socket = null;
    state.status = 'stopped';
    if (s) {
      s.onclose = null;
      try { s.close(1000); } catch { /* already closing */ }
    }
    const err = new Error(`remote console ${reason}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    emitState();
  }

  return {
    get state() { return state; },
    get pendingCount() { return pending.size; },

    start() {
      if (state.status !== 'idle') return;
      connect();
    },

    stop,

    nudge() {
      if (state.status !== 'waiting' || retryTimer === null) return;
      clearRetry();
      connect();
    },

    attach(s) {
      attached = s;
      if (state.status === 'ready') rawSend({ t: 'attach', s });
    },

    detach() {
      if (attached === null) return;
      attached = null;
      if (state.status === 'ready') rawSend({ t: 'detach' });
    },

    seen(s) {
      if (state.status === 'ready') rawSend({ t: 'seen', s });
    },

    request(frame) {
      if (state.status === 'stopped') return Promise.reject(new Error('remote console stopped'));
      return new Promise<AckMessage>((resolve, reject) => {
        // A resend with force reuses the nonce: the newer frame replaces the
        // older one, and the older promise is settled by the same ack.
        const prior = pending.get(frame.nonce);
        pending.set(frame.nonce, {
          frame,
          resolve: (ack) => { prior?.resolve(ack); resolve(ack); },
          reject: (err) => { prior?.reject(err); reject(err); },
        });
        if (state.status === 'ready') rawSend(frame);
      });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    onState(fn) {
      stateListeners.add(fn);
      return () => { stateListeners.delete(fn); };
    },
  };
}

// ── Browser adapter ───────────────────────────────────────────────────────

/** Wires the state machine to the real page: its own origin, real timers, real visibility. */
export function createBrowserWsClient(verifySession: () => Promise<boolean>): WsClient {
  return createWsClient({
    url: wsUrlFor(location.protocol, location.host),
    createSocket: (url) => new WebSocket(url) as unknown as WsLike,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    isVisible: () => document.visibilityState === 'visible',
    verifySession,
  });
}

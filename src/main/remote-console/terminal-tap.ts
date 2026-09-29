/**
 * A phone's view of one terminal: snapshot, then stream (#254, spec §6).
 *
 * There are no sequence numbers anywhere in this. A snapshot plus a stream is
 * correct only if the stream starts EXACTLY where the snapshot ends — a byte
 * in both is drawn twice, a byte in neither is lost, and on a TUI either one
 * corrupts the screen until the next full repaint. Four facts make that hold
 * without numbering bytes, and every one of them is load-bearing:
 *
 *   1. A surface's PTY_DATA goes from ONE batcher to ONE fixed webContents
 *      (ipc-handlers.ts, both forwarders). The forwarder calls
 *      `remoteTaps.deliver(id, data)` right after `webContents.send(PTY_DATA)`
 *      with the same data, so this module sees the renderer's stream in the
 *      renderer's order.
 *   2. `attach` runs synchronously in main. It flips the tap to `snapshotting`
 *      — from this instant every delivery is BUFFERED here (and still sent to
 *      the renderer, which is unaffected) — and then sends
 *      REMOTE_RENDERER_REQUEST{kind:'snapshot'} on that same webContents.
 *   3. Electron preserves send order to one frame across channels, and the
 *      renderer's PTY_DATA listener calls `terminal.write` synchronously
 *      (useTerminal.ts). So when the request arrives, exactly the bytes sent
 *      BEFORE it are queued in xterm, and exactly the bytes sent after it are
 *      in this module's buffer.
 *   4. The renderer answers with `terminal.write(SNAPSHOT_FENCE, () =>
 *      reply(serialize()))`, serializing synchronously inside the callback —
 *      i.e. after xterm has parsed everything queued before the fence and
 *      nothing after it.
 *
 * So `term.reset(snapshot)` followed by the buffer as `term.data` is the
 * stream with no gap and no overlap. Break any one fact — a second
 * webContents, an await before the request, a serialize deferred to rAF — and
 * the phone is silently, intermittently wrong, which is why this is written
 * down here rather than left to be rediscovered.
 *
 * Pure: the renderer request, the socket, the clock and the timers are all
 * injected, so the whole state machine runs under a fake clock.
 */
import type { RemoteSnapshotResult } from '../../shared/remote-console-config';
import type { ServerMessage } from '../../shared/remote-console-protocol';

export const TAP_TIMINGS = Object.freeze({
  /** A minimized window throttles xterm's parser timer; 10 s, not 2. */
  snapshotTimeoutMs: 10_000,
  timeoutRetries: 1,
  noTerminalRetryMs: 250,
  /** Buffer while snapshotting, in UTF-16 units. Over it: abort and resnapshot, once. */
  maxBuffer: 2 * 1024 * 1024,
  flushMs: 50,
  flushAt: 32 * 1024,
  /** Socket backlog above which a phone is too slow to follow live output. */
  lagHigh: 1024 * 1024,
  /** Backlog below which a lagging phone gets a fresh snapshot. */
  lagLow: 128 * 1024,
  drainPollMs: 250,
  resizeDebounceMs: 250,
});

export interface TapDeps {
  /** Send REMOTE_RENDERER_REQUEST{kind:'snapshot'} to the surface's webContents; false when none is bound. */
  requestSnapshot(surfaceId: string, reqId: string): boolean;
  send(clientId: string, msg: ServerMessage): void;
  bufferedAmount(clientId: string): number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newReqId?(): string;
}

type Phase = 'snapshotting' | 'live' | 'stale';

interface Attachment {
  clientId: string;
  s: string;
  phase: Phase;
  reqId: string | null;
  buf: string[];
  bufLen: number;
  timeoutRetries: number;
  noTermRetried: boolean;
  overflows: number;
  snapTimer: unknown;
  pending: string[];
  pendingLen: number;
  flushTimer: unknown;
  drainTimer: unknown;
}

function isSnapshot(r: unknown): r is { data: string; cols: number; rows: number } {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.data === 'string'
    && Number.isInteger(o.cols) && (o.cols as number) > 0
    && Number.isInteger(o.rows) && (o.rows as number) > 0;
}

export class TerminalTap {
  private readonly byClient = new Map<string, Attachment>();
  private readonly bySurface = new Map<string, Set<Attachment>>();
  private readonly byReq = new Map<string, Attachment>();
  private readonly resizeTimers = new Map<string, unknown>();
  private seq = 0;

  constructor(private readonly deps: TapDeps) {}

  private mintReqId(): string {
    return this.deps.newReqId ? this.deps.newReqId() : `tap-${++this.seq}`;
  }

  /** Surfaces some phone is watching — the runtime skips the tap entirely for the rest. */
  isWatched(surfaceId: string): boolean {
    return this.bySurface.has(surfaceId);
  }

  attachedSurface(clientId: string): string | null {
    return this.byClient.get(clientId)?.s ?? null;
  }

  /** One surface per connection: attaching elsewhere detaches first. */
  attach(clientId: string, surfaceId: string): void {
    this.detach(clientId);
    const att: Attachment = {
      clientId, s: surfaceId, phase: 'snapshotting', reqId: null,
      buf: [], bufLen: 0, timeoutRetries: 0, noTermRetried: false, overflows: 0,
      snapTimer: null, pending: [], pendingLen: 0, flushTimer: null, drainTimer: null,
    };
    this.byClient.set(clientId, att);
    let set = this.bySurface.get(surfaceId);
    if (!set) {
      set = new Set();
      this.bySurface.set(surfaceId, set);
    }
    set.add(att);
    this.startSnapshot(att, true);
  }

  detach(clientId: string): void {
    const att = this.byClient.get(clientId);
    if (att) this.remove(att);
  }

  private clearTimers(att: Attachment): void {
    for (const h of [att.snapTimer, att.flushTimer, att.drainTimer]) if (h !== null) this.deps.clearTimer(h);
    att.snapTimer = null;
    att.flushTimer = null;
    att.drainTimer = null;
  }

  private retireReq(att: Attachment): void {
    if (att.reqId !== null) this.byReq.delete(att.reqId);
    att.reqId = null;
  }

  private remove(att: Attachment): void {
    this.clearTimers(att);
    this.retireReq(att);
    if (this.byClient.get(att.clientId) === att) this.byClient.delete(att.clientId);
    const set = this.bySurface.get(att.s);
    if (!set) return;
    set.delete(att);
    if (set.size === 0) {
      this.bySurface.delete(att.s);
      const t = this.resizeTimers.get(att.s);
      if (t !== undefined) this.deps.clearTimer(t);
      this.resizeTimers.delete(att.s);
    }
  }

  private isCurrent(att: Attachment): boolean {
    return this.byClient.get(att.clientId) === att;
  }

  private startSnapshot(att: Attachment, fresh: boolean): void {
    this.clearTimers(att);
    this.retireReq(att);
    att.phase = 'snapshotting';
    att.buf = [];
    att.bufLen = 0;
    att.pending = [];
    att.pendingLen = 0;
    if (fresh) {
      att.timeoutRetries = 0;
      att.noTermRetried = false;
    }
    const reqId = this.mintReqId();
    att.reqId = reqId;
    this.byReq.set(reqId, att);
    att.snapTimer = this.deps.setTimer(() => this.onTimeout(att, reqId), TAP_TIMINGS.snapshotTimeoutMs);
    let sent: boolean;
    try {
      sent = this.deps.requestSnapshot(att.s, reqId);
    } catch {
      sent = false;
    }
    if (!sent && att.reqId === reqId) this.onNoTerminal(att);
  }

  private fail(att: Attachment, code: 'no-terminal' | 'timeout', message: string): void {
    this.deps.send(att.clientId, { t: 'term.error', s: att.s, code, message });
    this.remove(att);
  }

  /** No terminal answered: retry ONCE after 250 ms (a remount), then give up. */
  private onNoTerminal(att: Attachment): void {
    if (att.snapTimer !== null) this.deps.clearTimer(att.snapTimer);
    att.snapTimer = null;
    this.retireReq(att);
    if (att.noTermRetried) {
      this.fail(att, 'no-terminal', 'This terminal is not open in any wmux window.');
      return;
    }
    att.noTermRetried = true;
    att.snapTimer = this.deps.setTimer(() => {
      att.snapTimer = null;
      if (this.isCurrent(att)) this.startSnapshot(att, false);
    }, TAP_TIMINGS.noTerminalRetryMs);
  }

  private onTimeout(att: Attachment, reqId: string): void {
    if (att.reqId !== reqId || !this.isCurrent(att)) return;
    att.snapTimer = null;
    if (att.timeoutRetries < TAP_TIMINGS.timeoutRetries) {
      att.timeoutRetries++;
      this.startSnapshot(att, false);
      return;
    }
    this.fail(att, 'timeout', 'The desktop did not answer in time.');
  }

  /**
   * A renderer reply. Anything whose reqId is not the attachment's CURRENT
   * one is stale (superseded by a retry, a resize or a detach) and ignored:
   * its snapshot was taken at a different point in the stream than the
   * buffer this module holds now. Returns whether the reqId was ours.
   */
  handleReply(reqId: string, result: RemoteSnapshotResult | unknown): boolean {
    const att = this.byReq.get(reqId);
    if (!att) return false;
    this.retireReq(att);
    if (att.snapTimer !== null) this.deps.clearTimer(att.snapTimer);
    att.snapTimer = null;
    if (!isSnapshot(result)) {
      this.onNoTerminal(att);
      return true;
    }
    this.deps.send(att.clientId, { t: 'term.reset', s: att.s, cols: result.cols, rows: result.rows, data: result.data });
    if (att.bufLen > 0) this.deps.send(att.clientId, { t: 'term.data', s: att.s, data: att.buf.join('') });
    att.buf = [];
    att.bufLen = 0;
    att.overflows = 0;
    att.phase = 'live';
    return true;
  }

  /** From the forwarder, once per PTY batch. Cheap when nobody watches the surface. */
  deliver(surfaceId: string, data: string): void {
    const set = this.bySurface.get(surfaceId);
    if (!set) return;
    for (const att of [...set]) this.deliverTo(att, data);
  }

  private deliverTo(att: Attachment, data: string): void {
    if (att.phase === 'snapshotting') {
      att.buf.push(data);
      att.bufLen += data.length;
      if (att.bufLen > TAP_TIMINGS.maxBuffer) this.onOverflow(att);
      return;
    }
    if (att.phase !== 'live') return;
    att.pending.push(data);
    att.pendingLen += data.length;
    if (att.pendingLen >= TAP_TIMINGS.flushAt) this.flush(att);
    else att.flushTimer ??= this.deps.setTimer(() => this.flush(att), TAP_TIMINGS.flushMs);
  }

  private onOverflow(att: Attachment): void {
    att.overflows++;
    if (att.overflows > 1) {
      this.fail(att, 'timeout', 'Output is too fast to snapshot.');
      return;
    }
    this.startSnapshot(att, false);
  }

  private flush(att: Attachment): void {
    if (att.flushTimer !== null) this.deps.clearTimer(att.flushTimer);
    att.flushTimer = null;
    if (att.pendingLen === 0 || att.phase !== 'live') return;
    if (this.deps.bufferedAmount(att.clientId) > TAP_TIMINGS.lagHigh) {
      // The phone cannot keep up. Queueing more only grows main's memory and
      // the phone's delay; drop, say so, and resnapshot once it has drained.
      att.pending = [];
      att.pendingLen = 0;
      att.phase = 'stale';
      this.deps.send(att.clientId, { t: 'term.lag', s: att.s });
      this.scheduleDrainPoll(att);
      return;
    }
    const data = att.pending.join('');
    att.pending = [];
    att.pendingLen = 0;
    this.deps.send(att.clientId, { t: 'term.data', s: att.s, data });
  }

  private scheduleDrainPoll(att: Attachment): void {
    att.drainTimer = this.deps.setTimer(() => {
      att.drainTimer = null;
      if (!this.isCurrent(att) || att.phase !== 'stale') return;
      if (this.deps.bufferedAmount(att.clientId) < TAP_TIMINGS.lagLow) this.startSnapshot(att, true);
      else this.scheduleDrainPoll(att);
    }, TAP_TIMINGS.drainPollMs);
  }

  /** The PTY exited: what is already live goes out, then `term.exit`. A snapshot in flight is abandoned. */
  exit(surfaceId: string, code: number): void {
    const set = this.bySurface.get(surfaceId);
    if (!set) return;
    for (const att of [...set]) {
      if (att.phase === 'live') this.flush(att);
      this.deps.send(att.clientId, { t: 'term.exit', s: att.s, code });
      this.remove(att);
    }
  }

  /**
   * The desktop resized the PTY. The phone never resizes (I4) — it mirrors
   * the desktop's grid, so a resize means a new snapshot at the new size.
   * Debounced: a window drag emits dozens.
   */
  noteResize(surfaceId: string): void {
    if (!this.bySurface.has(surfaceId)) return;
    const prev = this.resizeTimers.get(surfaceId);
    if (prev !== undefined) this.deps.clearTimer(prev);
    this.resizeTimers.set(surfaceId, this.deps.setTimer(() => {
      this.resizeTimers.delete(surfaceId);
      const set = this.bySurface.get(surfaceId);
      if (set) for (const att of [...set]) this.startSnapshot(att, true);
    }, TAP_TIMINGS.resizeDebounceMs));
  }

  dispose(): void {
    for (const att of [...this.byClient.values()]) this.remove(att);
    for (const t of this.resizeTimers.values()) this.deps.clearTimer(t);
    this.resizeTimers.clear();
  }
}

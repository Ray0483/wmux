/**
 * One phone connection's message dispatcher (#254, spec §5 rules 1-8).
 *
 * Deny-by-default: a frame is validated against the closed protocol table
 * before anything here looks at it, and every effect goes through the injected
 * ops — the same `ConsoleOps` subset main built, never ptyManager or the pipe
 * (I1). A viewer can reach none of `write`, `noteHumanInput` or
 * `deliverAnswer`: the scope check sits in front of the only three handlers
 * that call them.
 *
 * The ordering rule that matters most, and that a refactor would most easily
 * break: `wasBlocked` is read as the FIRST statement of `send` and `key`,
 * before any await and before any `noteHumanInput`. `noteHumanInput` is what
 * tells agent-state a human typed — and typing into a blocked pane is how a
 * human answers, so it can CLEAR blocked. Read afterwards, the check would ask
 * "is the pane blocked now that I have told it someone answered?" and always
 * say no: the confirm would never fire, and a phone would type into a
 * permission prompt unasked. The session test pins this with a fake
 * `noteHumanInput` that clears blocked.
 *
 * Nothing typed is ever logged: `remote-input` records byte counts (I7).
 */
import type {
  AckCode,
  ClientMessage,
  ConfirmKind,
  RemoteScope,
  ServerMessage,
} from '../../shared/remote-console-protocol';
import {
  CLOSE_CODES,
  MAX_TEXT,
  PROTOCOL_VERSION,
  SCOPE_OF,
  validateClientMessage,
} from '../../shared/remote-console-protocol';
import { buildComposerWrites, sanitizeComposerText } from '../../shared/remote-input';
import { REMOTE_KEY_BYTES } from '../pty-keys';
import type { ConsoleOps, DeliverAnswerReason } from './contract';
import { LIMITS, TokenBucket, WindowCounter } from './rate-limit';

export const NONCE_LRU_SIZE = 256;
export const NONCE_TTL_MS = 10 * 60_000;
/** Before the trailing Enter, so an agent TUI does not read paste+Enter as one paste. */
export const SUBMIT_GAP_MS = 40;

type AckMsg = Extract<ServerMessage, { t: 'ack' }>;

/** Executed nonces for one device, shared by its connections (a resend may arrive on a new socket). */
export class NonceLru {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number, private readonly size = NONCE_LRU_SIZE, private readonly ttlMs = NONCE_TTL_MS) {}

  has(nonce: string): boolean {
    const at = this.seen.get(nonce);
    if (at === undefined) return false;
    if (this.now() - at > this.ttlMs) {
      this.seen.delete(nonce);
      return false;
    }
    return true;
  }

  record(nonce: string): void {
    this.seen.delete(nonce);
    this.seen.set(nonce, this.now());
    while (this.seen.size > this.size) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
  }
}

/** Per-device state that outlives any one socket. */
export interface DeviceSessionState {
  nonces: NonceLru;
  /** Acks still being computed, so a resend of an in-flight nonce waits for the original's answer. */
  inFlight: Map<string, Promise<AckMsg>>;
  send: TokenBucket;
  sendBytes: TokenBucket;
  key: TokenBucket;
  answer: TokenBucket;
}

export function createDeviceSessionState(now: () => number): DeviceSessionState {
  return {
    nonces: new NonceLru(now),
    inFlight: new Map(),
    send: new TokenBucket(LIMITS.send.rate, LIMITS.send.burst, now),
    sendBytes: new TokenBucket(LIMITS.sendBytes.rate, LIMITS.sendBytes.burst, now),
    key: new TokenBucket(LIMITS.key.rate, LIMITS.key.burst, now),
    answer: new TokenBucket(LIMITS.answer.rate, LIMITS.answer.burst, now),
  };
}

export type SessionOps = Pick<ConsoleOps,
  'isLivePty' | 'isBlocked' | 'runDepth' | 'isAnsweringInput' | 'noteHumanInput' | 'write' | 'deliverAnswer' | 'log'>;

export interface SessionDeps {
  ops: SessionOps;
  device: { id: string; name: string; scope: RemoteScope };
  effectiveScope: RemoteScope;
  deviceState: DeviceSessionState;
  host: string;
  version: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  /** The DESKTOP terminal's modes. The runtime applies a 2 s timeout that answers `bracketedPaste:false`. */
  queryModes(surfaceId: string): Promise<{ bracketedPaste: boolean } | { error: 'no-terminal' }>;
  onHello(): void;
  onAttach(surfaceId: string): void;
  onDetach(): void;
  onSeen(surfaceId: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const ANSWER_CODES: Readonly<Record<DeliverAnswerReason, AckCode>> = {
  'not-blocked': 'not-blocked',
  'no-choices': 'no-choices',
  'unknown-choice': 'unknown-choice',
  'unknown-surface': 'gone',
  'write-failed': 'write-failed',
};

const ok = (nonce: string): AckMsg => ({ t: 'ack', nonce, ok: true });
const refuse = (nonce: string, code: AckCode): AckMsg => ({ t: 'ack', nonce, ok: false, code });
const confirm = (nonce: string, kind: ConfirmKind): AckMsg => ({ t: 'ack', nonce, ok: false, code: 'confirm', confirm: kind });

type OperatorMsg = Extract<ClientMessage, { t: 'send' | 'key' | 'answer' }>;

export class ConsoleSession {
  private helloed = false;
  private closed = false;
  private readonly frames: TokenBucket;
  private readonly rateTrips: WindowCounter;
  private readonly forbiddenTrips: WindowCounter;

  constructor(private readonly d: SessionDeps) {
    this.frames = new TokenBucket(LIMITS.frame.rate, LIMITS.frame.burst, d.now);
    this.rateTrips = new WindowCounter(LIMITS.trips.limit - 1, LIMITS.trips.windowMs, d.now);
    this.forbiddenTrips = new WindowCounter(LIMITS.trips.limit - 1, LIMITS.trips.windowMs, d.now);
  }

  get isHelloed(): boolean {
    return this.helloed;
  }

  private shut(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.d.close(code, reason);
  }

  /** Three trips in 60 s close the socket with 4429. */
  private trip(counter: WindowCounter): void {
    if (!counter.hit()) this.shut(CLOSE_CODES.RATE, 'rate');
  }

  dispose(): void {
    this.closed = true;
    this.d.onDetach();
  }

  /**
   * One text frame. Returns once the message is fully handled, so tests (and
   * nothing else) can await it; the server does not.
   */
  handleFrame(raw: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.frames.take()) {
      this.d.send({ t: 'error', code: 'rate', message: 'Too many messages.' });
      this.trip(this.rateTrips);
      return Promise.resolve();
    }
    const v = validateClientMessage(raw);
    if (!this.helloed) {
      this.handleHello(v.ok ? v.msg : null);
      return Promise.resolve();
    }
    if (!v.ok) {
      this.d.send({ t: 'error', code: 'bad-frame', message: 'Malformed message.' });
      return Promise.resolve();
    }
    return this.dispatch(v.msg);
  }

  private handleHello(msg: ClientMessage | null): void {
    if (msg?.t !== 'hello' || msg.v !== PROTOCOL_VERSION) {
      this.shut(CLOSE_CODES.HELLO, 'hello-required');
      return;
    }
    this.helloed = true;
    this.d.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      device: { id: this.d.device.id, name: this.d.device.name, scope: this.d.device.scope },
      effectiveScope: this.d.effectiveScope,
      host: this.d.host,
      version: this.d.version,
      limits: { maxText: MAX_TEXT },
    });
    this.d.onHello();
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
    if (SCOPE_OF[msg.t] === 'operator' && this.d.effectiveScope !== 'operator') {
      this.d.send(refuse((msg as OperatorMsg).nonce, 'forbidden'));
      this.trip(this.forbiddenTrips);
      return;
    }
    switch (msg.t) {
      case 'hello':
        this.d.send({ t: 'error', code: 'bad-frame', message: 'Already greeted.' });
        return;
      case 'ping':
        this.d.send({ t: 'pong' });
        return;
      case 'attach':
        this.handleAttach(msg.s);
        return;
      case 'detach':
        this.d.onDetach();
        return;
      case 'seen':
        this.d.onSeen(msg.s);
        return;
      case 'send':
        await this.handleSend(msg);
        return;
      case 'key':
        await this.handleKey(msg);
        return;
      case 'answer':
        await this.handleAnswer(msg);
    }
  }

  private handleAttach(s: string): void {
    if (!this.d.ops.isLivePty(s)) {
      this.d.send({ t: 'term.error', s, code: 'no-terminal', message: 'No such terminal.' });
      return;
    }
    this.d.onAttach(s);
  }

  /**
   * The nonce protocol around one operator action. A nonce already EXECUTED
   * answers `duplicate` with no effect; one still in flight answers with the
   * original's ack when it lands (a resend after a reconnect). Only executed
   * actions are recorded, so a refusal — `confirm` above all — can be resent
   * with the same nonce and `force`.
   */
  private async guarded(nonce: string, bucket: TokenBucket, run: () => Promise<AckMsg>): Promise<void> {
    const st = this.d.deviceState;
    if (st.nonces.has(nonce)) {
      this.d.send({ t: 'ack', nonce, ok: true, duplicate: true });
      return;
    }
    const inflight = st.inFlight.get(nonce);
    if (inflight) {
      const first = await inflight;
      this.d.send(first.ok ? { t: 'ack', nonce, ok: true, duplicate: true } : first);
      return;
    }
    if (!bucket.take()) {
      this.d.send(refuse(nonce, 'rate'));
      this.trip(this.rateTrips);
      return;
    }
    const p = run().catch((): AckMsg => refuse(nonce, 'write-failed'));
    st.inFlight.set(nonce, p);
    try {
      const ack = await p;
      if (ack.ok) st.nonces.record(nonce);
      this.d.send(ack);
    } finally {
      st.inFlight.delete(nonce);
    }
  }

  private writeHuman(s: string, bytes: string): void {
    this.d.ops.noteHumanInput(s, bytes);
    this.d.ops.write(s, bytes);
  }

  private async handleSend(m: Extract<ClientMessage, { t: 'send' }>): Promise<void> {
    const wasBlocked = this.d.ops.isBlocked(m.s);
    await this.guarded(m.nonce, this.d.deviceState.send, () => this.runSend(m, wasBlocked));
  }

  private async runSend(m: Extract<ClientMessage, { t: 'send' }>, wasBlocked: boolean): Promise<AckMsg> {
    if (m.text.length > MAX_TEXT) return refuse(m.nonce, 'too-long');
    if (!this.d.deviceState.sendBytes.take(Buffer.byteLength(m.text, 'utf8'))) return refuse(m.nonce, 'rate');
    const clean = sanitizeComposerText(m.text);
    if (clean === '' && !m.submit) return ok(m.nonce);
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');
    if (wasBlocked && !m.force) return confirm(m.nonce, 'blocked');

    const modes = await this.d.queryModes(m.s);
    const bracketed = 'bracketedPaste' in modes && modes.bracketedPaste === true;
    if (clean.includes('\n') && !bracketed && !m.force) return confirm(m.nonce, 'multiline');
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');

    const writes = buildComposerWrites(clean, { bracketed, submit: m.submit });
    const failed = await this.writeComposer(m.s, writes, m.submit);
    if (failed) return refuse(m.nonce, failed);
    const bytes = writes.reduce((n, w) => n + Buffer.byteLength(w, 'utf8'), 0);
    this.d.ops.log('remote-input', { device: this.d.device.id, surface: m.s, bytes, submit: m.submit });
    return ok(m.nonce);
  }

  /** Each write preceded by its `noteHumanInput`; a 40 ms gap before a trailing submit. */
  private async writeComposer(s: string, writes: string[], submit: boolean): Promise<AckCode | null> {
    for (let i = 0; i < writes.length; i++) {
      const trailingSubmit = submit && i > 0 && i === writes.length - 1;
      if (trailingSubmit) {
        await this.d.sleep(SUBMIT_GAP_MS);
        if (!this.d.ops.isLivePty(s)) return 'gone';
      }
      try {
        this.writeHuman(s, writes[i]);
      } catch {
        return 'write-failed';
      }
    }
    return null;
  }

  private async handleKey(m: Extract<ClientMessage, { t: 'key' }>): Promise<void> {
    const wasBlocked = this.d.ops.isBlocked(m.s);
    await this.guarded(m.nonce, this.d.deviceState.key, async () => this.runKey(m, wasBlocked));
  }

  private runKey(m: Extract<ClientMessage, { t: 'key' }>, wasBlocked: boolean): AckMsg {
    const bytes = (REMOTE_KEY_BYTES as Readonly<Record<string, string>>)[m.key];
    if (bytes === undefined) return refuse(m.nonce, 'bad-key');
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');
    // Arrow keys are not answering input, so a menu can still be navigated
    // from the phone without a confirm; Enter, y and n are.
    if (wasBlocked && !m.force && this.d.ops.isAnsweringInput(bytes)) return confirm(m.nonce, 'blocked');
    // A bare ESC or ^C ends an agent's run (and clears blocked) — one stray
    // tap on a phone must not cancel twenty minutes of work.
    if ((m.key === 'esc' || m.key === 'ctrl-c') && !m.force && this.d.ops.runDepth(m.s) > 0) return confirm(m.nonce, 'interrupt');
    try {
      this.writeHuman(m.s, bytes);
    } catch {
      return refuse(m.nonce, 'write-failed');
    }
    this.d.ops.log('remote-key', { device: this.d.device.id, surface: m.s, bytes: bytes.length });
    return ok(m.nonce);
  }

  /** Answers go through the back-channel only; never `noteHumanInput` (the agent must confirm, #128). */
  private async handleAnswer(m: Extract<ClientMessage, { t: 'answer' }>): Promise<void> {
    await this.guarded(m.nonce, this.d.deviceState.answer, async () => {
      const r = await this.d.ops.deliverAnswer(m.s, m.choiceId);
      if (!r.ok) return refuse(m.nonce, ANSWER_CODES[r.reason] ?? 'write-failed');
      this.d.ops.log('remote-answer', { device: this.d.device.id, surface: m.s });
      return ok(m.nonce);
    });
  }
}

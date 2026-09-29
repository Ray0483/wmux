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
 * break: `wasBlocked` is read as the FIRST statement of a `send` or `key` once
 * it starts running, before any await of its own and before any
 * `noteHumanInput`. `noteHumanInput` is what
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
  /**
   * The tail of this device's operator actions. A `send` awaits the desktop's
   * modes (up to 2 s) and a 40 ms gap before its Enter; a `key` does not. Run
   * side by side, an Enter tapped right after an Insert reached the PTY BEFORE
   * the inserted text, a key tapped inside the gap landed between a Send's text
   * and its Enter, and the frames ws-client replays in order after a reconnect
   * executed in any order. Each action starts once the previous one has written
   * or refused — per device, because both of a device's sockets type into the
   * same panes.
   */
  queue: Promise<void>;
  send: TokenBucket;
  sendBytes: TokenBucket;
  key: TokenBucket;
  answer: TokenBucket;
  /**
   * `attach`, which makes the DESKTOP renderer serialize a whole terminal
   * buffer. Viewer scope, so it is the one expensive thing a least-privileged
   * device can ask for; the frame bucket alone let it ask 50 times a second.
   */
  attach: TokenBucket;
}

export function createDeviceSessionState(now: () => number): DeviceSessionState {
  return {
    nonces: new NonceLru(now),
    inFlight: new Map(),
    queue: Promise.resolve(),
    send: new TokenBucket(LIMITS.send.rate, LIMITS.send.burst, now),
    sendBytes: new TokenBucket(LIMITS.sendBytes.rate, LIMITS.sendBytes.burst, now),
    key: new TokenBucket(LIMITS.key.rate, LIMITS.key.burst, now),
    answer: new TokenBucket(LIMITS.answer.rate, LIMITS.answer.burst, now),
    attach: new TokenBucket(LIMITS.attach.rate, LIMITS.attach.burst, now),
  };
}

/**
 * Keys that answer a declared-blocked prompt, whatever their bytes look like.
 * `isAnsweringInput` was written for desktop keystroke attribution and skips
 * every CSI sequence as navigation — so it reads Shift+Tab (`ESC [ Z`) as a
 * scroll, while Claude Code's edit-permission prompt reads it as "Yes, allow
 * all edits during this session". The byte check still runs beside this list.
 *
 * ^C and ^D are here too: both are C0 bytes `isAnsweringInput` never counts,
 * and both end a prompt — ^C cancels a permission question, ^D counts toward
 * an agent's exit. The interrupt confirm covers ^C only while a run is open,
 * and an agent that declares `blocked` without `--run-start` has none.
 */
export const REMOTE_ANSWERING_KEYS: ReadonlySet<string> = new Set(['enter', 'y', 'n', 'esc', 'tab', 'shift-tab', 'backspace', 'ctrl-c', 'ctrl-d']);

export type SessionOps = Pick<ConsoleOps,
  'isLivePty' | 'isBlocked' | 'promptId' | 'runDepth' | 'isAnsweringInput' | 'noteHumanInput' | 'write' | 'deliverAnswer' | 'log'>;

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
  'stale': 'stale',
};

const ok = (nonce: string): AckMsg => ({ t: 'ack', nonce, ok: true });
const refuse = (nonce: string, code: AckCode): AckMsg => ({ t: 'ack', nonce, ok: false, code });
const confirm = (nonce: string, kind: ConfirmKind): AckMsg => ({ t: 'ack', nonce, ok: false, code: 'confirm', confirm: kind });

/** Did the user accept THIS confirm? A waiver answers one question, never all of them. */
const waives = (m: { force?: ConfirmKind[] }, kind: ConfirmKind): boolean => m.force?.includes(kind) === true;

/**
 * The `blocked` waiver, which is about ONE prompt: it holds only while the
 * pane is still asking the question the phone named. A resend that reaches a
 * pane now asking something else (same ids, new question) is asked again.
 */
const waivesBlocked = (m: { force?: ConfirmKind[]; prompt?: number }, livePrompt: number | null): boolean =>
  waives(m, 'blocked') && m.prompt !== undefined && m.prompt === livePrompt;

/**
 * Several lines into a terminal not in paste mode. Every line break then goes
 * out as CR — an Enter — so an Insert, which promised none, is refused outright
 * (no waiver can make it keep that promise), and a Send asks first.
 */
function multilineRefusal(m: Extract<ClientMessage, { t: 'send' }>, clean: string, bracketed: boolean): AckMsg | null {
  if (bracketed || !clean.includes('\n')) return null;
  if (!m.submit) return refuse(m.nonce, 'multiline-insert');
  return waives(m, 'multiline') ? null : confirm(m.nonce, 'multiline');
}

type OperatorMsg = Extract<ClientMessage, { t: 'send' | 'key' | 'answer' }>;

export class ConsoleSession {
  private helloed = false;
  private closed = false;
  private disposed = false;
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

  /**
   * The socket is gone, or its device was revoked. Also what stops an action
   * already past its first await before it writes: a revoke disposes the
   * session at once rather than waiting for the peer to answer the close
   * frame, which a hostile peer never does. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    if (!this.d.deviceState.attach.take()) {
      // Scoped to the surface: the view waiting on this attach only listens
      // for `term.*` frames that name it, and a bare `error` left it on
      // "Loading screen…" with nothing ever sending the attach again.
      this.d.send({ t: 'term.error', s, code: 'rate', message: 'Too many messages.' });
      this.trip(this.rateTrips);
      return;
    }
    if (!this.d.ops.isLivePty(s)) {
      this.d.send({ t: 'term.error', s, code: 'no-terminal', message: 'No such terminal.' });
      return;
    }
    this.d.onAttach(s);
  }

  /**
   * The nonce protocol around one operator action. A nonce already EXECUTED
   * answers `duplicate` with no effect; one still queued or in flight answers
   * with the original's ack when it lands (a resend after a reconnect). Only
   * executed actions are recorded, so a refusal — `confirm` above all — can be
   * resent with the same nonce and `force`.
   *
   * `run` starts only after the device's previous action settled (see
   * `DeviceSessionState.queue`), and a session closed while it waited runs
   * nothing: a revoked phone's queued key must not type after the revoke.
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
    const p = st.queue
      .then(() => (this.closed ? refuse(nonce, 'gone') : run()))
      .catch((): AckMsg => refuse(nonce, 'write-failed'));
    st.queue = p.then(() => undefined);
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

  /** A `blocked` confirm, naming the prompt it is about so the waiver can name it back. */
  private confirmBlocked(nonce: string, s: string): AckMsg {
    const prompt = this.d.ops.promptId(s);
    return prompt === null ? confirm(nonce, 'blocked') : { ...confirm(nonce, 'blocked'), prompt };
  }

  /** Blocked now, and not on the prompt this message waived. Read BEFORE any noteHumanInput. */
  private blockedUnwaived(m: { s: string; force?: ConfirmKind[]; prompt?: number }): boolean {
    return this.d.ops.isBlocked(m.s) && !waivesBlocked(m, this.d.ops.promptId(m.s));
  }

  private async handleSend(m: Extract<ClientMessage, { t: 'send' }>): Promise<void> {
    await this.guarded(m.nonce, this.d.deviceState.send, () => {
      const wasBlocked = this.d.ops.isBlocked(m.s);
      const prompt = this.d.ops.promptId(m.s);
      return this.runSend(m, wasBlocked, prompt);
    });
  }

  private async runSend(m: Extract<ClientMessage, { t: 'send' }>, wasBlocked: boolean, prompt: number | null): Promise<AckMsg> {
    if (m.text.length > MAX_TEXT) return refuse(m.nonce, 'too-long');
    const clean = sanitizeComposerText(m.text);
    if (clean === '' && !m.submit) return ok(m.nonce);
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');
    if (wasBlocked && !waivesBlocked(m, prompt)) return this.confirmBlocked(m.nonce, m.s);

    const modes = await this.d.queryModes(m.s);
    // That await is up to 2 s, and two things can change across it. The
    // session may have been closed — a revoke, a stop — and a revoked phone
    // must not type anything after the revoke returned. And the agent may have
    // gone blocked: text plus a trailing Enter would then answer a permission
    // prompt the phone never saw. Both are read BEFORE any noteHumanInput, so
    // this re-check still asks the question `wasBlocked` asks (I4).
    if (this.closed) return refuse(m.nonce, 'gone');
    if (this.blockedUnwaived(m)) return this.confirmBlocked(m.nonce, m.s);
    const bracketed = 'bracketedPaste' in modes && modes.bracketedPaste === true;
    const refusal = multilineRefusal(m, clean, bracketed);
    if (refusal) return refusal;
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');
    // Charged only now, once nothing is left to refuse or confirm: a confirm is
    // answered by resending the SAME text with `force`, and charging both
    // halves turned one accepted 36 KB paste into `rate`.
    if (!this.d.deviceState.sendBytes.take(Buffer.byteLength(m.text, 'utf8'))) return refuse(m.nonce, 'rate');
    return this.deliverComposer(m, clean, bracketed);
  }

  private async deliverComposer(m: Extract<ClientMessage, { t: 'send' }>, clean: string, bracketed: boolean): Promise<AckMsg> {
    const writes = buildComposerWrites(clean, { bracketed, submit: m.submit });
    const outcome = await this.writeComposer(m.s, writes, m.submit, () => this.blockedUnwaived(m));
    if (outcome !== null && outcome !== 'submit-skipped') return refuse(m.nonce, outcome);
    const skipped = outcome === 'submit-skipped';
    const sent = skipped ? writes.slice(0, -1) : writes;
    const bytes = sent.reduce((n, w) => n + Buffer.byteLength(w, 'utf8'), 0);
    this.d.ops.log('remote-input', { device: this.d.device.id, surface: m.s, bytes, submit: m.submit && !skipped });
    return skipped ? { ...ok(m.nonce), submitSkipped: true } : ok(m.nonce);
  }

  /**
   * Each write preceded by its `noteHumanInput`; a 40 ms gap before a trailing
   * submit. That gap is an await like `queryModes`, and the agent can go
   * blocked across it: the text is already typed by then, so the Enter alone
   * is withheld (`submit-skipped`) — confirming would invite a resend that
   * types the text a second time.
   */
  private async writeComposer(
    s: string, writes: string[], submit: boolean, blockedUnwaived: () => boolean,
  ): Promise<AckCode | 'submit-skipped' | null> {
    for (let i = 0; i < writes.length; i++) {
      const trailingSubmit = submit && i > 0 && i === writes.length - 1;
      if (trailingSubmit) {
        await this.d.sleep(SUBMIT_GAP_MS);
        if (this.closed || !this.d.ops.isLivePty(s)) return 'gone';
        if (blockedUnwaived()) return 'submit-skipped';
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
    await this.guarded(m.nonce, this.d.deviceState.key, async () => {
      const wasBlocked = this.d.ops.isBlocked(m.s);
      const prompt = this.d.ops.promptId(m.s);
      return this.runKey(m, wasBlocked, prompt);
    });
  }

  private runKey(m: Extract<ClientMessage, { t: 'key' }>, wasBlocked: boolean, prompt: number | null): AckMsg {
    const bytes = (REMOTE_KEY_BYTES as Readonly<Record<string, string>>)[m.key];
    if (bytes === undefined) return refuse(m.nonce, 'bad-key');
    if (!this.d.ops.isLivePty(m.s)) return refuse(m.nonce, 'gone');
    // Arrow keys are not answering input, so a menu can still be navigated
    // from the phone without a confirm; Enter, y, n, Esc, Tab, Shift+Tab, ^C, ^D and
    // Backspace are.
    const answering = REMOTE_ANSWERING_KEYS.has(m.key) || this.d.ops.isAnsweringInput(bytes);
    if (wasBlocked && !waivesBlocked(m, prompt) && answering) return this.confirmBlocked(m.nonce, m.s);
    // A bare ESC or ^C ends an agent's run (and clears blocked) — one stray
    // tap on a phone must not cancel twenty minutes of work.
    if ((m.key === 'esc' || m.key === 'ctrl-c') && !waives(m, 'interrupt') && this.d.ops.runDepth(m.s) > 0) return confirm(m.nonce, 'interrupt');
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
      const r = await this.d.ops.deliverAnswer(m.s, m.choiceId, m.prompt);
      if (!r.ok) return refuse(m.nonce, ANSWER_CODES[r.reason] ?? 'write-failed');
      this.d.ops.log('remote-answer', { device: this.d.device.id, surface: m.s });
      return ok(m.nonce);
    });
  }
}

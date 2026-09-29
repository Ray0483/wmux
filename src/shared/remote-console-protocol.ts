/**
 * The Remote Console wire protocol, v1 (#254).
 *
 * Shared by main (the dispatcher in remote-console/session.ts) and the phone
 * UI (src/renderer/remote), so the two cannot disagree about what a frame
 * means. Compiled by BOTH tsconfigs: no node imports, no instance.ts.
 *
 * The client table is deny-by-default and deliberately small. Every message a
 * phone may send is listed in `SCOPE_OF`; anything else fails
 * `validateClientMessage` as `bad-frame` before the dispatcher sees it. That is
 * the I1 invariant in code: the console is a separate dispatcher and never a
 * path into the pipe's V2 switch, so a new capability has to be added HERE,
 * visibly, rather than inherited from something the pipe grew.
 */

export const PROTOCOL_VERSION = 1;

/** Same shape `crypto.randomUUID()` mints for surface ids. Lower-case only. */
export const SURFACE_ID_RE = /^surf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NONCE_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A declared choice id that may travel to the phone and back. */
export const CHOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Composer text cap. Enforced by the session as an ack (`too-long`), NOT by the validator. */
export const MAX_TEXT = 16384;
/** Mirrors the server's ws `maxPayload`; a string frame over it is `bad-frame`. */
export const MAX_FRAME = 64 * 1024;

export const REMOTE_KEYS = [
  'esc', 'tab', 'shift-tab', 'enter',
  'up', 'down', 'left', 'right',
  'pageup', 'pagedown', 'home', 'end', 'backspace',
  'ctrl-c', 'ctrl-d', 'ctrl-l', 'ctrl-r',
  'y', 'n',
] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

export type RemoteScope = 'viewer' | 'operator';

// ── Client → server ──────────────────────────────────────────────────────

export type ClientMessage =
  | { t: 'hello'; v: number }
  | { t: 'attach'; s: string }
  | { t: 'detach' }
  | { t: 'seen'; s: string }
  | { t: 'ping' }
  | { t: 'send'; s: string; nonce: string; text: string; submit: boolean; force?: boolean }
  | { t: 'key'; s: string; nonce: string; key: RemoteKey; force?: boolean }
  | { t: 'answer'; s: string; nonce: string; choiceId: string };

export type ClientMessageType = ClientMessage['t'];

/**
 * Which scope each message needs. A `Record` over the union, so adding a
 * message type without deciding its scope is a compile error rather than a
 * message that silently defaults to whatever the dispatcher does first.
 */
export const SCOPE_OF: Readonly<Record<ClientMessageType, RemoteScope>> = {
  hello: 'viewer',
  attach: 'viewer',
  detach: 'viewer',
  seen: 'viewer',
  ping: 'viewer',
  send: 'operator',
  key: 'operator',
  answer: 'operator',
};

// ── Server → client ──────────────────────────────────────────────────────

export type ConfirmKind = 'blocked' | 'interrupt' | 'multiline';

export type AckCode =
  | 'forbidden' | 'rate' | 'gone' | 'confirm'
  | 'not-blocked' | 'no-choices' | 'unknown-choice'
  | 'too-long' | 'bad-key' | 'write-failed';

export type RemoteAgentState = 'blocked' | 'working' | 'idle' | 'unknown';

/**
 * One agent card as it travels. Built by main's `toWire` from a validated
 * `RemoteRosterSource`: no command line, no cwd, no session id, and choices
 * without their `key`/`text` payload (I7) — the phone answers by `id` and main
 * looks the payload up itself. No `runDepth` either: interrupt confirms are the
 * server's call, made against live state rather than a roster that may be 2 s old.
 */
export interface RemoteRosterEntry {
  s: string;
  workspaceId: string;
  workspaceTitle: string;
  label: string;
  kind: string | null;
  state: RemoteAgentState;
  stateSource: 'declared' | 'detected' | null;
  done: boolean;
  blockedReason: string | null;
  choices: { id: string; label: string; isDefault?: boolean }[];
  answerPending: boolean;
  dwellMs: number;
}

export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      device: { id: string; name: string; scope: RemoteScope };
      effectiveScope: RemoteScope;
      host: string;
      version: string;
      limits: { maxText: number };
    }
  | { t: 'agents'; list: RemoteRosterEntry[]; at: number }
  | { t: 'notify'; kind: 'blocked' | 'done'; s: string; label: string; at: number }
  | { t: 'term.reset'; s: string; cols: number; rows: number; data: string }
  | { t: 'term.data'; s: string; data: string }
  | { t: 'term.lag'; s: string }
  | { t: 'term.exit'; s: string; code: number }
  | { t: 'term.error'; s: string; code: 'no-terminal' | 'timeout' | 'gone'; message: string }
  | { t: 'ack'; nonce: string; ok: boolean; code?: AckCode; confirm?: ConfirmKind; duplicate?: boolean }
  | { t: 'error'; code: 'bad-frame' | 'hello-required' | 'forbidden' | 'rate'; message: string }
  | { t: 'revoked' }
  | { t: 'pong' };

export const CLOSE_CODES = {
  /** First frame was not `hello`, or its version is not ours. */
  HELLO: 4400,
  /** Device revoked, or the cookie no longer verifies. */
  REVOKED: 4401,
  HEARTBEAT: 4408,
  RATE: 4429,
  /** Server stopping or reconfigured; the client should reconnect. */
  STOPPING: 1001,
} as const;

// ── Validation ───────────────────────────────────────────────────────────

export type ValidateResult = { ok: true; msg: ClientMessage } | { ok: false; code: 'bad-frame' };

const BAD: ValidateResult = { ok: false, code: 'bad-frame' };
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);

/** Fields each message may carry, `t` included. Anything else is a bad frame. */
const ALLOWED_FIELDS: Readonly<Record<ClientMessageType, readonly string[]>> = {
  hello: ['t', 'v'],
  attach: ['t', 's'],
  detach: ['t'],
  seen: ['t', 's'],
  ping: ['t'],
  send: ['t', 's', 'nonce', 'text', 'submit', 'force'],
  key: ['t', 's', 'nonce', 'key', 'force'],
  answer: ['t', 's', 'nonce', 'choiceId'],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isSurface = (v: unknown): v is string => typeof v === 'string' && SURFACE_ID_RE.test(v);
const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE_RE.test(v);
const isOptionalBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';

function hasOnlyAllowedFields(o: Record<string, unknown>, t: ClientMessageType): boolean {
  const allowed = ALLOWED_FIELDS[t];
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** Per-type field checks, run after the frame is known to be an object with a known `t`. */
function fieldsValid(o: Record<string, unknown>, t: ClientMessageType): boolean {
  switch (t) {
    case 'hello':
      // Any integer version is structurally fine: the SESSION compares it with
      // PROTOCOL_VERSION and closes 4400, which a client can tell apart from a
      // malformed frame.
      return Number.isInteger(o.v);
    case 'attach':
    case 'seen':
      return isSurface(o.s);
    case 'detach':
    case 'ping':
      return true;
    case 'send':
      // No MAX_TEXT check here on purpose: an over-long text is answered with
      // `ack{too-long}` so the composer can say so, not dropped as bad-frame.
      return isSurface(o.s) && isNonce(o.nonce) && typeof o.text === 'string'
        && typeof o.submit === 'boolean' && isOptionalBool(o.force);
    case 'key':
      return isSurface(o.s) && isNonce(o.nonce) && typeof o.key === 'string'
        && REMOTE_KEY_SET.has(o.key) && isOptionalBool(o.force);
    case 'answer':
      return isSurface(o.s) && isNonce(o.nonce) && typeof o.choiceId === 'string'
        && CHOICE_ID_RE.test(o.choiceId);
  }
}

/**
 * Accepts either the raw text frame or an already-parsed value. Strict: an
 * unknown `t`, an unknown field, or a wrong type is `bad-frame`.
 */
export function validateClientMessage(raw: unknown): ValidateResult {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_FRAME) return BAD;
    try {
      value = JSON.parse(raw);
    } catch {
      return BAD;
    }
  }
  if (!isRecord(value)) return BAD;
  const t = value.t;
  if (typeof t !== 'string' || !Object.hasOwn(SCOPE_OF, t)) return BAD;
  const type = t as ClientMessageType;
  if (!hasOnlyAllowedFields(value, type) || !fieldsValid(value, type)) return BAD;
  return { ok: true, msg: value as unknown as ClientMessage };
}

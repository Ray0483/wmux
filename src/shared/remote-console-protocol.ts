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
/** The shape of a choice id on the WIRE (not of a declared one — see `wireChoiceIds`). */
export const CHOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The id each declared choice travels under, index for index (#254).
 *
 * `wmux report-agent --choices` accepts any non-blank id ("allow once", "1.",
 * a 40-character one) and always has; the desktop answers by that id. The wire
 * carries only CHOICE_ID_RE, so a declared id of that shape goes as-is and any
 * other goes as an OPAQUE id: `c<index>` into the declared array, prefixed
 * with `_` until it equals no id on the wire for that prompt — a real id
 * spelled `c1` keeps `c1`, and the unsafe choice at index 1 becomes `_c1`.
 * Deterministic over the array, so the session resolves an answer by running
 * the same function over the CURRENT prompt's choices (`resolveWireChoiceId`),
 * after the prompt id has been checked; nothing is remembered between the two.
 * At most 12 choices, so the longest opaque id stays far under 32 characters.
 */
export function wireChoiceIds(ids: readonly string[]): string[] {
  const used = new Set(ids.filter((id) => CHOICE_ID_RE.test(id)));
  return ids.map((id, i) => {
    if (CHOICE_ID_RE.test(id)) return id;
    let wire = `c${i}`;
    while (used.has(wire)) wire = `_${wire}`;
    used.add(wire);
    return wire;
  });
}

/** The declared id a wire id names among `ids`, or null when it names none. */
export function resolveWireChoiceId(ids: readonly string[], wireId: string): string | null {
  const i = wireChoiceIds(ids).indexOf(wireId);
  return i < 0 ? null : ids[i];
}
/** A device name's cap, applied by the server (devices.ts) and mirrored by the phone's pair field. */
export const DEVICE_NAME_MAX = 64;
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
  | { t: 'send'; s: string; nonce: string; text: string; submit: boolean; force?: ConfirmKind[]; prompt?: number }
  | { t: 'key'; s: string; nonce: string; key: RemoteKey; force?: ConfirmKind[]; prompt?: number }
  /** `prompt`: the roster's `promptId` for the question the user answered. */
  | { t: 'answer'; s: string; nonce: string; choiceId: string; prompt: number };

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

/**
 * `force` on a resend lists the confirms the user ACCEPTED, one entry per
 * kind. A list and not a boolean because a waiver answers one question:
 * accepting "insert without Enter while blocked" must not also answer "send
 * several lines into a terminal that is not in paste mode", or a multiline
 * Insert types CRs into the prompt it was meant to leave alone. The server
 * bypasses exactly the listed checks and asks any other one afresh.
 *
 * A `blocked` waiver is about ONE question, so it travels with `prompt` (the
 * roster's `promptId`, or the one a `confirm` ack named): a waiver for a
 * prompt the pane has moved on from is not a waiver, and is asked again.
 */
export const CONFIRM_KINDS = ['blocked', 'interrupt', 'multiline'] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

export type AckCode =
  | 'forbidden' | 'rate' | 'gone' | 'confirm'
  | 'not-blocked' | 'no-choices' | 'unknown-choice'
  /** The pane is asking a different question than the one this answer was chosen for. */
  | 'stale'
  | 'too-long' | 'bad-key' | 'write-failed'
  /** Several lines, no Enter, and a terminal not in paste mode: every line break would BE an Enter. */
  | 'multiline-insert';

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
  /** Which question `choices` belong to; null when not declared blocked. Sent back in `answer`. */
  promptId: number | null;
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
  /** `rate`: the attach itself was refused by the per-device attach budget; the view may ask again. */
  | { t: 'term.error'; s: string; code: 'no-terminal' | 'timeout' | 'gone' | 'rate'; message: string }
  | {
      t: 'ack'; nonce: string; ok: boolean; code?: AckCode; confirm?: ConfirmKind; duplicate?: boolean;
      /** With `confirm: 'blocked'`: the prompt the confirm is about, to send back with the waiver. */
      prompt?: number;
      /**
       * `ok`, with the text typed but the trailing Enter withheld: the agent
       * went blocked in the gap before it. Not a refusal — the text DID land,
       * so nothing may resend it.
       */
      submitSkipped?: boolean;
    }
  | { t: 'error'; code: 'bad-frame' | 'hello-required' | 'forbidden' | 'rate'; message: string }
  /**
   * `replaced`: this browser paired again (another tab scanned a new code), so
   * the record behind this socket was superseded rather than removed. The page
   * must not treat it as a revocation of the browser: the new page key in its
   * shared storage belongs to the tab that paired.
   */
  | { t: 'revoked'; replaced?: true }
  | { t: 'pong' };

/**
 * The page key (devices.ts header): kept by the phone in origin-scoped
 * storage and presented beside the host-scoped cookie. On the WebSocket it
 * rides as a second offered subprotocol, `wmux-key.<key>`, so it is checked in
 * the upgrade gate before ws ever sees the request and never sits in a URL;
 * the server only ever SELECTS `wmux`, so the key is not echoed back. On
 * `/api/session` it is a request header.
 */
export const WS_SUBPROTOCOL = 'wmux';
export const WS_KEY_PROTOCOL_PREFIX = 'wmux-key.';
export const DEVICE_KEY_HEADER = 'x-wmux-key';

export const CLOSE_CODES = {
  /** First frame was not `hello`, or its version is not ours. */
  HELLO: 4400,
  /** Device revoked, or the cookie no longer verifies. */
  REVOKED: 4401,
  HEARTBEAT: 4408,
  /**
   * This device already has its maximum of live sockets (or the server all of
   * its). Final for the tab that gets it: another tab of the same phone is
   * holding the slot, and retrying would only fight it for it.
   */
  TOO_MANY: 4409,
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
  send: ['t', 's', 'nonce', 'text', 'submit', 'force', 'prompt'],
  key: ['t', 's', 'nonce', 'key', 'force', 'prompt'],
  answer: ['t', 's', 'nonce', 'choiceId', 'prompt'],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isSurface = (v: unknown): v is string => typeof v === 'string' && SURFACE_ID_RE.test(v);
const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE_RE.test(v);
const CONFIRM_KIND_SET: ReadonlySet<string> = new Set(CONFIRM_KINDS);
const isPrompt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isOptionalPrompt = (v: unknown): boolean => v === undefined || isPrompt(v);
/** Absent, or a non-empty list of distinct known confirm kinds. */
const isOptionalForce = (v: unknown): boolean => {
  if (v === undefined) return true;
  if (!Array.isArray(v) || v.length === 0 || v.length > CONFIRM_KINDS.length) return false;
  return v.every((k) => typeof k === 'string' && CONFIRM_KIND_SET.has(k)) && new Set(v).size === v.length;
};

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
        && typeof o.submit === 'boolean' && isOptionalForce(o.force) && isOptionalPrompt(o.prompt);
    case 'key':
      return isSurface(o.s) && isNonce(o.nonce) && typeof o.key === 'string'
        && REMOTE_KEY_SET.has(o.key) && isOptionalForce(o.force) && isOptionalPrompt(o.prompt);
    case 'answer':
      return isSurface(o.s) && isNonce(o.nonce) && typeof o.choiceId === 'string'
        && CHOICE_ID_RE.test(o.choiceId) && isPrompt(o.prompt);
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

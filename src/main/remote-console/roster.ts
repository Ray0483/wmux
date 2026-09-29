/**
 * The agent roster as the phone sees it (#254, spec §9).
 *
 * Pure. Input is what `__wmux_remoteRoster()` answered in each window, which
 * arrives through `executeJavaScript` and is therefore trusted no further than
 * its shape can be checked: every field is validated here, a malformed entry
 * is dropped rather than half-forwarded, and a malformed CHOICE is dropped
 * without taking its entry with it.
 *
 * Output is the wire `RemoteRosterEntry`, built field by field (never by
 * spreading the source), so a field someone later adds to the renderer's
 * roster cannot reach a phone without a line here that says so (I7). Labels go
 * through `stripBidi` and a 200-character cap: they are agent-controlled text
 * rendered on a device the user trusts to show them the truth (#221).
 *
 * Done is per DEVICE, not global: "this finished while you were not looking"
 * is a fact about a viewer. A desktop keystroke into the pane clears it for
 * every device, because the human evidently saw it.
 */
import type { RemoteAgentState, RemoteRosterEntry } from '../../shared/remote-console-protocol';
import { CHOICE_ID_RE, SURFACE_ID_RE } from '../../shared/remote-console-protocol';
import type { RemoteRosterSource } from '../../shared/remote-console-config';
import { capText, stripBidi } from '../../shared/remote-input';

export const LABEL_MAX = 200;
const STATES: ReadonlySet<string> = new Set(['blocked', 'working', 'idle', 'unknown']);
const SOURCES: ReadonlySet<string> = new Set(['declared', 'detected']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseChoices(v: unknown): RemoteRosterSource['choices'] | null {
  if (!Array.isArray(v)) return null;
  const out: RemoteRosterSource['choices'] = [];
  for (const c of v) {
    if (!isRecord(c) || !isStr(c.id) || !isStr(c.label)) continue;
    out.push(c.isDefault === true ? { id: c.id, label: c.label, isDefault: true } : { id: c.id, label: c.label });
  }
  return out;
}

/** One `RemoteRosterSource`, or null when anything load-bearing is the wrong type. */
export function parseRosterSource(v: unknown): RemoteRosterSource | null {
  if (!isRecord(v)) return null;
  const { surfaceId, workspaceId, workspaceTitle, label, kind, state, stateSource, blockedReason, answerPending, dwellMs } = v;
  if (!isStr(surfaceId) || !SURFACE_ID_RE.test(surfaceId)) return null;
  if (!isStr(workspaceId) || !isStr(workspaceTitle) || !isStr(label)) return null;
  if (!isStrOrNull(kind) || !isStrOrNull(blockedReason)) return null;
  if (!isStr(state) || !STATES.has(state)) return null;
  if (stateSource !== null && !(isStr(stateSource) && SOURCES.has(stateSource))) return null;
  if (typeof answerPending !== 'boolean') return null;
  const choices = parseChoices(v.choices);
  if (!choices) return null;
  const dwell = typeof dwellMs === 'number' && Number.isFinite(dwellMs) ? Math.max(0, dwellMs) : 0;
  return {
    surfaceId,
    workspaceId,
    workspaceTitle,
    label,
    kind,
    state: state as RemoteAgentState,
    stateSource: stateSource as RemoteRosterSource['stateSource'],
    blockedReason,
    choices,
    answerPending,
    dwellMs: dwell,
  };
}

/**
 * One array per window (#143: a surface may live in window 2), merged. The
 * first window to name a surface wins — a surface belongs to one window, so a
 * second answer is a stale store, not a second opinion.
 */
export function mergeRosters(perWindow: unknown): RemoteRosterSource[] {
  const out: RemoteRosterSource[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(perWindow)) return out;
  for (const win of perWindow) {
    if (!Array.isArray(win)) continue;
    for (const raw of win) {
      const src = parseRosterSource(raw);
      if (!src || seen.has(src.surfaceId)) continue;
      seen.add(src.surfaceId);
      out.push(src);
    }
  }
  return out;
}

/**
 * Done, for one device. Set on a working → idle edge; cleared by `seen`,
 * `attach`, desktop input, re-entering working, or the surface disappearing.
 */
export class DoneTracker {
  private prev = new Map<string, RemoteAgentState>();
  private done = new Map<string, number>();

  update(list: readonly RemoteRosterSource[], now: number): void {
    const next = new Map<string, RemoteAgentState>();
    for (const e of list) {
      const was = this.prev.get(e.surfaceId);
      if (e.state === 'working') this.done.delete(e.surfaceId);
      else if (was === 'working' && e.state === 'idle') this.done.set(e.surfaceId, now);
      next.set(e.surfaceId, e.state);
    }
    for (const s of this.done.keys()) if (!next.has(s)) this.done.delete(s);
    this.prev = next;
  }

  /** True when a Done mark was actually removed (so the caller knows whether to re-send). */
  clear(surfaceId: string): boolean {
    return this.done.delete(surfaceId);
  }

  doneAt(surfaceId: string): number | null {
    return this.done.get(surfaceId) ?? null;
  }
}

type Sortable = { src: RemoteRosterSource; doneAt: number | null };

function bucket(e: Sortable): number {
  if (e.src.state === 'blocked') return 0;
  if (e.doneAt !== null) return 1;
  if (e.src.state === 'working') return 2;
  if (e.src.state === 'idle') return 3;
  return 4;
}

/** Blocked (longest dwell first), done (newest first), working, idle, unknown. Stable within a bucket. */
export function sortRoster<T extends Sortable>(entries: readonly T[]): T[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ba = bucket(a.e);
      const bb = bucket(b.e);
      if (ba !== bb) return ba - bb;
      if (ba === 0 && a.e.src.dwellMs !== b.e.src.dwellMs) return b.e.src.dwellMs - a.e.src.dwellMs;
      if (ba === 1 && a.e.doneAt !== b.e.doneAt) return (b.e.doneAt ?? 0) - (a.e.doneAt ?? 0);
      return a.i - b.i;
    })
    .map((x) => x.e);
}

const clean = (s: string): string => capText(stripBidi(s), LABEL_MAX);

/**
 * The wire entry. Explicit fields only; choices keep `{id,label,isDefault}`
 * and drop any id the protocol would refuse to carry back in an `answer`.
 */
export function toWire(src: RemoteRosterSource, done: boolean): RemoteRosterEntry {
  const choices: RemoteRosterEntry['choices'] = [];
  for (const c of src.choices) {
    if (!CHOICE_ID_RE.test(c.id)) continue;
    choices.push(c.isDefault === true ? { id: c.id, label: clean(c.label), isDefault: true } : { id: c.id, label: clean(c.label) });
  }
  return {
    s: src.surfaceId,
    workspaceId: capText(src.workspaceId, LABEL_MAX),
    workspaceTitle: clean(src.workspaceTitle),
    label: clean(src.label),
    kind: src.kind === null ? null : clean(src.kind),
    state: src.state,
    stateSource: src.stateSource,
    done,
    blockedReason: src.blockedReason === null ? null : clean(src.blockedReason),
    choices,
    answerPending: src.answerPending,
    dwellMs: Math.round(src.dwellMs),
  };
}

/** The sorted wire list for one device. */
export function buildWireRoster(list: readonly RemoteRosterSource[], tracker: DoneTracker): RemoteRosterEntry[] {
  const sortable = list.map((src) => ({ src, doneAt: src.state === 'working' ? null : tracker.doneAt(src.surfaceId) }));
  return sortRoster(sortable).map((e) => toWire(e.src, e.doneAt !== null));
}

/**
 * The change key for "send only on change". `dwellMs` grows on every pump
 * tick while an agent is blocked, so including it would make every tick a
 * change; the phone extrapolates dwell from the message's `at` instead.
 */
export function rosterChangeKey(list: readonly RemoteRosterEntry[]): string {
  return JSON.stringify(list.map(({ dwellMs: _dwell, ...rest }) => rest));
}

// ── Notifications ─────────────────────────────────────────────────────

export const NOTIFY_BLOCKED_DEBOUNCE_MS = 5_000;
export const NOTIFY_DONE_DEBOUNCE_MS = 3_000;
export const NOTIFY_PER_SURFACE_MS = 10_000;
const SENT_KEY_TTL_MS = 10 * 60_000;

export interface RemoteNotification {
  kind: 'blocked' | 'done';
  s: string;
  label: string;
  at: number;
}

interface PendingEdge {
  kind: 'blocked' | 'done';
  s: string;
  edgeAt: number;
  dueAt: number;
}

export interface NotifyState {
  seeded: boolean;
  prev: Map<string, RemoteAgentState>;
  pending: PendingEdge[];
  sentKeys: Map<string, number>;
  lastPerSurface: Map<string, number>;
}

export function createNotifyState(): NotifyState {
  return { seeded: false, prev: new Map(), pending: [], sentKeys: new Map(), lastPerSurface: new Map() };
}

function stillTrue(edge: PendingEdge, entry: RemoteRosterSource | undefined): boolean {
  if (!entry) return false;
  // Re-checked at the due time: an agent that was answered (or answered
  // itself) inside the debounce is not a reason to buzz a phone.
  if (edge.kind === 'blocked') return entry.state === 'blocked' && !entry.answerPending;
  return entry.state === 'idle';
}

/**
 * Edges → debounced, re-checked, deduped notifications. Blocked waits 5 s,
 * done 3 s; one key per (surface, kind, edge time); at most one per surface
 * per 10 s. The FIRST call only seeds: an agent already blocked when the first
 * phone connects is on the roster it is about to receive, not news.
 * Never carries agent text beyond the (sanitised) label.
 */
function collectEdges(state: NotifyState, list: readonly RemoteRosterSource[], now: number): void {
  for (const e of list) {
    const was = state.prev.get(e.surfaceId);
    if (e.state === 'blocked' && was !== 'blocked') {
      state.pending.push({ kind: 'blocked', s: e.surfaceId, edgeAt: now, dueAt: now + NOTIFY_BLOCKED_DEBOUNCE_MS });
    } else if (was === 'working' && e.state === 'idle') {
      state.pending.push({ kind: 'done', s: e.surfaceId, edgeAt: now, dueAt: now + NOTIFY_DONE_DEBOUNCE_MS });
    }
  }
}

/** A due edge that survived its re-check, or null when it is dropped. */
function release(state: NotifyState, edge: PendingEdge, entry: RemoteRosterSource | undefined, now: number): RemoteNotification | null {
  if (!entry || !stillTrue(edge, entry)) return null;
  const key = `${edge.s}|${edge.kind}|${edge.edgeAt}`;
  if (state.sentKeys.has(key)) return null;
  const last = state.lastPerSurface.get(edge.s);
  if (last !== undefined && now - last < NOTIFY_PER_SURFACE_MS) return null;
  state.sentKeys.set(key, now);
  state.lastPerSurface.set(edge.s, now);
  return { kind: edge.kind, s: edge.s, label: clean(entry.label), at: now };
}

export function diffNotifications(state: NotifyState, list: readonly RemoteRosterSource[], now: number): RemoteNotification[] {
  const byId = new Map(list.map((e) => [e.surfaceId, e]));
  if (state.seeded) collectEdges(state, list, now);
  state.seeded = true;
  state.prev = new Map(list.map((e) => [e.surfaceId, e.state]));

  const out: RemoteNotification[] = [];
  const keep: PendingEdge[] = [];
  for (const edge of state.pending) {
    if (edge.dueAt > now) {
      keep.push(edge);
      continue;
    }
    const n = release(state, edge, byId.get(edge.s), now);
    if (n) out.push(n);
  }
  state.pending = keep;
  for (const [k, at] of state.sentKeys) if (now - at > SENT_KEY_TTL_MS) state.sentKeys.delete(k);
  return out;
}

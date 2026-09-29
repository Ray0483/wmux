/**
 * The seam between the Remote Console runtime (P1) and the rest of main (#254).
 *
 * `ConsoleOps` is the COMPLETE list of what the console can do to the app, and
 * index.ts builds it. That is invariant I1 made structural: the runtime never
 * imports ptyManager, agent-state or the pipe server, so it cannot reach the
 * pipe token or the V2 switch even by accident — everything it touches is here
 * and nowhere else.
 *
 * Type-only Electron import, so this file costs nothing at runtime and loads
 * under vitest with no Electron.
 */
import type { WebContents } from 'electron';
import type {
  PairOffer,
  RemoteConsoleStatus,
  RemoteDesktopNotice,
  RemoteModesResult,
  RemoteRendererRequest,
  RemoteSnapshotResult,
  RemoteV2Status,
} from '../../shared/remote-console-config';
import type { RemoteScope } from '../../shared/remote-console-protocol';

export type DeliverAnswerReason = 'not-blocked' | 'no-choices' | 'unknown-choice' | 'unknown-surface' | 'write-failed';

export interface ConsoleOps {
  /** `__wmux_remoteRoster()` on every window; one array per window, merged by the runtime (#143). */
  listRoster(): Promise<unknown[][]>;
  isLivePty(id: string): boolean;
  /** Declared blocked only: `getAgentState(id)?.state === 'blocked'`. */
  isBlocked(id: string): boolean;
  runDepth(id: string): number;
  isAnsweringInput(bytes: string): boolean;
  /** Must run immediately before each `write` with the identical bytes (I4). */
  noteHumanInput(id: string, bytes: string): void;
  write(id: string, bytes: string): void;
  /** The `pane.answer_agent` path: blocked-only, declared payload only, never clears blocked. */
  deliverAnswer(id: string, choiceId: string): Promise<{ ok: true } | { ok: false; reason: DeliverAnswerReason }>;
  notifyDesktop(notice: RemoteDesktopNotice): void;
  lanAddresses(): string[];
  hostname(): string;
  /** main.log. Byte counts only, never typed content (I7). */
  log(event: string, fields: Record<string, unknown>): void;
  appDataDir(): string;
  /** `dist/renderer`, resolved in main — never derived from request data. */
  staticRoot(): string;
}

export interface RemoteConsoleRuntime {
  /** Loads config; listens only if enabled. Idempotent. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Synchronous teardown for `will-quit`, which cannot await: clear timers,
   * terminate sockets, `server.close()`, reset the taps — and return.
   */
  stopNow(): void;
  reconfigure(): Promise<void>;
  getStatus(): RemoteConsoleStatus;
  v2Status(): RemoteV2Status;
  setConfig(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  pairStart(o: { name: string; scope: RemoteScope }): PairOffer | { error: string };
  pairCancel(): void;
  /** `write-failed`: cut off live, but the file write did not land (retried on the next change or reload). */
  revoke(id: string): { error: 'write-failed' } | undefined;
  revokeAll(): { error: 'write-failed' } | undefined;
  rename(id: string, name: string): void;
  dismissRejectedOrigin(): void;
  onStatus(cb: (status: RemoteConsoleStatus) => void): () => void;
  notifyAgentStateChanged(): void;
  handleRendererReply(reqId: string, result: RemoteSnapshotResult | RemoteModesResult): void;
  setRendererSender(fn: (wc: WebContents, req: RemoteRendererRequest) => boolean): void;
}

export type CreateRemoteConsoleRuntime = (ops: ConsoleOps) => RemoteConsoleRuntime;

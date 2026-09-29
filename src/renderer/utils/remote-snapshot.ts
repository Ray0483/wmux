/**
 * The desktop renderer's half of the remote console's terminal attach (#254).
 *
 * When a phone attaches to a surface, main needs the terminal AS IT IS — every
 * byte already sent, none of the ones still to come — and then streams the rest
 * itself. Main cannot read xterm's buffer; only this renderer can. The ordering
 * argument (spelled out in main's terminal-tap module) ends here:
 *
 *   - main sends REMOTE_RENDERER_REQUEST on the SAME webContents that receives
 *     that surface's PTY_DATA, after the last chunk it forwarded pre-attach;
 *   - Electron keeps send order to one frame across channels, and the PTY_DATA
 *     listener calls `terminal.write` synchronously, so by the time this
 *     handler runs, exactly the pre-request bytes are queued in xterm;
 *   - `terminal.write(SNAPSHOT_FENCE, cb)` joins the back of that queue, and xterm
 *     fires `cb` only once everything ahead of it has been parsed.
 *
 * So the serialize has to happen synchronously INSIDE the callback. An await, a
 * rAF or a setTimeout between the callback and `serialize()` lets the next
 * PTY_DATA chunk be parsed first, and the phone then receives those bytes twice:
 * once inside the snapshot and once from main's buffered stream.
 *
 * Zero cost while the console is idle: nothing here runs until main asks, and
 * the SerializeAddon is the one useTerminal already loads for remounts
 * (`surfaceSerializerRegistry`), not a second instance per terminal.
 */
import type {
  RemoteConsoleBridge,
  RemoteModesResult,
  RemoteRendererRequest,
  RemoteSnapshotResult,
} from '../../shared/remote-console-config';
import { surfaceSerializerRegistry, surfaceTerminalRegistry } from '../hooks/useTerminal';

/**
 * Written through xterm's queue to find out when the pre-request bytes have been
 * parsed. The spec allowed `''` only if an empty write's callback is ordered
 * behind earlier writes, with `'\x1b]6973;\x07'` (an OSC xterm ignores) as the
 * fallback. tests/harness/remote-fence.html measured it against real
 * @xterm/xterm 6.0.0 + @xterm/addon-serialize 0.14.0 in Chromium on 2026-09-29:
 * 8/8 cases passed for BOTH fences — a 20 000-line chunk, 50 small writes, and
 * nothing queued ahead — so the empty write is ordered and nothing is injected
 * into the desktop terminal's stream. Re-run the harness before an xterm bump.
 */
export const SNAPSHOT_FENCE = '';

/**
 * Upper bound on a snapshot payload, in UTF-16 code units (the `string.length`
 * that goes into the JSON on the IPC hop and then the WebSocket frame). 1000
 * lines of scrollback full of SGR runs can exceed it; the phone keeps the
 * NEWEST part, because that is the part it is about to append to.
 *
 * Kept below the tap's `lagHigh` (1 MiB of socket backlog, terminal-tap.ts):
 * the reset goes out in one piece, and one larger than the lag threshold is a
 * phone that reads as lagging before it has drawn anything.
 */
export const SNAPSHOT_MAX_CHARS = 512 * 1024;

/** The slice of an xterm Terminal the handler touches. */
export interface SnapshotTerminal {
  write(data: string, callback?: () => void): void;
  readonly cols: number;
  readonly rows: number;
  readonly modes: { readonly bracketedPasteMode: boolean };
}

/** The slice of a SerializeAddon the handler touches. */
export interface SnapshotSerializer {
  serialize(options?: { scrollback?: number }): string;
}

export interface RemoteRendererLookups {
  terminal(surfaceId: string): SnapshotTerminal | undefined;
  serializer(surfaceId: string): SnapshotSerializer | undefined;
}

/**
 * Keep the last `max` characters of `data`, cut forward to the next row
 * boundary. Starting mid-row would put half a line — possibly half an escape
 * sequence — at the top of the phone's terminal; starting on a row start costs
 * at most one row more.
 */
export function capTop(data: string, max: number): string {
  if (data.length <= max) return data;
  const start = data.length - max;
  const nl = data.indexOf('\n', start);
  // No newline in the kept tail (one gigantic row): a raw cut is all there is.
  return nl === -1 ? data.slice(start) : data.slice(nl + 1);
}

/**
 * Answer one request from main. Pure except for the calls it makes on the
 * looked-up terminal, so the ordering contract is testable with a fake.
 */
export function handleRemoteRequest(
  req: RemoteRendererRequest,
  lookups: RemoteRendererLookups,
  reply: (result: RemoteSnapshotResult | RemoteModesResult) => void,
): void {
  const terminal = lookups.terminal(req.surfaceId);
  if (req.kind === 'modes') {
    reply(terminal ? { bracketedPaste: !!terminal.modes.bracketedPasteMode } : { error: 'no-terminal' });
    return;
  }
  const serializer = lookups.serializer(req.surfaceId);
  if (!terminal || !serializer) {
    reply({ error: 'no-terminal' });
    return;
  }
  terminal.write(SNAPSHOT_FENCE, () => {
    // Synchronous, on purpose — see the module header.
    //
    // And guarded, because this runs INSIDE xterm's WriteBuffer loop, not
    // under the listener's try/catch (that frame returned long ago). A throw
    // here escapes `_innerWrite` before it advances `_bufferOffset` or
    // schedules the next pass, and since the queue is then non-empty, no later
    // `write()` schedules one either: the DESKTOP pane stops rendering for
    // good. A phone's snapshot failing must never cost the user their
    // terminal; main's 10 s timeout turns the silence into term.error.
    try {
      reply({
        data: capTop(serializer.serialize({ scrollback: 1000 }), SNAPSHOT_MAX_CHARS),
        cols: terminal.cols,
        rows: terminal.rows,
      });
    } catch {
      // Swallowed — see above.
    }
  });
}

function bridge(): RemoteConsoleBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.wmux?.remoteConsole as RemoteConsoleBridge | undefined;
}

/** The live registries useTerminal keeps; read per request, never cached. */
const liveLookups: RemoteRendererLookups = {
  terminal: (id) => surfaceTerminalRegistry.get(id),
  serializer: (id) => surfaceSerializerRegistry.get(id),
};

/**
 * Subscribe this window to main's snapshot/modes requests. Returns the
 * unsubscribe function — a no-op when the preload exposes no remote console
 * (an older preload, a test) — so App can hand it straight to useEffect.
 * No store subscription: a request arrives only while a phone is attaching.
 */
export function installRemoteRendererHandler(lookups: RemoteRendererLookups = liveLookups): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onRendererRequest((req) => {
    try {
      handleRemoteRequest(req, lookups, (result) => b.replyRenderer(req.reqId, result));
    } catch {
      // A throw here (a terminal disposed between lookup and write) must not
      // escape into the IPC listener. Main's 10 s timeout and single retry
      // turn the silence into term.error for the phone.
    }
  });
}

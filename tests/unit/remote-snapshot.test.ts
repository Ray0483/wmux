import { afterEach, describe, expect, it, vi } from 'vitest';

// The real module graph pulls in xterm and its CSS; the handler only needs the
// two registries, which the tests below bypass with explicit lookups anyway.
vi.mock('../../src/renderer/hooks/useTerminal', () => ({
  surfaceTerminalRegistry: new Map(),
  surfaceSerializerRegistry: new Map(),
}));

import {
  SNAPSHOT_FENCE,
  SNAPSHOT_MAX_CHARS,
  capTop,
  handleRemoteRequest,
  installRemoteRendererHandler,
  type RemoteRendererLookups,
} from '../../src/renderer/utils/remote-snapshot';
import type {
  RemoteModesResult,
  RemoteRendererRequest,
  RemoteSnapshotResult,
} from '../../src/shared/remote-console-config';

/**
 * A terminal that models xterm's WriteBuffer: writes are QUEUED and parsed
 * later, in order, each callback firing after its own chunk. That queue is the
 * whole point of the fence — a fake that applied writes immediately would pass
 * a handler that serialized outside the callback.
 */
class FakeTerminal {
  cols = 120;
  rows = 30;
  modes = { bracketedPasteMode: false };
  parsed = '';
  private queue: { data: string; cb?: () => void }[] = [];
  write(data: string, cb?: () => void): void {
    this.queue.push({ data, cb });
  }
  /** Parse everything queued, as xterm's setTimeout pass would. */
  drain(): void {
    while (this.queue.length) {
      const { data, cb } = this.queue.shift()!;
      this.parsed += data;
      cb?.();
    }
  }
}

function setup(opts: { terminal?: boolean; serializer?: boolean } = {}) {
  const term = new FakeTerminal();
  const serialize = vi.fn((_o?: { scrollback?: number }) => term.parsed);
  const lookups: RemoteRendererLookups = {
    terminal: (id) => (opts.terminal !== false && id === 'surf-1' ? term : undefined),
    serializer: (id) => (opts.serializer !== false && id === 'surf-1' ? { serialize } : undefined),
  };
  const replies: (RemoteSnapshotResult | RemoteModesResult)[] = [];
  return { term, serialize, lookups, replies, reply: (r: RemoteSnapshotResult | RemoteModesResult) => replies.push(r) };
}

const snap = (surfaceId = 'surf-1'): RemoteRendererRequest => ({ kind: 'snapshot', surfaceId, reqId: 'r1' });

describe('handleRemoteRequest — snapshot', () => {
  it('replies inside the fence callback, after every previously queued write and before later ones', () => {
    const { term, serialize, lookups, replies, reply } = setup();
    term.write('A1 ');
    term.write('A2 ');
    handleRemoteRequest(snap(), lookups, reply);
    term.write('B-after');

    // Nothing is serialized until xterm has parsed what was ahead of the fence.
    expect(serialize).not.toHaveBeenCalled();
    expect(replies).toEqual([]);

    term.drain();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith({ scrollback: 1000 });
    expect(replies).toEqual([{ data: 'A1 A2 ' + SNAPSHOT_FENCE, cols: 120, rows: 30 }]);
    expect((replies[0] as { data: string }).data).not.toContain('B-after');
  });

  it('writes exactly the fence the harness settled on', () => {
    const { term, lookups, reply } = setup();
    const spy = vi.spyOn(term, 'write');
    handleRemoteRequest(snap(), lookups, reply);
    expect(spy).toHaveBeenCalledWith(SNAPSHOT_FENCE, expect.any(Function));
    expect(SNAPSHOT_FENCE).toBe('');
  });

  it('answers no-terminal when the terminal is missing', () => {
    const { lookups, replies, reply } = setup({ terminal: false });
    handleRemoteRequest(snap(), lookups, reply);
    expect(replies).toEqual([{ error: 'no-terminal' }]);
  });

  it('answers no-terminal when the serializer is missing, and writes nothing', () => {
    const { term, lookups, replies, reply } = setup({ serializer: false });
    const spy = vi.spyOn(term, 'write');
    handleRemoteRequest(snap(), lookups, reply);
    expect(replies).toEqual([{ error: 'no-terminal' }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers no-terminal for a surface this window does not host', () => {
    const { lookups, replies, reply } = setup();
    handleRemoteRequest(snap('surf-other'), lookups, reply);
    expect(replies).toEqual([{ error: 'no-terminal' }]);
  });

  it('truncates a snapshot over 2 MiB from the TOP, starting on a row boundary', () => {
    const { term, lookups, replies, reply } = setup();
    const row = 'x'.repeat(1022) + '\r\n'; // 1024 chars per row
    const rows = SNAPSHOT_MAX_CHARS / 1024 + 10;
    let big = '';
    for (let i = 0; i < rows; i++) big += i === rows - 1 ? 'LAST' + row.slice(4) : row;
    term.write('FIRST' + big);
    handleRemoteRequest(snap(), lookups, reply);
    term.drain();
    const data = (replies[0] as { data: string }).data;
    expect(data.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS);
    expect(data.startsWith('x')).toBe(true);
    expect(data).not.toContain('FIRST');
    expect(data).toContain('LAST');
    expect(data.endsWith('\r\n')).toBe(true);
  });
});

describe('capTop', () => {
  it('passes a payload at or under the cap through unchanged', () => {
    expect(capTop('abc\ndef', 7)).toBe('abc\ndef');
  });
  it('cuts forward to the next newline', () => {
    expect(capTop('aaaa\nbbbb\ncccc', 7)).toBe('cccc');
  });
  it('falls back to a raw cut when the kept tail has no newline', () => {
    expect(capTop('x'.repeat(20), 5)).toBe('xxxxx');
  });
});

describe('handleRemoteRequest — modes', () => {
  it('reports bracketed paste synchronously, without touching the write queue', () => {
    const { term, lookups, replies, reply } = setup();
    const spy = vi.spyOn(term, 'write');
    term.modes.bracketedPasteMode = true;
    handleRemoteRequest({ kind: 'modes', surfaceId: 'surf-1', reqId: 'm1' }, lookups, reply);
    term.modes.bracketedPasteMode = false;
    handleRemoteRequest({ kind: 'modes', surfaceId: 'surf-1', reqId: 'm2' }, lookups, reply);
    expect(replies).toEqual([{ bracketedPaste: true }, { bracketedPaste: false }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers no-terminal for an unknown surface', () => {
    const { lookups, replies, reply } = setup();
    handleRemoteRequest({ kind: 'modes', surfaceId: 'nope', reqId: 'm' }, lookups, reply);
    expect(replies).toEqual([{ error: 'no-terminal' }]);
  });
});

describe('installRemoteRendererHandler', () => {
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });

  it('is a no-op with no window or no remoteConsole bridge', () => {
    expect(installRemoteRendererHandler()).toBeTypeOf('function');
    g.window = { wmux: {} };
    expect(() => installRemoteRendererHandler()()).not.toThrow();
  });

  it('replies through the bridge with the request id, and unsubscribes', () => {
    const listeners = new Set<(req: RemoteRendererRequest) => void>();
    const unsubscribe = vi.fn();
    const bridge = {
      onRendererRequest: vi.fn((cb: (req: RemoteRendererRequest) => void) => {
        listeners.add(cb);
        return () => {
          unsubscribe();
          listeners.delete(cb);
        };
      }),
      replyRenderer: vi.fn(),
    };
    g.window = { wmux: { remoteConsole: bridge } };
    const { term, lookups } = setup();
    term.modes.bracketedPasteMode = true;

    const off = installRemoteRendererHandler(lookups);
    expect(bridge.onRendererRequest).toHaveBeenCalledTimes(1);

    for (const l of listeners) l({ kind: 'modes', surfaceId: 'surf-1', reqId: 'req-7' });
    expect(bridge.replyRenderer).toHaveBeenCalledWith('req-7', { bracketedPaste: true });

    for (const l of listeners) l({ kind: 'snapshot', surfaceId: 'surf-1', reqId: 'req-8' });
    term.drain();
    expect(bridge.replyRenderer).toHaveBeenLastCalledWith('req-8', { data: '', cols: 120, rows: 30 });

    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('never lets a throwing lookup escape into the IPC listener', () => {
    let listener: ((req: RemoteRendererRequest) => void) | undefined;
    g.window = {
      wmux: {
        remoteConsole: {
          onRendererRequest: (cb: (req: RemoteRendererRequest) => void) => {
            listener = cb;
            return () => {};
          },
          replyRenderer: vi.fn(),
        },
      },
    };
    installRemoteRendererHandler({
      terminal: () => {
        throw new Error('disposed');
      },
      serializer: () => undefined,
    });
    expect(() => listener!({ kind: 'snapshot', surfaceId: 's', reqId: 'x' })).not.toThrow();
  });
});

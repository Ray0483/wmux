import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatRemoteStatus } from '../../src/cli/wmux';

// ─── module seams for the behavioural half ─────────────────────────────────
// ipc-handlers reaches Electron and the app data dir at import time
// (`PtyLedger.takeOver()` rewrites the ledger), so both are redirected — the
// same seams agent-browser-ipc.test.ts uses. `ipcMain` RECORDS registrations
// so the Remote Console handlers can be invoked directly.
const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, (...args: any[]) => unknown>();
vi.mock('../../src/shared/instance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), 'wmux-remote-console-wiring-test'),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: (ch: string, fn: (...a: any[]) => unknown) => { ipcListeners.set(ch, fn); },
    handle: (ch: string, fn: (...a: any[]) => unknown) => { ipcHandlers.set(ch, fn); },
  },
  // A sender is "one of wmux's windows" when the fake says so.
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (wc: any) => (wc?.isWmuxWindow ? {} : null),
    getFocusedWindow: () => null,
  },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: {},
  dialog: {},
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
  nativeTheme: { on: () => {} },
}));

import {
  ptyManager,
  registerRemoteConsoleHandlers,
  replayRemoteBindings,
  setupAgentPtyForwarding,
} from '../../src/main/ipc-handlers';
import { installRemoteTaps, resetRemoteTaps } from '../../src/main/remote-console/taps';
import { __resetRemoteConsoleForTests, initRemoteConsole } from '../../src/main/remote-console';
import { IPC_CHANNELS } from '../../src/shared/types';

/**
 * Source-level pins for the Remote Console's wiring into main (#254).
 *
 * None of this can be exercised without a live Electron: the forwarders are
 * closures inside ipcMain handlers, `will-quit` needs a real app to fire, and
 * the pipe dispatch lives in index.ts's startup body. What CAN be pinned is the
 * shape — and every property below is one whose absence fails silently:
 * a forwarder without the tap is a phone mirror that never updates for that
 * kind of pane, a second `remote.` method is a pipe path to a credential (I2),
 * and an `await` in will-quit is a teardown that never runs.
 */
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const ipc = read('src/main/ipc-handlers.ts');
const index = read('src/main/index.ts');
const pipe = read('src/main/pipe-server.ts');

/** The text of the first `{…}` block that opens at or after `from`, braces balanced. */
function blockAfter(src: string, from: number): string {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced block');
}

// bind/unbind go through the helpers that also keep main's own copy of the
// binding, so it can be replayed to a console that starts later (see below).
const TAPS = ['bindRemoteSurface(', 'remoteTaps.deliver(', 'remoteTaps.exit(', 'unbindRemoteSurface('];

describe('PTY forwarders feed the Remote Console taps (#254)', () => {
  it('the PTY_CREATE forwarder binds, delivers, exits and unbinds', () => {
    const start = ipc.indexOf('ipcMain.handle(IPC_CHANNELS.PTY_CREATE');
    expect(start).toBeGreaterThan(-1);
    const body = blockAfter(ipc, ipc.indexOf('=>', start));
    for (const tap of TAPS) expect(body, tap).toContain(tap);
  });

  it('setupAgentPtyForwarding does the same — agent panes never pass through PTY_CREATE', () => {
    const start = ipc.indexOf('export function setupAgentPtyForwarding');
    expect(start).toBeGreaterThan(-1);
    const body = blockAfter(ipc, start);
    for (const tap of TAPS) expect(body, tap).toContain(tap);
  });

  it('delivers AFTER the renderer send, and exits AFTER the flush, in both', () => {
    for (const marker of ['ipcMain.handle(IPC_CHANNELS.PTY_CREATE', 'export function setupAgentPtyForwarding']) {
      const s = ipc.indexOf(marker);
      const body = blockAfter(ipc, marker.startsWith('ipcMain') ? ipc.indexOf('=>', s) : s);
      expect(body.indexOf('remoteTaps.deliver(')).toBeGreaterThan(body.indexOf('IPC_CHANNELS.PTY_DATA'));
      expect(body.indexOf('remoteTaps.exit(')).toBeGreaterThan(body.indexOf('batcher.flush()'));
      expect(body.indexOf('unbindRemoteSurface(')).toBeGreaterThan(body.indexOf('remoteTaps.exit('));
    }
  });

  it('desktop typing and resizes reach the taps', () => {
    const write = blockAfter(ipc, ipc.indexOf('ipcMain.on(IPC_CHANNELS.PTY_WRITE'));
    expect(write).toContain('remoteTaps.noteDesktopInput(');
    const resize = blockAfter(ipc, ipc.indexOf('ipcMain.on(IPC_CHANNELS.PTY_RESIZE'));
    expect(resize).toContain('remoteTaps.noteResize(');
  });

  it('never keeps a destructured tap — installing replaces the properties in place', () => {
    expect(ipc).not.toContain('} = remoteTaps');
    expect(ipc).not.toContain('= remoteTaps.');
  });
});

describe('the pipe gets exactly one read-only method (I2)', () => {
  it('index.ts names exactly one `remote.` method', () => {
    expect(index.match(/'remote\./g) ?? []).toHaveLength(1);
    expect(index).toContain("request.method === 'remote.status'");
  });

  it('it is the FIRST statement of routeSpecialV2', () => {
    // The block after the signature's `): boolean`, not the param type literal.
    const body = blockAfter(index, index.indexOf('): boolean', index.indexOf('function routeSpecialV2')));
    const firstStatement = body.split('\n').map(l => l.trim()).find(l => l && l !== '{' && !l.startsWith('//'));
    expect(firstStatement).toMatch(/^if \(request\.method === 'remote\.status'\)/);
  });

  it('PUBLIC_V2_METHODS is untouched — remote.status needs the pipe token', () => {
    const start = pipe.indexOf('const PUBLIC_V2_METHODS');
    const decl = pipe.slice(start, pipe.indexOf(']);', start));
    expect(decl).not.toContain('remote.');
    expect([...decl.matchAll(/'([^']+)'/g)].map(m => m[1])).toEqual(['system.identify', 'system.capabilities']);
  });
});

describe('will-quit stops the console synchronously', () => {
  const start = index.indexOf("app.on('will-quit'");
  const body = blockAfter(index, index.indexOf('=>', start));

  it('calls stopNow', () => {
    expect(body).toContain('getRemoteConsole()?.stopNow()');
  });

  it('awaits nothing — will-quit cannot wait', () => {
    expect(body).not.toMatch(/\bawait\b/);
  });

  it('stops it before the PTY drain', () => {
    expect(body.indexOf('stopNow()')).toBeLessThan(body.indexOf('ptyManager.killAll()'));
  });
});

describe('the pty-keys move', () => {
  it('index.ts no longer carries its own key table', () => {
    expect(index).not.toMatch(/const PTY_KEY_MAP\b/);
    expect(index).not.toMatch(/function translateKeyName\b/);
    expect(index).toContain("from './pty-keys'");
  });
});

describe('wmux remote status (human form)', () => {
  it('says off, and where to turn it on, when disabled', () => {
    const out = formatRemoteStatus({ enabled: false, running: false, bind: 'loopback', port: 9790, publicUrl: '', deviceCount: 0, connectedCount: 0, lastError: null });
    expect(out).toContain('Remote Console: off');
    expect(out).toContain('Settings');
  });

  it('reports where it listens, the public URL and the counts', () => {
    const out = formatRemoteStatus({ enabled: true, running: true, bind: 'lan', port: 9791, publicUrl: 'https://box.ts.net', deviceCount: 2, connectedCount: 1, lastError: null });
    expect(out).toContain('listening (local network, port 9791)');
    expect(out).toContain('https://box.ts.net');
    expect(out).toContain('2 paired, 1 connected');
  });

  it('turns a lastError code into words, and passes an unknown one through', () => {
    expect(formatRemoteStatus({ enabled: true, running: false, port: 9790, lastError: 'port-busy' })).toContain('already in use');
    expect(formatRemoteStatus({ enabled: true, running: false, port: 9790, lastError: 'zzz' })).toContain('zzz');
  });

  it('ui-not-built reads as a broken install, never as a developer command (#254)', () => {
    const out = formatRemoteStatus({ enabled: true, running: true, port: 9790, lastError: 'ui-not-built' });
    expect(out).toContain('missing from this build of wmux');
    expect(out).not.toContain('vite');
  });
});

// ─── behaviour ─────────────────────────────────────────────────────────────

const SID_A = 'surf-aaaaaaaa-0000-4000-8000-000000000001';
const SID_B = 'surf-aaaaaaaa-0000-4000-8000-000000000002';
let fakeWcSeq = 0;
const fakeWc = (destroyed = false) => ({ id: ++fakeWcSeq, isDestroyed: () => destroyed, send: vi.fn(), once: vi.fn() }) as any;
const fakeWindow = (wc: any) => ({ webContents: wc, isDestroyed: () => false }) as any;

describe('bindings made BEFORE the console listens reach it (#254)', () => {
  afterEach(() => { resetRemoteTaps(); vi.restoreAllMocks(); });

  it('replays a pane bound while the taps were still no-ops', () => {
    vi.spyOn(ptyManager, 'has').mockReturnValue(true);
    const wc = fakeWc();
    // The console is off: this bind lands on the no-op default and is lost…
    setupAgentPtyForwarding(SID_A, fakeWindow(wc));
    const bind = vi.fn();
    installRemoteTaps({ bindSurface: bind });
    expect(bind).not.toHaveBeenCalled();
    // …until main hands it over when the console comes up.
    replayRemoteBindings();
    expect(bind).toHaveBeenCalledWith(SID_A, wc);
  });

  it('drops a dead PTY or a destroyed window instead of replaying it', () => {
    const live = new Set([SID_A]);
    vi.spyOn(ptyManager, 'has').mockImplementation((id: any) => live.has(id));
    setupAgentPtyForwarding(SID_A, fakeWindow(fakeWc(true)));
    setupAgentPtyForwarding(SID_B, fakeWindow(fakeWc()));
    const bind = vi.fn();
    installRemoteTaps({ bindSurface: bind });
    replayRemoteBindings();
    expect(bind).not.toHaveBeenCalled();
  });

  it('index.ts replays on the running edge, after start() and after setConfig', () => {
    expect(index).toMatch(/runtime\.start\(\)\.then\(replayRemoteBindings/);
    const onStatus = blockAfter(index, index.indexOf('runtime.onStatus('));
    expect(onStatus).toContain('replayRemoteBindings()');
    expect(ipc).toMatch(/REMOTE_CONSOLE_SET_CONFIG[\s\S]{0,200}replayRemoteBindings\(\)/);
  });
});

describe('Settings → Remote IPC gates (#254)', () => {
  const win = { sender: { isWmuxWindow: true } };
  const guest = { sender: { isWmuxWindow: false } };
  let rt: any;

  beforeEach(() => {
    ipcHandlers.clear();
    ipcListeners.clear();
    rt = {
      getStatus: vi.fn(() => ({ running: false })),
      setConfig: vi.fn(async () => ({ ok: true })),
      pairStart: vi.fn(() => ({ url: 'x' })),
      handleRendererReply: vi.fn(),
    };
    __resetRemoteConsoleForTests(() => ({ createRemoteConsoleRuntime: () => rt }) as any);
    registerRemoteConsoleHandlers();
  });
  afterEach(() => __resetRemoteConsoleForTests());

  const call = (ch: string, ev: unknown, ...args: unknown[]) => ipcHandlers.get(ch)!(ev, ...args);

  it('refuses a sender that is not one of wmux\'s windows, then an absent runtime', async () => {
    expect(await call(IPC_CHANNELS.REMOTE_CONSOLE_GET_STATE, guest)).toEqual({ error: 'forbidden' });
    expect(await call(IPC_CHANNELS.REMOTE_CONSOLE_GET_STATE, win)).toEqual({ error: 'unavailable' });
    initRemoteConsole({} as any);
    expect(await call(IPC_CHANNELS.REMOTE_CONSOLE_GET_STATE, win)).toEqual({ running: false });
  });

  it('refuses an unknown pairing scope before the runtime sees it', async () => {
    initRemoteConsole({} as any);
    expect(await call(IPC_CHANNELS.REMOTE_CONSOLE_PAIR_START, win, { name: 'p', scope: 'admin' })).toEqual({ error: 'bad-scope' });
    expect(rt.pairStart).not.toHaveBeenCalled();
  });

  it('answers a runtime throw as {error}, never as a rejection', async () => {
    initRemoteConsole({} as any);
    rt.getStatus = () => { throw new Error('boom'); };
    rt.setConfig = async () => { throw new Error('boom'); };
    await expect(call(IPC_CHANNELS.REMOTE_CONSOLE_GET_STATE, win)).resolves.toEqual({ error: 'failed' });
    await expect(call(IPC_CHANNELS.REMOTE_CONSOLE_SET_CONFIG, win, {})).resolves.toEqual({ error: 'failed' });
  });

  it('only a wmux window may supply a snapshot reply', () => {
    initRemoteConsole({} as any);
    const reply = ipcListeners.get(IPC_CHANNELS.REMOTE_RENDERER_REPLY)!;
    reply(guest, 'req-1', { data: 'forged screen', cols: 80, rows: 24 });
    reply(win, 42, { data: 'x' });
    expect(rt.handleRendererReply).not.toHaveBeenCalled();
    reply(win, 'req-1', { data: 'real', cols: 80, rows: 24 });
    expect(rt.handleRendererReply).toHaveBeenCalledWith('req-1', { data: 'real', cols: 80, rows: 24 });
  });
});

describe('the binding helpers', () => {
  it('record the binding AND forward it to the taps', () => {
    const bind = blockAfter(ipc, ipc.indexOf('function bindRemoteSurface('));
    expect(bind).toContain('remoteBindings.set(');
    expect(bind).toContain('remoteTaps.bindSurface(');
    const unbind = blockAfter(ipc, ipc.indexOf('function unbindRemoteSurface('));
    expect(unbind).toContain('remoteBindings.delete(');
    expect(unbind).toContain('remoteTaps.unbindSurface(');
  });
});

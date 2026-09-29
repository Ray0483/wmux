import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { formatRemoteStatus } from '../../src/cli/wmux';

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

const TAPS = ['remoteTaps.bindSurface(', 'remoteTaps.deliver(', 'remoteTaps.exit(', 'remoteTaps.unbindSurface('];

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
      expect(body.indexOf('remoteTaps.unbindSurface(')).toBeGreaterThan(body.indexOf('remoteTaps.exit('));
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
});

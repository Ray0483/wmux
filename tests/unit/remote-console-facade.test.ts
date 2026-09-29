import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  __resetRemoteConsoleForTests,
  getRemoteConsole,
  handleRemoteConsoleV2,
  initRemoteConsole,
} from '../../src/main/remote-console';
import type { ConsoleOps, RemoteConsoleRuntime } from '../../src/main/remote-console/contract';

afterEach(() => __resetRemoteConsoleForTests());

function fakeOps(): ConsoleOps & { log: ReturnType<typeof vi.fn> } {
  return {
    listRoster: async () => [],
    isLivePty: () => false,
    isBlocked: () => false,
    runDepth: () => 0,
    isAnsweringInput: () => false,
    noteHumanInput: () => undefined,
    write: () => undefined,
    deliverAnswer: async () => ({ ok: false, reason: 'unknown-surface' }),
    notifyDesktop: () => undefined,
    lanAddresses: () => [],
    hostname: () => 'host',
    log: vi.fn(),
    appDataDir: () => '',
    staticRoot: () => '',
  };
}

function call(method: string): { result?: unknown; error?: [number, string] } {
  const out: { result?: unknown; error?: [number, string] } = {};
  handleRemoteConsoleV2(method, {}, (r) => { out.result = r; }, (c, m) => { out.error = [c, m]; });
  return out;
}

describe('handleRemoteConsoleV2 (#254)', () => {
  it('answers remote.status with the disabled shape when there is no runtime', () => {
    expect(call('remote.status').result).toEqual({
      enabled: false, running: false, bind: 'loopback', port: 9790, publicUrl: '',
      deviceCount: 0, connectedCount: 0, lastError: null,
    });
  });

  it('carries no token, hash or secret field', () => {
    const json = JSON.stringify(call('remote.status').result).toLowerCase();
    for (const word of ['token', 'hash', 'secret', 'cookie']) expect(json).not.toContain(word);
  });

  it('refuses every other method with -32601 (no pipe path to pair, enable or revoke)', () => {
    for (const m of ['remote.pair', 'remote.enable', 'remote.revoke', 'remote.set_config', 'remote.']) {
      expect(call(m)).toEqual({ error: [-32601, 'Unknown: ' + m] });
    }
  });

  it('answers with the runtime\'s v2Status once one exists', () => {
    const status = { enabled: true, running: true, bind: 'loopback', port: 9791, publicUrl: '', deviceCount: 2, connectedCount: 1, lastError: null };
    const runtime = { v2Status: () => status } as unknown as RemoteConsoleRuntime;
    __resetRemoteConsoleForTests(() => ({ createRemoteConsoleRuntime: () => runtime }));
    initRemoteConsole(fakeOps());
    expect(call('remote.status').result).toBe(status);
  });
});

describe('initRemoteConsole', () => {
  it('returns null and logs remote-console-missing when ./runtime is not there', () => {
    // No loader injected: this is the real `require('./runtime')`, which does
    // not exist in P0. After P1 merges, vitest still cannot require a .ts file
    // natively, so this path stays MODULE_NOT_FOUND under test.
    const ops = fakeOps();
    expect(initRemoteConsole(ops)).toBe(null);
    expect(ops.log).toHaveBeenCalledWith('remote-console-missing', {});
    expect(getRemoteConsole()).toBe(null);
  });

  it('logs a different line when the runtime is present but fails to load', () => {
    const ops = fakeOps();
    __resetRemoteConsoleForTests(() => { throw Object.assign(new Error("Cannot find module 'ws'"), { code: 'MODULE_NOT_FOUND' }); });
    expect(initRemoteConsole(ops)).toBe(null);
    expect(ops.log).toHaveBeenCalledWith('remote-console-load-failed', { message: "Cannot find module 'ws'" });
  });

  it('returns null when the factory throws', () => {
    const ops = fakeOps();
    __resetRemoteConsoleForTests(() => ({ createRemoteConsoleRuntime: () => { throw new Error('bad'); } }));
    expect(initRemoteConsole(ops)).toBe(null);
    expect(ops.log).toHaveBeenCalledWith('remote-console-load-failed', { message: 'bad' });
  });

  it('creates once and returns the same runtime after', () => {
    const create = vi.fn(() => ({}) as RemoteConsoleRuntime);
    __resetRemoteConsoleForTests(() => ({ createRemoteConsoleRuntime: create }));
    const ops = fakeOps();
    const a = initRemoteConsole(ops);
    const b = initRemoteConsole(ops);
    expect(a).not.toBe(null);
    expect(b).toBe(a);
    expect(getRemoteConsole()).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

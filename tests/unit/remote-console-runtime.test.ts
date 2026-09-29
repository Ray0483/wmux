/**
 * ConsoleRuntime end to end over real sockets with fake ops (#254). Never
 * launches Electron: the "renderer" is a function answering snapshot/modes
 * requests the way remote-snapshot.ts (P3) will.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { ConsoleRuntime, CONFIG_FILE, createRemoteConsoleRuntime, DEVICES_FILE, pairingBase, REJECTED_ORIGIN_TTL_MS } from '../../src/main/remote-console/runtime';
import type { ConsoleOps } from '../../src/main/remote-console/contract';
import type { ConsoleServer } from '../../src/main/remote-console/server';
import { remoteTaps, resetRemoteTaps } from '../../src/main/remote-console/taps';
import { __resetRemoteConsoleForTests, getRemoteConsole, initRemoteConsole } from '../../src/main/remote-console';
import type { RemoteRendererRequest } from '../../src/shared/remote-console-config';
import type { ServerMessage } from '../../src/shared/remote-console-protocol';
import { WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL } from '../../src/shared/remote-console-protocol';

/** cookie → page key, as the phone keeps it (devices.ts). */
const pageKeys = new Map<string, string>();

const S = 'surf-00000001-0000-4000-8000-000000000000';

let dir: string;
let staticRoot: string;
let runtimes: ConsoleRuntime[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

type FakeOps = ConsoleOps & {
  notifyDesktop: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  noteHumanInput: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  listRoster: ReturnType<typeof vi.fn>;
};

function fakeOps(over: Partial<ConsoleOps> = {}): FakeOps {
  return {
    listRoster: vi.fn(async () => [[{
      surfaceId: S, workspaceId: 'ws-1', workspaceTitle: 'Work', label: 'claude', kind: 'claude',
      state: 'working', stateSource: 'declared', blockedReason: null, choices: [], answerPending: false, dwellMs: 0,
    }]]),
    isLivePty: () => true,
    isBlocked: () => false,
    runDepth: () => 0,
    promptId: () => null,
    isAnsweringInput: () => false,
    noteHumanInput: vi.fn(),
    write: vi.fn(),
    deliverAnswer: async () => ({ ok: true as const }),
    notifyDesktop: vi.fn(),
    lanAddresses: () => [],
    hostname: () => 'DESKTOP-‮TEST',
    log: vi.fn(),
    appDataDir: () => dir,
    staticRoot: () => staticRoot,
    ...over,
  } as FakeOps;
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(cfg));
}

function make(ops: ConsoleOps, timings = {}): ConsoleRuntime {
  const rt = new ConsoleRuntime(ops, { pumpMs: 50, coalesceMs: 10, modesTimeoutMs: 100, ...timings });
  runtimes.push(rt);
  return rt;
}

function httpServerOf(rt: ConsoleRuntime): http.Server {
  return (rt as unknown as { server: ConsoleServer }).server.httpServer;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rc-rt-'));
  staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rc-rt-static-'));
  fs.mkdirSync(path.join(staticRoot, 'remote'));
  fs.writeFileSync(path.join(staticRoot, 'remote', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(staticRoot, 'remote-manifest.json'), JSON.stringify({ 'remote/index.html': { file: 'assets/r.js' } }));
});

afterEach(() => {
  for (const rt of runtimes) rt.stopNow();
  runtimes = [];
  resetRemoteTaps();
  __resetRemoteConsoleForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(staticRoot, { recursive: true, force: true });
});

async function enabledRuntime(ops = fakeOps(), cfg: Record<string, unknown> = {}): Promise<{ rt: ConsoleRuntime; port: number; ops: FakeOps }> {
  const port = await freePort();
  writeConfig({ enabled: true, port, ...cfg });
  const rt = make(ops);
  await rt.start();
  return { rt, port, ops: ops as FakeOps };
}

function post(port: number, url: string, body: unknown): Promise<{ status: number; cookie: string; body: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: url,
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'Content-Length': Buffer.byteLength(text) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? ''), body: data }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function pairViaHttp(rt: ConsoleRuntime, port: number, scope: 'viewer' | 'operator' = 'operator'): Promise<string> {
  const offer = rt.pairStart({ name: 'Phone', scope });
  if ('error' in offer) throw new Error(offer.error);
  const secret = offer.url.split('#pair=')[1];
  const res = await post(port, '/api/pair', { secret, name: 'Pixel' });
  expect(res.status).toBe(200);
  const cookie = /wmux_rc=([^;]+)/.exec(res.cookie)?.[1] as string;
  pageKeys.set(cookie, (JSON.parse(res.body) as { key: string }).key);
  return cookie;
}

interface Phone { ws: WebSocket; inbox: ServerMessage[]; next(t: string): Promise<ServerMessage> }

function openPhone(port: number, cookie: string): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_SUBPROTOCOL, WS_KEY_PROTOCOL_PREFIX + (pageKeys.get(cookie) ?? '')], { origin: `http://127.0.0.1:${port}`, headers: { Cookie: `wmux_rc=${cookie}` } });
    const inbox: ServerMessage[] = [];
    const waiters: { t: string; resolve: (m: ServerMessage) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    const next = (t: string): Promise<ServerMessage> => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((r) => waiters.push({ t, resolve: r }));
    };
    ws.on('open', () => resolve({ ws, inbox, next }));
    ws.on('error', reject);
  });
}

describe('ConsoleRuntime lifecycle (#254)', () => {
  it('off by default: start() is a no-op and v2Status is the disabled shape', async () => {
    const rt = make(fakeOps());
    await rt.start();
    expect(rt.getStatus().running).toBe(false);
    expect(rt.v2Status()).toEqual({
      enabled: false, running: false, bind: 'loopback', port: 9790, publicUrl: '', deviceCount: 0, connectedCount: 0, lastError: null,
    });
    expect(rt.pairStart({ name: 'x', scope: 'viewer' })).toEqual({ error: 'not-running' });
  });

  it('enabled: listens on loopback; start() is idempotent', async () => {
    const { rt, port } = await enabledRuntime();
    expect(rt.getStatus().listening).toEqual({ host: '127.0.0.1', port });
    await rt.start();
    expect(rt.getStatus().listening).toEqual({ host: '127.0.0.1', port });
    expect(rt.v2Status()).toMatchObject({ enabled: true, running: true, port });
  });

  it('a corrupt config loads as the default and is logged', async () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE), '{nope');
    const ops = fakeOps();
    const rt = make(ops);
    await rt.start();
    expect(rt.getStatus().running).toBe(false);
    expect(ops.log).toHaveBeenCalledWith('remote-console-config-corrupt', expect.any(Object));
  });

  it('LAN host no longer on the machine: lan-address-gone, nothing listens, config kept', async () => {
    const port = await freePort();
    writeConfig({ enabled: true, port, bind: 'lan', lanHost: '192.0.2.7' });
    const rt = make(fakeOps({ lanAddresses: () => ['192.0.2.8'] }));
    await rt.start();
    const st = rt.getStatus();
    expect(st.running).toBe(false);
    expect(st.lastError).toBe('lan-address-gone');
    expect(st.config.lanHost).toBe('192.0.2.7');
  });

  it('a busy port is port-busy', async () => {
    const blocker = net.createServer();
    const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
    try {
      writeConfig({ enabled: true, port });
      const rt = make(fakeOps());
      await rt.start();
      expect(rt.getStatus().lastError).toBe('port-busy');
      expect(rt.getStatus().running).toBe(false);
    } finally {
      blocker.close();
    }
  });

  it('no manifest: still listening, lastError ui-not-built', async () => {
    fs.rmSync(path.join(staticRoot, 'remote-manifest.json'));
    const { rt } = await enabledRuntime();
    expect(rt.getStatus().running).toBe(true);
    expect(rt.getStatus().lastError).toBe('ui-not-built');
  });

  it('setConfig validates against live LAN addresses, persists, and reconfigures', async () => {
    const rt = make(fakeOps({ lanAddresses: () => ['192.0.2.8'] }));
    await rt.start();
    expect(await rt.setConfig({ enabled: true, bind: 'lan', lanHost: '192.0.2.9' })).toEqual({ ok: false, error: 'bad-lan-host' });
    const port = await freePort();
    const statuses: boolean[] = [];
    rt.onStatus((s) => statuses.push(s.running));
    expect(await rt.setConfig({ enabled: true, port })).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'))).toMatchObject({ enabled: true, port });
    expect(rt.getStatus().listening?.port).toBe(port);
    expect(statuses.at(-1)).toBe(true);
    expect(await rt.setConfig({ enabled: false, port })).toEqual({ ok: true });
    expect(rt.getStatus().running).toBe(false);
  });

  it('stopNow is synchronous: nothing listening on return, sockets gone, taps reset', async () => {
    const { rt, port } = await enabledRuntime();
    const cookie = await pairViaHttp(rt, port);
    const phone = await openPhone(port, cookie);
    const closed = new Promise<number>((r) => phone.ws.on('close', (c) => r(c)));
    const srv = httpServerOf(rt);
    const deliverBefore = remoteTaps.deliver;
    rt.stopNow();
    expect(srv.listening).toBe(false);
    expect(rt.getStatus().running).toBe(false);
    expect(remoteTaps.deliver).not.toBe(deliverBefore);
    await new Promise((r) => setImmediate(r));
    expect(srv.listening).toBe(false);
    expect(await closed).toBe(1006);
  });

  it('stopNow while a start is queued or awaiting listen(): nothing is left listening afterwards', async () => {
    const port = await freePort();
    writeConfig({ enabled: true, port });
    const rt = make(fakeOps());
    const pending = rt.start();
    rt.stopNow();
    await pending;
    expect(rt.getStatus().running).toBe(false);
    // The port is free: a start that outlived stopNow would still hold it.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
    // A start requested AFTER stopNow is a fresh request and works.
    await rt.start();
    expect(rt.getStatus().running).toBe(true);
  });

  it('stop() is graceful (1001) and leaves bindSurface installed for a later start', async () => {
    const { rt, port } = await enabledRuntime();
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    const closed = new Promise<number>((r) => phone.ws.on('close', (c) => r(c)));
    await rt.stop();
    expect(await closed).toBe(1001);
    const sender = vi.fn(() => true);
    rt.setRendererSender(sender);
    remoteTaps.bindSurface(S, {} as never);
    expect((rt as unknown as { wcBySurface: Map<string, unknown> }).wcBySurface.has(S)).toBe(true);
  });
});

describe('ConsoleRuntime pairing and devices', () => {
  it('pairStart gives a fragment URL; pairing notifies the desktop; disk holds no token', async () => {
    const { rt, port, ops } = await enabledRuntime();
    const offer = rt.pairStart({ name: 'Phone', scope: 'viewer' });
    if ('error' in offer) throw new Error(offer.error);
    expect(offer.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[A-Za-z0-9_-]{43}$`));
    expect(rt.getStatus().pairing).toEqual({ expiresAt: offer.expiresAt, scope: 'viewer' });
    const secret = offer.url.split('#pair=')[1];
    const res = await post(port, '/api/pair', { secret, name: 'Pixel' });
    expect(res.status).toBe(200);
    const token = /wmux_rc=[^.]+\.([^;]+)/.exec(res.cookie)?.[1] as string;
    // Facts, not an English sentence: the renderer words it in the UI language.
    expect(ops.notifyDesktop).toHaveBeenCalledWith({ kind: 'paired', name: 'Pixel', scope: 'viewer' });
    const disk = fs.readFileSync(path.join(dir, DEVICES_FILE), 'utf8');
    expect(disk).not.toContain(token);
    expect(disk).not.toContain(secret);
    expect(rt.getStatus().devices.map((d) => d.name)).toEqual(['Pixel']);
  });

  it('a LAN bind pairs to the LAN address, never a Public URL that proxies to 127.0.0.1 (#254)', async () => {
    const port = await freePort();
    writeConfig({ enabled: true, port, bind: 'lan', lanHost: '127.0.0.1', publicUrl: 'https://box.tail1234.ts.net' });
    const rt = make(fakeOps({ lanAddresses: () => ['127.0.0.1'] }));
    await rt.start();
    const offer = rt.pairStart({ name: 'Phone', scope: 'viewer' });
    if ('error' in offer) throw new Error(offer.error);
    expect(offer.url.startsWith(`http://127.0.0.1:${port}/#pair=`)).toBe(true);
  });

  it('pairingBase: the Public URL only on loopback', () => {
    const at = { host: '127.0.0.1', port: 9788 };
    const listener = (base: string) => new URL(base).host;
    expect(pairingBase({ bind: 'loopback', publicUrl: 'https://pc.ts.net' }, at)).toBe('https://pc.ts.net');
    expect(listener(pairingBase({ bind: 'loopback', publicUrl: '' }, at))).toBe('127.0.0.1:9788');
    expect(listener(pairingBase({ bind: 'lan', publicUrl: 'https://pc.ts.net' }, at))).toBe('127.0.0.1:9788');
  });

  it('the refused-origin suggestion can be dismissed, clears on reconfigure, and ages out', async () => {
    const { rt, port } = await enabledRuntime();
    const refuse = (host = 'my-pc.tailnet.ts.net') => new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      req.end();
    });
    await refuse();
    expect(rt.getStatus().lastRejectedOrigin).not.toBeNull();
    rt.dismissRejectedOrigin();
    expect(rt.getStatus().lastRejectedOrigin).toBeNull();
    // Dismissed until ANOTHER origin is refused: the phone reloading the same
    // URL does not bring the card back (#254).
    await refuse();
    expect(rt.getStatus().lastRejectedOrigin).toBeNull();
    await refuse('other-pc.tailnet.ts.net');
    expect(rt.getStatus().lastRejectedOrigin).toBe('https://other-pc.tailnet.ts.net');
    await rt.reconfigure();
    expect(rt.getStatus().lastRejectedOrigin).toBeNull();
    await refuse();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + REJECTED_ORIGIN_TTL_MS + 1000;
      expect(rt.getStatus().lastRejectedOrigin).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('the refused-origin card ageing out is PUSHED to an open Settings, not left until an unrelated change', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const rt = make(fakeOps());
      const seen: (string | null)[] = [];
      rt.onStatus((s) => seen.push(s.lastRejectedOrigin));
      (rt as unknown as { onRejectedOrigin(v: string): void }).onRejectedOrigin('https://pc.tailnet.ts.net');
      expect(seen.at(-1)).toBe('https://pc.tailnet.ts.net');
      vi.advanceTimersByTime(REJECTED_ORIGIN_TTL_MS + 1000);
      expect(seen.at(-1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('five wrong guesses void the offer AND tell Settings, so its QR goes (#254)', async () => {
    const { rt, port } = await enabledRuntime();
    const statuses: (unknown | null)[] = [];
    rt.onStatus((s) => statuses.push(s.pairing));
    const offer = rt.pairStart({ name: 'Phone', scope: 'viewer' });
    if ('error' in offer) throw new Error(offer.error);
    for (let i = 0; i < 5; i++) expect((await post(port, '/api/pair', { secret: `wrong-${i}` })).status).toBe(410);
    expect(rt.getStatus().pairing).toBeNull();
    expect(statuses.at(-1)).toBeNull();
  });

  it('pairing again from a paired browser replaces its record, key minted and required (#254)', async () => {
    const { rt, port } = await enabledRuntime();
    const first = await pairViaHttp(rt, port, 'viewer');
    const offer = rt.pairStart({ name: 'Phone', scope: 'operator' });
    if ('error' in offer) throw new Error(offer.error);
    const text = JSON.stringify({ secret: offer.url.split('#pair=')[1] });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/pair',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, Cookie: `wmux_rc=${first}`, 'Content-Length': Buffer.byteLength(text) },
      }, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end(text);
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const devices = rt.getStatus().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ scope: 'operator' });
    expect(devices[0].id).not.toBe(first.split('.')[0]);
  });

  it('publicUrl is the pairing base when set', async () => {
    const { rt } = await enabledRuntime(fakeOps(), { publicUrl: 'https://box.tail1234.ts.net' });
    const offer = rt.pairStart({ name: 'Phone', scope: 'operator' });
    expect('url' in offer && offer.url.startsWith('https://box.tail1234.ts.net/#pair=')).toBe(true);
    expect(rt.pairStart({ name: 'x', scope: 'root' as never })).toEqual({ error: 'bad-scope' });
  });

  it('v2Status and getStatus carry no secret, token or hash', async () => {
    const { rt, port } = await enabledRuntime();
    await pairViaHttp(rt, port);
    rt.pairStart({ name: 'Phone', scope: 'viewer' });
    const v2 = JSON.stringify(rt.v2Status()).toLowerCase();
    for (const w of ['token', 'hash', 'secret', 'cookie', 'pixel', 'dev-']) expect(v2).not.toContain(w);
    expect(rt.v2Status().deviceCount).toBe(1);
    const st = JSON.stringify(rt.getStatus()).toLowerCase();
    for (const w of ['token', 'hash', 'secret', '#pair']) expect(st).not.toContain(w);
  });

  it('revoke closes the phone with 4401; rename and revokeAll update status', async () => {
    const { rt, port } = await enabledRuntime();
    const cookie = await pairViaHttp(rt, port);
    const phone = await openPhone(port, cookie);
    const closed = new Promise<number>((r) => phone.ws.on('close', (c) => r(c)));
    const id = cookie.split('.')[0];
    rt.rename(id, 'Work phone');
    expect(rt.getStatus().devices[0].name).toBe('Work phone');
    rt.revoke(id);
    expect(await closed).toBe(4401);
    expect(phone.inbox.some((m) => m.t === 'revoked')).toBe(true);
    await pairViaHttp(rt, port);
    rt.revokeAll();
    expect(rt.getStatus().devices).toEqual([]);
  });
});

describe('ConsoleRuntime sessions, roster, terminal', () => {
  it('hello → welcome (host sanitised), roster pushed, first connect notifies once', async () => {
    const { rt, port, ops } = await enabledRuntime();
    const cookie = await pairViaHttp(rt, port);
    const phone = await openPhone(port, cookie);
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    const welcome = await phone.next('welcome');
    expect(welcome).toMatchObject({ t: 'welcome', effectiveScope: 'operator', host: 'DESKTOP-TEST', limits: { maxText: 16384 } });
    const agents = await phone.next('agents');
    expect(agents).toMatchObject({ t: 'agents', list: [{ s: S, state: 'working', label: 'claude' }] });
    expect(ops.notifyDesktop).toHaveBeenCalledWith({ kind: 'connected', name: 'Pixel', scope: 'operator' });
    const second = await openPhone(port, cookie);
    second.ws.close();
    expect(ops.notifyDesktop.mock.calls.filter((c) => c[0].kind === 'connected')).toHaveLength(1);
    expect(rt.getStatus().connected[0].deviceId).toBe(cookie.split('.')[0]);
  });

  it('a roster poll that never settles is given up on, so the pump keeps polling (#254)', async () => {
    let calls = 0;
    const roster = [[{
      surfaceId: S, workspaceId: 'ws-1', workspaceTitle: 'Work', label: 'claude', kind: null,
      state: 'working', stateSource: 'declared', blockedReason: null, choices: [], answerPending: false, dwellMs: 0,
    }]];
    const ops = fakeOps({
      // The first poll is a hung window: executeJavaScript that never answers.
      listRoster: vi.fn(() => (++calls === 1 ? new Promise<unknown[][]>(() => undefined) : Promise.resolve(roster))) as never,
    });
    const port = await freePort();
    writeConfig({ enabled: true, port });
    const rt = make(ops, { rosterTimeoutMs: 60 });
    await rt.start();
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('welcome');
    // Nothing polled yet at hello: no roster is sent then (an empty one would
    // read as "No agents are running"); the first frame is the pumped one.
    const agents = await phone.next('agents');
    expect(agents).toMatchObject({ list: [{ s: S, state: 'working' }] });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(ops.log).toHaveBeenCalledWith('remote-roster-timeout', { ms: 60 });
  });

  it('a blocked card carries the prompt id only while the renderer copy is the question main holds (#254)', async () => {
    const card = (reason: string) => [[{
      surfaceId: S, workspaceId: 'ws-1', workspaceTitle: 'Work', label: 'claude', kind: null,
      state: 'blocked', stateSource: 'declared', blockedReason: reason,
      choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], answerPending: false, dwellMs: 0,
    }]];
    let rendererReason = 'Run tests?';
    const mainReason = 'Drop prod table?';
    const ops = fakeOps({
      listRoster: vi.fn(async () => card(rendererReason)) as never,
      promptId: () => 42,
      promptView: () => ({ reason: mainReason, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }),
    });
    const { rt, port } = await enabledRuntime(ops);
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    const stale = await phone.next('agents');
    expect(stale).toMatchObject({ list: [{ blockedReason: 'Run tests?', promptId: null, choices: [] }] });
    rendererReason = mainReason;
    rt.notifyAgentStateChanged();
    expect(await phone.next('agents')).toMatchObject({ list: [{ blockedReason: 'Drop prod table?', promptId: 42 }] });
  });

  it('agents are sent only on change; a working → idle edge marks Done', async () => {
    let state = 'working';
    const ops = fakeOps({
      listRoster: vi.fn(async () => [[{
        surfaceId: S, workspaceId: 'ws-1', workspaceTitle: 'Work', label: 'claude', kind: null,
        state, stateSource: 'declared', blockedReason: null, choices: [], answerPending: false, dwellMs: 0,
      }]]) as never,
    });
    const { rt, port } = await enabledRuntime(ops);
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('agents');
    await new Promise((r) => setTimeout(r, 150));
    expect(phone.inbox.filter((m) => m.t === 'agents')).toHaveLength(0);
    state = 'idle';
    rt.notifyAgentStateChanged();
    const changed = await phone.next('agents');
    expect(changed).toMatchObject({ list: [{ s: S, state: 'idle', done: true }] });
    phone.ws.send(JSON.stringify({ t: 'seen', s: S }));
    expect(await phone.next('agents')).toMatchObject({ list: [{ done: false }] });
  });

  it('attach → snapshot from the bound webContents → term.reset, then the tap streams', async () => {
    const { rt, port } = await enabledRuntime();
    const wc = { id: 7 } as never;
    const requests: RemoteRendererRequest[] = [];
    rt.setRendererSender((target, req) => {
      expect(target).toBe(wc);
      requests.push(req);
      if (req.kind === 'snapshot') setImmediate(() => rt.handleRendererReply(req.reqId, { data: 'SCREEN', cols: 100, rows: 30 }));
      return true;
    });
    remoteTaps.bindSurface(S, wc);
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('welcome');
    phone.ws.send(JSON.stringify({ t: 'attach', s: S }));
    expect(await phone.next('term.reset')).toEqual({ t: 'term.reset', s: S, cols: 100, rows: 30, data: 'SCREEN' });
    remoteTaps.deliver(S, 'live bytes');
    expect(await phone.next('term.data')).toEqual({ t: 'term.data', s: S, data: 'live bytes' });
    remoteTaps.exit(S, 0);
    expect(await phone.next('term.exit')).toEqual({ t: 'term.exit', s: S, code: 0 });
    expect(requests[0]).toMatchObject({ kind: 'snapshot', surfaceId: S });
  });

  it('an operator send reaches noteHumanInput then write, using the DESKTOP bracketed mode', async () => {
    const { rt, port, ops } = await enabledRuntime();
    rt.setRendererSender((_wc, req) => {
      if (req.kind === 'modes') setImmediate(() => rt.handleRendererReply(req.reqId, { bracketedPaste: false }));
      return true;
    });
    remoteTaps.bindSurface(S, {} as never);
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('welcome');
    phone.ws.send(JSON.stringify({ t: 'send', s: S, nonce: 'nonce-0001', text: 'ls', submit: true }));
    expect(await phone.next('ack')).toEqual({ t: 'ack', nonce: 'nonce-0001', ok: true });
    expect(ops.write.mock.calls).toEqual([[S, 'ls'], [S, '\r']]);
    expect(ops.noteHumanInput.mock.calls).toEqual([[S, 'ls'], [S, '\r']]);
  });

  it('a revoke during a send\'s modes round trip: the send never writes', async () => {
    const { rt, port, ops } = await enabledRuntime();
    const modesReqs: RemoteRendererRequest[] = [];
    rt.setRendererSender((_wc, req) => {
      if (req.kind === 'modes') modesReqs.push(req); // answered by hand below
      return true;
    });
    remoteTaps.bindSurface(S, {} as never);
    const cookie = await pairViaHttp(rt, port);
    const phone = await openPhone(port, cookie);
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('welcome');
    phone.ws.send(JSON.stringify({ t: 'send', s: S, nonce: 'nonce-0003', text: 'rm -rf build', submit: true }));
    for (let i = 0; i < 200 && modesReqs.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(modesReqs).toHaveLength(1);
    rt.revoke(cookie.split('.')[0]);
    rt.handleRendererReply(modesReqs[0].reqId, { bracketedPaste: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(ops.noteHumanInput).not.toHaveBeenCalled();
    expect(ops.write).not.toHaveBeenCalled();
  });

  it('a viewer on the wire can never cause a write', async () => {
    const { rt, port, ops } = await enabledRuntime();
    const phone = await openPhone(port, await pairViaHttp(rt, port, 'viewer'));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('welcome');
    phone.ws.send(JSON.stringify({ t: 'key', s: S, nonce: 'nonce-0002', key: 'enter', force: ['blocked'] }));
    expect(await phone.next('ack')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(ops.write).not.toHaveBeenCalled();
    expect(ops.noteHumanInput).not.toHaveBeenCalled();
  });

  it('modes: no bound terminal is no-terminal; a renderer that never answers times out to false', async () => {
    const rt = make(fakeOps(), { modesTimeoutMs: 30 });
    expect(await rt.queryModes(S)).toEqual({ error: 'no-terminal' });
    rt.setRendererSender(() => true);
    remoteTaps.bindSurface(S, {} as never);
    expect(await rt.queryModes(S)).toEqual({ bracketedPaste: false });
    rt.handleRendererReply('unknown-req', { bracketedPaste: true });
  });

  it('desktop input clears Done for every device', async () => {
    let state = 'working';
    const ops = fakeOps({
      listRoster: vi.fn(async () => [[{
        surfaceId: S, workspaceId: 'ws-1', workspaceTitle: 'Work', label: 'claude', kind: null,
        state, stateSource: 'declared', blockedReason: null, choices: [], answerPending: false, dwellMs: 0,
      }]]) as never,
    });
    const { rt, port } = await enabledRuntime(ops);
    const phone = await openPhone(port, await pairViaHttp(rt, port));
    phone.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    await phone.next('agents');
    state = 'idle';
    rt.notifyAgentStateChanged();
    expect(await phone.next('agents')).toMatchObject({ list: [{ done: true }] });
    remoteTaps.noteDesktopInput(S);
    expect(await phone.next('agents')).toMatchObject({ list: [{ done: false }] });
  });
});

describe('facade integration', () => {
  it('initRemoteConsole(fakeOps) returns a runtime', async () => {
    const m = await import('../../src/main/remote-console/runtime');
    __resetRemoteConsoleForTests(() => m);
    const rt = initRemoteConsole(fakeOps());
    expect(rt).toBeInstanceOf(ConsoleRuntime);
    expect(getRemoteConsole()).toBe(rt);
    runtimes.push(rt as ConsoleRuntime);
    expect(typeof createRemoteConsoleRuntime).toBe('function');
  });
});

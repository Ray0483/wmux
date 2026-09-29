/**
 * Remote Console server over real sockets (#254, spec §13 P1): port 0, fake
 * ops, a temp static root and a synthetic remote-manifest.json. Never launches
 * Electron.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { DeviceRegistry } from '../../src/main/remote-console/devices';
import { createConsoleServer, MAX_CONNECTIONS } from '../../src/main/remote-console/server';
import type { ConsoleClient, ConsoleServer } from '../../src/main/remote-console/server';
import { loadAllowedAssets } from '../../src/main/remote-console/static-assets';
import type { RemoteConsoleConfig } from '../../src/shared/remote-console-config';
import { CLOSE_CODES } from '../../src/shared/remote-console-protocol';
import type { RemoteScope } from '../../src/shared/remote-console-protocol';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rc-server-'));
  fs.mkdirSync(path.join(root, 'remote'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'remote', 'index.html'), '<!doctype html><script type="module" src="../assets/remote-P.js"></script>');
  fs.writeFileSync(path.join(root, 'assets', 'remote-P.js'), 'console.log("phone")');
  fs.writeFileSync(path.join(root, 'assets', 'index-D.js'), 'console.log("desktop")');
  fs.writeFileSync(path.join(root, 'remote-manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/index-D.js', isEntry: true },
    'remote/index.html': { file: 'assets/remote-P.js', isEntry: true },
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Rig {
  server: ConsoleServer;
  devices: DeviceRegistry;
  port: number;
  clients: ConsoleClient[];
  rejected: string[];
  uiNotBuilt: number;
  origin: string;
  host: string;
  config: RemoteConsoleConfig;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.server.close();
});

async function rig(opts: { config?: Partial<RemoteConsoleConfig>; staticRoot?: string } = {}): Promise<Rig> {
  const config: RemoteConsoleConfig = {
    enabled: true, bind: 'loopback', lanHost: null, port: 0, publicUrl: '', allowInsecureControl: false, ...opts.config,
  };
  const devices = new DeviceRegistry({
    load: () => null,
    save: () => undefined,
    now: () => Date.now(),
    randomBytes: (n) => crypto.randomBytes(n),
    sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
  });
  const assets = loadAllowedAssets(opts.staticRoot ?? root);
  const r = {} as Rig;
  r.clients = [];
  r.rejected = [];
  r.uiNotBuilt = 0;
  r.config = config;
  r.devices = devices;
  r.server = createConsoleServer({
    config: () => config,
    devices,
    assets: () => assets,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log: () => undefined,
    onConnection: (c) => {
      r.clients.push(c);
      return {
        onMessage: (text) => c.send({ t: 'error', code: 'bad-frame', message: `echo:${text.length}` }),
        onClose: () => undefined,
      };
    },
    onPaired: () => undefined,
    onRejectedOrigin: (v) => r.rejected.push(v),
    onUiNotBuilt: () => { r.uiNotBuilt++; },
  });
  devices.onRevoked((ids) => r.server.closeDevices(ids, CLOSE_CODES.REVOKED, { t: 'revoked' }));
  const res = await r.server.listen('127.0.0.1', 0);
  if (!res.ok) throw new Error(res.error);
  r.port = res.port;
  r.host = `127.0.0.1:${res.port}`;
  r.origin = `http://127.0.0.1:${res.port}`;
  rigs.push(r);
  return r;
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(r: Rig, method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.port, method, path: url, headers: { Host: r.host, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function pairDevice(r: Rig, scope: RemoteScope = 'operator'): string {
  const offer = r.devices.mintPairing({ scope, name: 'Phone' });
  if ('error' in offer) throw new Error(offer.error);
  const res = r.devices.consumePairing(offer.secret, 'Phone');
  if (!res.ok) throw new Error(res.reason);
  return `${res.device.id}.${res.token}`;
}

function connect(r: Rig, headers: { origin?: string | null; cookie?: string; host?: string; path?: string } = {}): Promise<{ ws: WebSocket; status: number | 'open' }> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: headers.host ?? r.host };
    if (headers.cookie) h.Cookie = `wmux_rc=${headers.cookie}`;
    const origin = headers.origin === undefined ? r.origin : headers.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}${headers.path ?? '/ws'}`, { headers: h, ...(origin ? { origin } : {}) });
    ws.on('open', () => resolve({ ws, status: 'open' }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
    ws.on('error', () => resolve({ ws, status: -1 }));
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

describe('remote-console server: upgrade gate (#254)', () => {
  it('refuses no cookie (401), bad Origin (403), null Origin (403), bad Host (403), wrong path', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    expect((await connect(r)).status).toBe(401);
    expect((await connect(r, { cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await connect(r, { cookie, origin: null })).status).toBe(403);
    expect((await connect(r, { cookie, host: `evil.example:${r.port}` })).status).toBe(403);
    expect((await connect(r, { cookie, path: '/nope' })).status).toBe(404);
    expect(r.rejected).toContain('http://evil.example');
    expect(r.clients).toHaveLength(0);
  });

  it('accepts a paired device and relays text frames', async () => {
    const r = await rig();
    const { ws, status } = await connect(r, { cookie: pairDevice(r) });
    expect(status).toBe('open');
    const msg = new Promise<string>((resolve) => ws.once('message', (d) => resolve(String(d))));
    ws.send('hello');
    expect(JSON.parse(await msg)).toEqual({ t: 'error', code: 'bad-frame', message: 'echo:5' });
    ws.close();
  });

  it('caps at 2 per device and 8 in total (the 9th is refused)', async () => {
    const r = await rig();
    const a = pairDevice(r);
    expect((await connect(r, { cookie: a })).status).toBe('open');
    expect((await connect(r, { cookie: a })).status).toBe('open');
    expect((await connect(r, { cookie: a })).status).toBe(403);
    for (let i = 0; i < 3; i++) {
      const c = pairDevice(r);
      expect((await connect(r, { cookie: c })).status).toBe('open');
      expect((await connect(r, { cookie: c })).status).toBe('open');
    }
    expect(r.clients).toHaveLength(MAX_CONNECTIONS);
    expect((await connect(r, { cookie: pairDevice(r) })).status).toBe(403);
  });

  it('revoke closes the device\'s sockets with 4401 after a revoked frame', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    const { ws } = await connect(r, { cookie });
    const frames: string[] = [];
    ws.on('message', (d) => frames.push(String(d)));
    const closed = closeCode(ws);
    r.devices.revoke(cookie.split('.')[0]);
    expect(await closed).toBe(CLOSE_CODES.REVOKED);
    expect(frames).toContain('{"t":"revoked"}');
    expect((await connect(r, { cookie })).status).toBe(401);
  });

  it('LAN bind without the override: an operator device is an effective viewer', async () => {
    const r = await rig({ config: { bind: 'lan', lanHost: '127.0.0.1' } });
    const cookie = pairDevice(r, 'operator');
    await connect(r, { cookie });
    expect(r.clients[0].effectiveScope).toBe('viewer');
    const s = await request(r, 'GET', '/api/session', { Cookie: `wmux_rc=${cookie}` });
    expect(JSON.parse(s.body)).toEqual({ paired: true, scope: 'operator', effectiveScope: 'viewer' });
  });

  it('LAN bind WITH the override keeps operator', async () => {
    const r = await rig({ config: { bind: 'lan', lanHost: '127.0.0.1', allowInsecureControl: true } });
    await connect(r, { cookie: pairDevice(r, 'operator') });
    expect(r.clients[0].effectiveScope).toBe('operator');
  });
});

describe('remote-console server: HTTP', () => {
  it('OPTIONS is 405 with no CORS header', async () => {
    const r = await rig();
    const res = await request(r, 'OPTIONS', '/api/pair', { Origin: r.origin, 'Access-Control-Request-Method': 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const res2 = await request(r, 'OPTIONS', '/');
    expect(res2.status).toBe(405);
  });

  it('traversal is 404, and so is anything outside the manifest closure', async () => {
    const r = await rig();
    expect((await request(r, 'GET', '/../../etc/passwd')).status).toBe(404);
    expect((await request(r, 'GET', '/assets/%2e%2e/remote-manifest.json')).status).toBe(404);
    expect((await request(r, 'GET', '/assets/index-D.js')).status).toBe(404);
    expect((await request(r, 'GET', '/remote-manifest.json')).status).toBe(404);
  });

  it('serves / and the phone assets with security headers and the right caching', async () => {
    const r = await rig();
    const page = await request(r, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers.server).toBeUndefined();
    const js = await request(r, 'GET', '/assets/remote-P.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toContain('immutable');
    const head = await request(r, 'HEAD', '/assets/remote-P.js');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('a wrong Host is 403 even for static files, and is recorded', async () => {
    const r = await rig();
    const res = await request(r, 'GET', '/', { Host: 'box.tail1234.ts.net' });
    expect(res.status).toBe(403);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(r.rejected).toContain('https://box.tail1234.ts.net');
  });

  it('no manifest: 503 and ui-not-built', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rc-empty-'));
    try {
      const r = await rig({ staticRoot: empty });
      const res = await request(r, 'GET', '/');
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: 'ui-not-built' });
      expect(r.uiNotBuilt).toBe(1);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('GET /api/session: 401 unpaired, 200 with a refreshed cookie when paired', async () => {
    const r = await rig();
    expect((await request(r, 'GET', '/api/session')).status).toBe(401);
    const cookie = pairDevice(r, 'viewer');
    const res = await request(r, 'GET', '/api/session', { Cookie: `wmux_rc=${cookie}` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ paired: true, scope: 'viewer', effectiveScope: 'viewer' });
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=2592000');
  });
});

describe('remote-console server: pairing endpoints', () => {
  const json = (r: Rig, body: unknown, extra: Record<string, string> = {}): Promise<Resp> =>
    request(r, 'POST', '/api/pair', { 'Content-Type': 'application/json', Origin: r.origin, ...extra }, JSON.stringify(body));

  it('200 with an HttpOnly SameSite=Strict cookie, then 410 on reuse', async () => {
    const r = await rig();
    const offer = r.devices.mintPairing({ scope: 'operator', name: 'Phone' });
    if ('error' in offer) throw new Error();
    const res = await json(r, { secret: offer.secret, name: 'Pixel' });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^wmux_rc=dev-[0-9a-f-]+\.[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    expect(cookie).not.toContain('Secure');
    expect(JSON.parse(res.body).device).toMatchObject({ name: 'Pixel', scope: 'operator' });
    expect(res.body).not.toContain(cookie.split('.')[1].split(';')[0]);
    expect((await json(r, { secret: offer.secret })).status).toBe(410);
  });

  it('400 on a malformed body, 415 on a wrong type, 403 with no Origin, 413 when too large', async () => {
    const r = await rig();
    expect((await json(r, { secret: 'x', extra: 1 })).status).toBe(400);
    expect((await request(r, 'POST', '/api/pair', { 'Content-Type': 'application/json', Origin: r.origin }, '{bad')).status).toBe(400);
    expect((await request(r, 'POST', '/api/pair', { 'Content-Type': 'text/plain', Origin: r.origin }, '{}')).status).toBe(415);
    expect((await request(r, 'POST', '/api/pair', { 'Content-Type': 'application/json' }, '{}')).status).toBe(403);
    expect((await request(r, 'POST', '/api/pair', { 'Content-Type': 'application/json', Origin: 'null' }, '{}')).status).toBe(403);
    expect((await json(r, { secret: "x".repeat(3000) })).status).toBe(413);
  });

  it('GET on a POST route is 405', async () => {
    const r = await rig();
    expect((await request(r, 'GET', '/api/pair')).status).toBe(405);
  });

  it('logout revokes this device and clears the cookie', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    const res = await request(r, 'POST', '/api/logout', { Origin: r.origin, Cookie: `wmux_rc=${cookie}` });
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect(r.devices.count()).toBe(0);
  });
});

describe('remote-console server: binding and shutdown', () => {
  it('EADDRINUSE is port-busy, never a port walk', async () => {
    const r = await rig();
    const other = await rig();
    await other.server.close();
    const second = createConsoleServer({
      config: () => r.config,
      devices: r.devices,
      assets: () => null,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      log: () => undefined,
      onConnection: () => ({ onMessage: () => undefined, onClose: () => undefined }),
      onPaired: () => undefined,
      onRejectedOrigin: () => undefined,
      onUiNotBuilt: () => undefined,
    });
    expect(await second.listen('127.0.0.1', r.port)).toEqual({ ok: false, error: 'port-busy' });
    second.closeNow();
  });

  it('an unbindable address is bind-failed', async () => {
    const r = await rig();
    const s = createConsoleServer({
      config: () => r.config,
      devices: r.devices,
      assets: () => null,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      log: () => undefined,
      onConnection: () => ({ onMessage: () => undefined, onClose: () => undefined }),
      onPaired: () => undefined,
      onRejectedOrigin: () => undefined,
      onUiNotBuilt: () => undefined,
    });
    // TEST-NET-1 (RFC 5737) is never assigned to a local interface.
    expect(await s.listen('192.0.2.1', 0)).toEqual({ ok: false, error: 'bind-failed' });
    s.closeNow();
  });

  it('closeNow is synchronous: not listening on return, sockets terminated', async () => {
    const r = await rig();
    const { ws } = await connect(r, { cookie: pairDevice(r) });
    const closed = closeCode(ws);
    r.server.closeNow();
    expect(r.server.httpServer.listening).toBe(false);
    expect(await closed).toBe(1006);
  });

  it('graceful close sends 1001', async () => {
    const r = await rig();
    const { ws } = await connect(r, { cookie: pairDevice(r) });
    const closed = closeCode(ws);
    await r.server.close();
    expect(await closed).toBe(CLOSE_CODES.STOPPING);
  });
});

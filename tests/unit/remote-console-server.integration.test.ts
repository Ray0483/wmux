/**
 * Remote Console server over real sockets (#254, spec §13 P1): port 0, fake
 * ops, a temp static root and a synthetic remote-manifest.json. Never launches
 * Electron.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { DeviceRegistry, MAX_DEVICES } from '../../src/main/remote-console/devices';
import { createConsoleServer, HOST_REFUSED_PAGE, MAX_CONNECTIONS, MAX_PER_DEVICE } from '../../src/main/remote-console/server';
import { LIMITS } from '../../src/main/remote-console/rate-limit';
import type { ConsoleClient, ConsoleServer } from '../../src/main/remote-console/server';
import { loadAllowedAssets } from '../../src/main/remote-console/static-assets';
import type { RemoteConsoleConfig } from '../../src/shared/remote-console-config';
import { CLOSE_CODES, DEVICE_KEY_HEADER, WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL } from '../../src/shared/remote-console-protocol';
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
  messages: string[];
  rejected: string[];
  uiNotBuilt: number;
  origin: string;
  host: string;
  config: RemoteConsoleConfig;
}

const rigs: Rig[] = [];
/** cookie → the page key minted with it (the second half of the credential, devices.ts). */
const keys = new Map<string, string>();
const keyed = (cookie: string): Record<string, string> => ({ Cookie: `wmux_rc=${cookie}`, [DEVICE_KEY_HEADER]: keys.get(cookie) ?? '' });
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
  r.messages = [];
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
        onMessage: (text) => {
          r.messages.push(text);
          c.send({ t: 'error', code: 'bad-frame', message: `echo:${text.length}` });
        },
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
  const cookie = `${res.device.id}.${res.token}`;
  keys.set(cookie, res.key);
  return cookie;
}

function connect(r: Rig, headers: { origin?: string | null; cookie?: string; host?: string; path?: string; key?: string | null } = {}): Promise<{ ws: WebSocket; status: number | 'open' }> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: headers.host ?? r.host };
    if (headers.cookie) h.Cookie = `wmux_rc=${headers.cookie}`;
    const origin = headers.origin === undefined ? r.origin : headers.origin;
    const storedKey = headers.cookie ? keys.get(headers.cookie) ?? null : null;
    const key = headers.key === undefined ? storedKey : headers.key;
    const protocols = key ? [WS_SUBPROTOCOL, WS_KEY_PROTOCOL_PREFIX + key] : [WS_SUBPROTOCOL];
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}${headers.path ?? '/ws'}`, protocols, { headers: h, ...(origin ? { origin } : {}) });
    ws.on('open', () => resolve({ ws, status: 'open' }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
    ws.on('error', () => resolve({ ws, status: -1 }));
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

/** A client→server text frame, masked as RFC 6455 requires. Short payloads only. */
function maskedText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(6 + payload.length);
  out[0] = 0x81;
  out[1] = 0x80 | payload.length;
  mask.copy(out, 2);
  for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i] ^ mask[i % 4];
  return out;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 5));
  }
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
    // Refused, but never OFFERED as a Public URL: only a loopback https
    // *.ts.net refusal is (guards.ts offersAsPublicUrl).
    expect(r.rejected).not.toContain('http://evil.example');
    expect(r.rejected).toEqual([]);
    expect(r.clients).toHaveLength(0);
  });

  it('a peer boxed by junk cookies does not lock out a paired device from the same address (proxy case)', async () => {
    // Behind tailscale serve / ssh -L every phone is 127.0.0.1, as here.
    const r = await rig();
    const cookie = pairDevice(r);
    for (let i = 0; i < LIMITS.penalty.failures; i++) {
      expect((await connect(r, { cookie: 'dev-junk.token' })).status).toBe(401);
    }
    expect((await connect(r, { cookie: 'dev-junk.token' })).status).toBe(403);
    const { ws, status } = await connect(r, { cookie });
    expect(status).toBe('open');
    ws.close();
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

  it('caps at 2 per device, and the total never refuses a device under its own cap', async () => {
    expect(MAX_CONNECTIONS).toBe(MAX_DEVICES * MAX_PER_DEVICE);
    const r = await rig();
    const a = pairDevice(r);
    expect((await connect(r, { cookie: a })).status).toBe('open');
    expect((await connect(r, { cookie: a })).status).toBe('open');
    // Over the cap: accepted and closed 4409, so the page can say why.
    const third = await connect(r, { cookie: a });
    expect(third.status).toBe('open');
    expect(await closeCode(third.ws)).toBe(CLOSE_CODES.TOO_MANY);
    // Every other device that can pair gets both of its tabs: 4409 only ever
    // means "a tab on THIS device", which is what the phone tells the user.
    for (let i = 1; i < MAX_DEVICES; i++) {
      const c = pairDevice(r);
      const first = await connect(r, { cookie: c });
      expect(first.status).toBe('open');
      expect((await connect(r, { cookie: c })).status).toBe('open');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.clients).toHaveLength(MAX_CONNECTIONS);
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

  it('frames arriving after the server hung up (CLOSING) are never handed to the session', async () => {
    // A hostile peer simply never answers our close frame and keeps typing;
    // ws goes on emitting 'message' for a CLOSING socket, so a revoked phone
    // could otherwise write until the close timeout. Raw socket, because the
    // ws client answers a close by itself.
    const r = await rig();
    const cookie = pairDevice(r);
    const sock = net.connect(r.port, '127.0.0.1');
    let received = Buffer.alloc(0);
    sock.on('data', (d) => { received = Buffer.concat([received, d]); });
    sock.on('error', () => undefined);
    sock.write([
      'GET /ws HTTP/1.1', `Host: ${r.host}`, `Origin: ${r.origin}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
      `Cookie: wmux_rc=${cookie}`, `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}, ${WS_KEY_PROTOCOL_PREFIX}${keys.get(cookie)}`, '', '',
    ].join('\r\n'));
    await until(() => received.toString('latin1').includes('\r\n\r\n') && r.clients.length === 1);
    expect(received.toString('latin1')).toMatch(/^HTTP\/1\.1 101/);
    received = Buffer.alloc(0);

    sock.write(maskedText('before'));
    await until(() => r.messages.includes('before'));
    r.clients[0].close(CLOSE_CODES.REVOKED, 'revoked');
    await until(() => received.includes(0x88)); // our close frame reached the peer
    sock.write(maskedText('after'));
    await new Promise((res) => setTimeout(res, 150));
    expect(r.messages).toEqual(['before']);
    sock.destroy();
  });

  it('LAN bind without the override: an operator device is an effective viewer', async () => {
    const r = await rig({ config: { bind: 'lan', lanHost: '127.0.0.1' } });
    const cookie = pairDevice(r, 'operator');
    await connect(r, { cookie });
    expect(r.clients[0].effectiveScope).toBe('viewer');
    const s = await request(r, 'GET', '/api/session', keyed(cookie));
    expect(JSON.parse(s.body)).toEqual({ paired: true, scope: 'operator', effectiveScope: 'viewer' });
  });

  it('scope is frozen to the config the listener STARTED with (a LAN listener being replaced by loopback stays viewer)', async () => {
    const r = await rig({ config: { bind: 'lan', lanHost: '127.0.0.1' } });
    const cookie = pairDevice(r, 'operator');
    // setConfig assigns the new config before the old listener is torn down.
    r.config.bind = 'loopback';
    await connect(r, { cookie });
    expect(r.clients[0].effectiveScope).toBe('viewer');
    const s = await request(r, 'GET', '/api/session', keyed(cookie));
    expect(JSON.parse(s.body).effectiveScope).toBe('viewer');
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

  it('a refused Host gets a static page pointing at Settings, echoing nothing from the request', async () => {
    const r = await rig();
    const res = await request(r, 'GET', '/?x=<script>', { Host: 'evil<b>.tail1234.ts.net' });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe(HOST_REFUSED_PAGE);
    expect(res.body).toContain('Public URL');
    expect(res.body).not.toContain('tail1234');
    expect(res.body).not.toContain('<script>');
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
    const res = await request(r, 'GET', '/api/session', keyed(cookie));
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

  it('junk POSTs with no code on screen spend neither the per-peer box nor the global budget', async () => {
    const r = await rig();
    for (let i = 0; i < LIMITS.pairGlobal.limit + 5; i++) {
      expect((await json(r, { secret: 'junk' })).status).toBe(410);
    }
    const offer = r.devices.mintPairing({ scope: 'operator', name: 'Phone' });
    if ('error' in offer) throw new Error();
    expect((await json(r, { secret: offer.secret, name: 'Pixel' })).status).toBe(200);
  });

  it('GET on a POST route is 405', async () => {
    const r = await rig();
    expect((await request(r, 'GET', '/api/pair')).status).toBe(405);
  });

  it('logout without the page key revokes nothing: a lifted cookie cannot unpair the phone (#254)', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    const res = await request(r, 'POST', '/api/logout', { Origin: r.origin, Cookie: `wmux_rc=${cookie}` });
    expect(res.status).toBe(401);
    expect(r.devices.count()).toBe(1);
    const wrong = await request(r, 'POST', '/api/logout', { Origin: r.origin, Cookie: `wmux_rc=${cookie}`, [DEVICE_KEY_HEADER]: 'k'.repeat(43) });
    expect(wrong.status).toBe(401);
    expect(r.devices.count()).toBe(1);
  });

  it('logout revokes this device and clears the cookie', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    const res = await request(r, 'POST', '/api/logout', { Origin: r.origin, ...keyed(cookie) });
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

  it('an upgrade arriving while close() drains a slow peer is refused, and close() still finishes', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    // Peer A never answers our close frame, so close() waits its full second.
    const sock = net.connect(r.port, '127.0.0.1');
    let received = '';
    sock.on('data', (d) => { received += d.toString('latin1'); });
    sock.on('error', () => undefined);
    sock.write([
      'GET /ws HTTP/1.1', `Host: ${r.host}`, `Origin: ${r.origin}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
      `Cookie: wmux_rc=${cookie}`, `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}, ${WS_KEY_PROTOCOL_PREFIX}${keys.get(cookie)}`, '', '',
    ].join('\r\n'));
    await until(() => received.includes('\r\n\r\n') && r.clients.length === 1);

    let closed = false;
    const closing = r.server.close().then(() => { closed = true; });
    await new Promise((res) => setTimeout(res, 100));
    const b = await connect(r, { cookie });
    expect(b.status).not.toBe('open');
    expect(r.clients).toHaveLength(1);
    await Promise.race([closing, new Promise((res) => setTimeout(res, 3000))]);
    expect(closed).toBe(true);
    expect(r.server.httpServer.listening).toBe(false);
    expect(r.server.clients()).toHaveLength(0);
    sock.destroy();
  });

  it('graceful close sends 1001', async () => {
    const r = await rig();
    const { ws } = await connect(r, { cookie: pairDevice(r) });
    const closed = closeCode(ws);
    await r.server.close();
    expect(await closed).toBe(CLOSE_CODES.STOPPING);
  });
});

describe('remote-console server: review fixes, round 3 (#254)', () => {
  it('a cookie without its page key opens nothing: no socket, and /api/session says not paired', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    expect((await connect(r, { cookie, key: null })).status).toBe(401);
    expect((await connect(r, { cookie, key: 'x'.repeat(43) })).status).toBe(401);
    expect((await request(r, 'GET', '/api/session', { Cookie: `wmux_rc=${cookie}` })).status).toBe(401);
    expect((await request(r, 'GET', '/api/session', keyed(cookie))).status).toBe(200);
    const { ws, status } = await connect(r, { cookie });
    expect(status).toBe('open');
    // The server selects `wmux`, never echoing the key-bearing protocol.
    expect(ws.protocol).toBe(WS_SUBPROTOCOL);
    ws.close();
  });

  it('a request with a valid cookie does not spend the per-peer budget (the proxy case)', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    for (let i = 0; i < LIMITS.unauth.limit; i++) await request(r, 'GET', '/nope');
    expect((await request(r, 'GET', '/nope')).status).toBe(429);
    // Everyone is 127.0.0.1 here, as behind tailscale serve; the phone still gets in.
    expect((await request(r, 'GET', '/api/session', keyed(cookie))).status).toBe(200);
    expect((await request(r, 'GET', '/', { Cookie: `wmux_rc=${cookie}` })).status).toBe(200);
  });

  it('a cookie WITHOUT its page key is throttled like a stranger on the API routes (#254)', async () => {
    const r = await rig();
    const cookie = pairDevice(r);
    for (let i = 0; i < LIMITS.unauth.limit; i++) await request(r, 'GET', '/nope');
    // The lifted-cookie case: another server on this host was handed it.
    expect((await request(r, 'GET', '/api/session', { Cookie: `wmux_rc=${cookie}` })).status).toBe(429);
    expect((await request(r, 'POST', '/api/logout', { Origin: r.origin, Cookie: `wmux_rc=${cookie}` })).status).toBe(429);
    expect(r.devices.count()).toBe(1);
  });

  it('a refused address is explained in the phone\'s language, naming the desktop\'s own menus', async () => {
    const r = await rig();
    const fr = await request(r, 'GET', '/', { Host: 'box.tail1234.ts.net', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
    expect(fr.status).toBe(403);
    expect(fr.body).toContain('Paramètres → Distant');
    expect(fr.body).toContain('lang="fr"');
    expect(fr.headers.vary).toBe('Accept-Language');
    const en = await request(r, 'GET', '/', { Host: 'box.tail1234.ts.net' });
    expect(en.body).toBe(HOST_REFUSED_PAGE);
  });

  it('only a loopback https *.ts.net refusal is offered as a Public URL', async () => {
    const r = await rig();
    await request(r, 'GET', '/', { Host: `evil.example:${r.port}` });
    // A bare host reads as https, but is not a Tailscale name.
    await request(r, 'GET', '/', { Host: 'evil.example' });
    // A Tailscale-looking name on a port is a plain-http reach, not a proxy.
    await request(r, 'GET', '/', { Host: `evil.ts.net:${r.port}` });
    expect(r.rejected).toEqual([]);
    await request(r, 'GET', '/', { Host: 'box.tail1234.ts.net' });
    expect(r.rejected).toEqual(['https://box.tail1234.ts.net']);
  });

  it('an Origin is never offered as a Public URL, even a loopback https *.ts.net one (#254)', async () => {
    // Any Tailscale user owns an https *.ts.net name with a valid cert; a page
    // there, opened in the desktop browser, can reach ws://127.0.0.1:<port> and
    // POST to it. Host is then ours, and only the Origin is the attacker's.
    const r = await rig();
    const evil = 'https://evil.tail9999.ts.net';
    const cookie = pairDevice(r);
    expect((await connect(r, { cookie, origin: evil })).status).toBe(403);
    expect((await request(r, 'POST', '/api/pair', { Origin: evil, 'Content-Type': 'application/json' }, '{}')).status).toBe(403);
    expect((await request(r, 'POST', '/api/logout', { Origin: evil })).status).toBe(403);
    // A refused Host that also carries an Origin is not a top-level navigation either.
    await request(r, 'GET', '/', { Host: 'box.tail1234.ts.net', Origin: evil });
    expect(r.rejected).toEqual([]);
  });
});

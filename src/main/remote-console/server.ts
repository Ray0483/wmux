/**
 * The Remote Console's HTTP + WebSocket listener (#254, spec §7).
 *
 * A separate server on its own port, never the pipe (I1): it knows nothing of
 * the pipe token or the V2 switch, and what an authenticated socket may do is
 * decided by session.ts against the closed protocol table.
 *
 * Every request passes the same gates in the same order — Host (DNS
 * rebinding), then route, then method, then Origin for anything with an
 * effect — and a WebSocket upgrade passes a stricter version of the same
 * sequence before `handleUpgrade` is ever reached: Host, Origin, `/ws`,
 * penalty box, cookie, device still paired, connection caps. A failure there
 * is a bare status line and a destroyed socket; ws never sees the request.
 *
 * Binding is one address, never `0.0.0.0` and never a port walk (I3): the user
 * picked a port and an interface, and silently listening somewhere else would
 * make the QR code and the Settings status disagree with reality. A busy port
 * is reported as `port-busy`, not worked around.
 *
 * `closeNow()` is synchronous because `will-quit` is (spec §0.2): it
 * terminates every socket and closes the listener without awaiting anything.
 */
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { RemoteConsoleConfig } from '../../shared/remote-console-config';
import { CLOSE_CODES } from '../../shared/remote-console-protocol';
import type { RemoteScope, ServerMessage } from '../../shared/remote-console-protocol';
import type { DeviceRecord, DeviceRegistry } from './devices';
import {
  buildAllowlists,
  clearCookieHeader,
  cookieHeader,
  isAllowedHost,
  isAllowedOrigin,
  isHttpsRequest,
  readCookie,
  rejectedOriginValue,
  routeOf,
  SECURITY_HEADERS,
} from './guards';
import type { Allowlists } from './guards';
import { KeyedWindowLimiter, LIMITS, PenaltyBox, WindowCounter } from './rate-limit';
import type { AssetEntry } from './static-assets';

export const MAX_CONNECTIONS = 8;
export const MAX_PER_DEVICE = 2;
export const HEARTBEAT_MS = 20_000;
export const MAX_MISSED_PONGS = 2;
export const MAX_BODY = 2048;
export const WS_MAX_PAYLOAD = 65536;

export type ListenError = 'port-busy' | 'bind-failed';

/** One authenticated socket, as the runtime sees it. */
export interface ConsoleClient {
  readonly id: string;
  readonly device: DeviceRecord;
  readonly effectiveScope: RemoteScope;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  bufferedAmount(): number;
}

export interface ClientHandlers {
  onMessage(text: string): void;
  onClose(): void;
}

export interface ServerDeps {
  config(): RemoteConsoleConfig;
  devices: DeviceRegistry;
  /** The manifest closure built at start; null means the phone UI was not built. */
  assets(): Map<string, AssetEntry> | null;
  now(): number;
  newId(): string;
  log(event: string, fields: Record<string, unknown>): void;
  onConnection(client: ConsoleClient): ClientHandlers;
  onPaired(device: DeviceRecord): void;
  onRejectedOrigin(value: string): void;
  onUiNotBuilt(): void;
  /** Heartbeat/timer injection for tests; real timers by default. */
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(h: unknown): void;
}

interface LiveClient {
  client: ConsoleClient;
  ws: WebSocket;
  missed: number;
  handlers: ClientHandlers;
}

export interface ConsoleServer {
  listen(host: string, port: number): Promise<{ ok: true; port: number } | { ok: false; error: ListenError }>;
  /** Graceful: close every socket with `code` (default 1001) and wait briefly for them. */
  close(code?: number): Promise<void>;
  /** Synchronous teardown for will-quit. */
  closeNow(): void;
  clients(): ConsoleClient[];
  closeDevices(ids: readonly string[], code: number, msg?: ServerMessage): void;
  readonly httpServer: http.Server;
}

function writeBare(socket: Duplex, status: 401 | 403 | 404): void {
  const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status];
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // The peer may already be gone; destroying is all that is left to do.
  }
  socket.destroy();
}

function peerOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 }> {
  return new Promise((resolve) => {
    const type = (header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      resolve({ ok: false, status: 415 });
      return;
    }
    const declared = Number(header(req, 'content-length') ?? '0');
    if (declared > MAX_BODY) {
      req.resume();
      resolve({ ok: false, status: 413 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !done) {
        // Stop collecting but keep draining: destroying here would drop the
        // 413 on the floor (a chunked body has no Content-Length to refuse
        // up front). requestTimeout bounds a body that never ends, and the
        // response closes the connection.
        done = true;
        chunks.length = 0;
        resolve({ ok: false, status: 413 });
        return;
      }
      if (!done) chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, status: 400 });
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, status: 400 });
      }
    });
  });
}

/** Close with `code`, and terminate a peer that has not acknowledged within 1 s. */
function closeGracefully(e: LiveClient, code: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (e.ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      e.ws.terminate();
      resolve();
    }, 1000);
    t.unref?.();
    e.ws.once('close', () => {
      clearTimeout(t);
      resolve();
    });
    e.client.close(code, 'stopping');
  });
}

/** `listen()` on exactly one address; EADDRINUSE is `port-busy`, anything else `bind-failed`. */
function listenOn(server: http.Server, host: string, port: number): Promise<{ ok: true; port: number } | { ok: false; error: ListenError }> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      resolve({ ok: false, error: err.code === 'EADDRINUSE' ? 'port-busy' : 'bind-failed' });
    };
    const onListening = (): void => {
      server.off('error', onError);
      const addr = server.address();
      resolve({ ok: true, port: typeof addr === 'object' && addr ? addr.port : port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeListener(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export function effectiveScopeFor(cfg: RemoteConsoleConfig, device: { scope: RemoteScope }): RemoteScope {
  return cfg.bind === 'lan' && !cfg.allowInsecureControl ? 'viewer' : device.scope;
}

export function createConsoleServer(deps: ServerDeps): ConsoleServer {
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  });
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));

  const live = new Map<string, LiveClient>();
  const unauth = new KeyedWindowLimiter(LIMITS.unauth.limit, LIMITS.unauth.windowMs, deps.now);
  const penalty = new PenaltyBox(deps.now);
  const pairGlobal = new WindowCounter(LIMITS.pairGlobal.limit, LIMITS.pairGlobal.windowMs, deps.now);
  let lists: Allowlists = buildAllowlists(deps.config());
  let heartbeat: unknown = null;

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  const server = http.createServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  const reject = (req: IncomingMessage): void => {
    const v = rejectedOriginValue(header(req, 'origin'), header(req, 'host'));
    if (v) deps.onRejectedOrigin(v);
  };

  function send(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string | string[]> = {}): void {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.setHeader('Cache-Control', 'no-store');
    if (body === undefined) {
      res.statusCode = status;
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', String(Buffer.byteLength(text)));
    res.end(text);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, route: string): void {
    const map = deps.assets();
    if (!map) {
      deps.onUiNotBuilt();
      send(res, 503, { error: 'ui-not-built' });
      return;
    }
    const entry = map.get(route);
    if (!entry) {
      send(res, 404);
      return;
    }
    fs.readFile(entry.absPath, (err, data) => {
      if (err) {
        send(res, 404);
        return;
      }
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      res.statusCode = 200;
      res.setHeader('Content-Type', entry.type);
      res.setHeader('Content-Length', String(data.length));
      // The page itself is never cached, so a new build's asset hashes are
      // picked up on the next load; the hashed assets never change.
      res.setHeader('Cache-Control', route === '/' ? 'no-store' : 'public, max-age=31536000, immutable');
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const peer = peerOf(req);
    if (penalty.isBoxed(peer) || !pairGlobal.hit()) {
      req.resume();
      send(res, 429, { error: 'rate' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      send(res, body.status, { error: 'bad-request' }, { Connection: 'close' });
      return;
    }
    const v = body.value as Record<string, unknown> | null;
    if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).some((k) => k !== 'secret' && k !== 'name')) {
      send(res, 400, { error: 'bad-request' });
      return;
    }
    const r = deps.devices.consumePairing(v.secret, v.name);
    if (!r.ok) {
      penalty.fail(peer);
      // A voided, expired or mistyped code all read the same to the phone:
      // "make a new one". Telling them apart would only help a guesser.
      if (r.reason === 'device-cap') send(res, 400, { error: 'device-cap' });
      else send(res, 410, { error: 'expired' });
      return;
    }
    const secure = isHttpsRequest(header(req, 'host'), lists);
    send(res, 200, { ok: true, device: { id: r.device.id, name: r.device.name, scope: r.device.scope } }, {
      'Set-Cookie': cookieHeader(`${r.device.id}.${r.token}`, secure),
    });
    deps.log('remote-paired', { device: r.device.id, scope: r.device.scope });
    deps.onPaired(r.device);
  }

  function handleSession(req: IncomingMessage, res: ServerResponse): void {
    const cookie = readCookie(header(req, 'cookie'));
    const device = deps.devices.verify(cookie);
    if (!device || !cookie) {
      send(res, 401, { paired: false });
      return;
    }
    deps.devices.touch(device.id);
    const secure = isHttpsRequest(header(req, 'host'), lists);
    // Sliding window: every visit re-issues the same value with a fresh Max-Age.
    send(res, 200, { paired: true, scope: device.scope, effectiveScope: effectiveScopeFor(deps.config(), device) }, {
      'Set-Cookie': cookieHeader(cookie, secure),
    });
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    req.resume();
    const device = deps.devices.verify(readCookie(header(req, 'cookie')));
    const secure = isHttpsRequest(header(req, 'host'), lists);
    if (device) {
      deps.devices.revoke(device.id);
      deps.log('remote-logout', { device: device.id });
    }
    send(res, device ? 200 : 401, { ok: !!device }, { 'Set-Cookie': clearCookieHeader(secure) });
  }

  const POST_ROUTES = new Set(['/api/pair', '/api/logout']);

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!unauth.hit(peerOf(req))) {
      req.resume();
      send(res, 429, { error: 'rate' });
      return;
    }
    if (!isAllowedHost(header(req, 'host'), lists)) {
      reject(req);
      req.resume();
      send(res, 403);
      return;
    }
    const route = routeOf(req.url);
    if (route === null) {
      req.resume();
      send(res, 404);
      return;
    }
    const method = req.method ?? '';
    if (POST_ROUTES.has(route)) {
      if (method !== 'POST') {
        req.resume();
        send(res, 405, undefined, { Allow: 'POST' });
        return;
      }
      if (!isAllowedOrigin(header(req, 'origin'), lists)) {
        reject(req);
        req.resume();
        send(res, 403);
        return;
      }
      if (route === '/api/pair') {
        handlePair(req, res).catch(() => send(res, 400, { error: 'bad-request' }));
      } else {
        handleLogout(req, res);
      }
      return;
    }
    req.resume();
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, undefined, { Allow: 'GET, HEAD' });
      return;
    }
    if (route === '/api/session') handleSession(req, res);
    else serveStatic(req, res, route);
  }

  /** Steps 1-7 of the upgrade sequence; the device on success, or the status to refuse with. */
  function authorizeUpgrade(req: IncomingMessage): { device: DeviceRecord } | { status: 401 | 403 | 404 } {
    if (!isAllowedHost(header(req, 'host'), lists) || !isAllowedOrigin(header(req, 'origin'), lists)) {
      reject(req);
      return { status: 403 };
    }
    if (routeOf(req.url) !== '/ws') return { status: 404 };
    const peer = peerOf(req);
    if (penalty.isBoxed(peer)) return { status: 403 };
    const device = deps.devices.verify(readCookie(header(req, 'cookie')));
    if (!device) {
      penalty.fail(peer);
      return { status: 401 };
    }
    let perDevice = 0;
    for (const c of live.values()) if (c.client.device.id === device.id) perDevice++;
    if (live.size >= MAX_CONNECTIONS || perDevice >= MAX_PER_DEVICE) return { status: 403 };
    return { device };
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    const auth = authorizeUpgrade(req);
    if ('status' in auth) {
      writeBare(socket, auth.status);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => adopt(ws, auth.device));
  }

  function adopt(ws: WebSocket, device: DeviceRecord): void {
    const id = deps.newId();
    const client: ConsoleClient = {
      id,
      device,
      effectiveScope: effectiveScopeFor(deps.config(), device),
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
      },
      bufferedAmount: () => ws.bufferedAmount,
    };
    const entry: LiveClient = { client, ws, missed: 0, handlers: { onMessage: () => undefined, onClose: () => undefined } };
    live.set(id, entry);
    deps.devices.touch(device.id);
    ws.on('pong', () => {
      entry.missed = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        client.send({ t: 'error', code: 'bad-frame', message: 'Text frames only.' });
        return;
      }
      entry.handlers.onMessage(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (live.get(id) !== entry) return;
      live.delete(id);
      entry.handlers.onClose();
    });
    entry.handlers = deps.onConnection(client);
  }

  function beat(): void {
    for (const entry of live.values()) {
      if (entry.missed >= MAX_MISSED_PONGS) {
        entry.ws.terminate();
        continue;
      }
      entry.missed++;
      try {
        entry.ws.ping();
      } catch {
        entry.ws.terminate();
      }
    }
  }

  server.on('request', onRequest);
  server.on('upgrade', onUpgrade);
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  function detachAll(): LiveClient[] {
    const all = [...live.values()];
    live.clear();
    for (const e of all) {
      try {
        e.handlers.onClose();
      } catch {
        // Teardown continues whatever one session does.
      }
    }
    return all;
  }

  return {
    httpServer: server,
    async listen(host, port) {
      const r = await listenOn(server, host, port);
      if (r.ok) {
        // Built from the port actually bound (tests listen on 0).
        lists = buildAllowlists({ ...deps.config(), port: r.port });
        heartbeat = setIntervalFn(beat, HEARTBEAT_MS);
        server.on('error', (e) => deps.log('remote-console-server-error', { message: e.message }));
      }
      return r;
    },
    async close(code = CLOSE_CODES.STOPPING) {
      if (heartbeat !== null) clearIntervalFn(heartbeat);
      heartbeat = null;
      const all = detachAll();
      await Promise.all(all.map((e) => closeGracefully(e, code)));
      wss.close();
      await closeListener(server);
    },
    closeNow() {
      if (heartbeat !== null) clearIntervalFn(heartbeat);
      heartbeat = null;
      for (const e of detachAll()) e.ws.terminate();
      wss.close();
      if (server.listening) server.close();
      server.closeAllConnections();
    },
    clients() {
      return [...live.values()].map((e) => e.client);
    },
    closeDevices(ids, code, msg) {
      const set = new Set(ids);
      for (const e of [...live.values()]) {
        if (!set.has(e.client.device.id)) continue;
        if (msg) e.client.send(msg);
        e.client.close(code, 'revoked');
      }
    },
  };
}

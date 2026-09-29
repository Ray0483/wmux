/**
 * The Remote Console runtime (#254, spec §2, §8, §9): what the facade
 * (`./index.ts`) loads lazily and main talks to.
 *
 * It owns the singletons — one listener, one device registry, one terminal
 * tap, one roster pump — and wires the pure modules to the impure world. Every
 * effect on the app goes through `ConsoleOps` (I1): this file imports nothing
 * from index.ts, ipc-handlers.ts, agent-state or ptyManager, and no Electron
 * runtime (the one `WebContents` mention is a type).
 *
 * Persistence stays under `ops.appDataDir()` (I6), both files written tmp then
 * renamed: `remote-console.json` (config) and `remote-devices.json` (token
 * HASHES only — see devices.ts).
 *
 * Three lifecycle entry points, deliberately different:
 * - `start()` is idempotent and a no-op when disabled, so main can call it
 *   unconditionally at startup.
 * - `stop()` is the graceful path (close 1001, wait briefly) for Settings.
 * - `stopNow()` is SYNCHRONOUS for `will-quit`, which cannot await (spec §0.2):
 *   timers cleared, sockets terminated, `server.close()` called and not
 *   awaited, taps reset — and it returns.
 *
 * Cost when off: the per-batch taps (`deliver`, `exit`, `noteResize`,
 * `noteDesktopInput`) are installed only while listening, so a disabled
 * console costs the forwarders one no-op call per batch (#141). `bindSurface`
 * and `unbindSurface` are installed for the runtime's whole life: they run
 * once per PTY, not per batch, and a console enabled AFTER panes were opened
 * would otherwise have no idea which window each existing terminal lives in.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { WebContents } from 'electron';
import {
  DEFAULT_REMOTE_CONFIG,
  validateRemoteConfig,
} from '../../shared/remote-console-config';
import type {
  PairOffer,
  RemoteConsoleConfig,
  RemoteConsoleStatus,
  RemoteLastError,
  RemoteModesResult,
  RemoteRendererRequest,
  RemoteRosterSource,
  RemoteSnapshotResult,
  RemoteV2Status,
} from '../../shared/remote-console-config';
import { CLOSE_CODES } from '../../shared/remote-console-protocol';
import type { RemoteScope } from '../../shared/remote-console-protocol';
import { capText, stripBidi } from '../../shared/remote-input';
import type { ConsoleOps, CreateRemoteConsoleRuntime, RemoteConsoleRuntime } from './contract';
import { DeviceRegistry } from './devices';
import type { DeviceRecord, DevicesFile } from './devices';
import {
  buildWireRoster,
  createNotifyState,
  diffNotifications,
  DoneTracker,
  mergeRosters,
  rosterChangeKey,
} from './roster';
import type { NotifyState } from './roster';
import { createConsoleServer } from './server';
import type { ClientHandlers, ConsoleClient, ConsoleServer } from './server';
import { ConsoleSession, createDeviceSessionState } from './session';
import type { DeviceSessionState } from './session';
import { loadAllowedAssets } from './static-assets';
import type { AssetEntry } from './static-assets';
import { installRemoteTaps, resetRemoteTaps } from './taps';
import { TerminalTap } from './terminal-tap';

export const CONFIG_FILE = 'remote-console.json';
export const DEVICES_FILE = 'remote-devices.json';

export interface RuntimeTimings {
  /** Roster poll while any phone is connected. */
  pumpMs: number;
  /** `notifyAgentStateChanged` coalescing. */
  coalesceMs: number;
  /** Desktop modes query; a timeout reads as `bracketedPaste:false`. */
  modesTimeoutMs: number;
  expireEveryMs: number;
}

const DEFAULT_TIMINGS: RuntimeTimings = { pumpMs: 2000, coalesceMs: 150, modesTimeoutMs: 2000, expireEveryMs: 60 * 60_000 };

type Timer = ReturnType<typeof setTimeout>;

function unrefTimeout(fn: () => void, ms: number): Timer {
  const h = setTimeout(fn, ms);
  h.unref?.();
  return h;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text);
}

/** tmp then rename: `renameSync` replaces an existing file on Windows (MOVEFILE_REPLACE_EXISTING, #214). */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** package.json sits three levels up from both src/main/remote-console and dist/main/remote-console. */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

function isModesResult(r: unknown): r is RemoteModesResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.bracketedPaste === 'boolean' || o.error === 'no-terminal';
}

interface LiveSession {
  client: ConsoleClient;
  session: ConsoleSession;
}

interface PendingModes {
  resolve(r: RemoteModesResult): void;
  timer: Timer;
}

export class ConsoleRuntime implements RemoteConsoleRuntime {
  private config: RemoteConsoleConfig = { ...DEFAULT_REMOTE_CONFIG };
  private readonly devices: DeviceRegistry;
  private server: ConsoleServer | null = null;
  private listening: { host: string; port: number } | null = null;
  private lastError: RemoteLastError | null = null;
  private lastRejectedOrigin: string | null = null;
  private assets: Map<string, AssetEntry> | null = null;
  private readonly tap: TerminalTap;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly deviceStates = new Map<string, DeviceSessionState>();
  private readonly trackers = new Map<string, DoneTracker>();
  private readonly lastSentKey = new Map<string, string>();
  private readonly wcBySurface = new Map<string, WebContents>();
  private readonly pendingModes = new Map<string, PendingModes>();
  private readonly statusListeners = new Set<(s: RemoteConsoleStatus) => void>();
  private readonly greeted = new Set<string>();
  private rendererSender: ((wc: WebContents, req: RemoteRendererRequest) => boolean) | null = null;
  private notifyState: NotifyState = createNotifyState();
  private roster: RemoteRosterSource[] = [];
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: Timer | null = null;
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private pairTimer: Timer | null = null;
  private pumping = false;
  private pumpAgain = false;
  private lifecycle: Promise<void> = Promise.resolve();
  /** Bumped by `stopNow`, which cannot wait for the lifecycle queue: a start already awaiting `listen` sees it and backs out. */
  private epoch = 0;
  private readonly version = readAppVersion();
  private readonly timings: RuntimeTimings;

  constructor(private readonly ops: ConsoleOps, timings: Partial<RuntimeTimings> = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    const devicesFile = path.join(ops.appDataDir(), DEVICES_FILE);
    this.devices = new DeviceRegistry({
      load: () => readJson(devicesFile),
      save: (data: DevicesFile) => {
        try {
          writeJsonAtomic(devicesFile, data);
        } catch (err) {
          ops.log('remote-devices-save-failed', { message: errMessage(err) });
        }
      },
      now: () => Date.now(),
      randomBytes: (n) => crypto.randomBytes(n),
      sha256: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
      log: (e, f) => ops.log(e, f),
    });
    this.devices.onRevoked((ids) => this.onDevicesRevoked(ids));
    this.tap = new TerminalTap({
      requestSnapshot: (s, reqId) => this.sendRenderer(s, { kind: 'snapshot', surfaceId: s, reqId }),
      send: (clientId, msg) => this.sessions.get(clientId)?.client.send(msg),
      bufferedAmount: (clientId) => this.sessions.get(clientId)?.client.bufferedAmount() ?? 0,
      now: () => Date.now(),
      setTimer: (fn, ms) => unrefTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as Timer),
      newReqId: () => crypto.randomUUID(),
    });
    this.config = this.loadConfig();
    this.installBindTaps();
  }

  // ── Config ────────────────────────────────────────────────────────

  private configFile(): string {
    return path.join(this.ops.appDataDir(), CONFIG_FILE);
  }

  /**
   * Validated with `null` for the LAN list: a saved interface that is gone
   * right now stays the user's choice and surfaces as `lan-address-gone` at
   * start, rather than being replaced by the default here (P0 review fix 2).
   */
  private loadConfig(): RemoteConsoleConfig {
    let raw: unknown;
    try {
      raw = readJson(this.configFile());
    } catch (err) {
      this.ops.log('remote-console-config-corrupt', { message: errMessage(err) });
      return { ...DEFAULT_REMOTE_CONFIG };
    }
    if (raw === null) return { ...DEFAULT_REMOTE_CONFIG };
    const v = validateRemoteConfig(raw, null);
    if (!v.ok) {
      this.ops.log('remote-console-config-invalid', { error: v.error });
      return { ...DEFAULT_REMOTE_CONFIG };
    }
    return v.config;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  private enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(step).catch((err) => {
      this.ops.log('remote-console-lifecycle-error', { message: errMessage(err) });
    });
    this.lifecycle = next;
    return next;
  }

  /**
   * Starts are tagged with the epoch they were REQUESTED in. stopNow() cannot
   * wait for the lifecycle queue (will-quit is synchronous), so a start still
   * queued behind it — or one already awaiting listen() — must notice it is
   * obsolete by itself rather than open a port after quit.
   */
  start(): Promise<void> {
    const epoch = this.epoch;
    return this.enqueue(() => this.doStart(epoch));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  reconfigure(): Promise<void> {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      await this.doStop();
      await this.doStart(epoch);
    });
  }

  private async doStart(epoch: number): Promise<void> {
    if (this.server || epoch !== this.epoch) return;
    this.config = this.loadConfig();
    this.devices.reload();
    this.devices.expireIdle();
    this.lastError = null;
    if (!this.config.enabled) {
      this.emitStatus();
      return;
    }
    const cfg = this.config;
    if (cfg.bind === 'lan' && (!cfg.lanHost || !this.ops.lanAddresses().includes(cfg.lanHost))) {
      this.lastError = 'lan-address-gone';
      this.ops.log('remote-console-lan-gone', { host: cfg.lanHost });
      this.emitStatus();
      return;
    }
    this.assets = loadAllowedAssets(this.ops.staticRoot());
    if (!this.assets) this.lastError = 'ui-not-built';

    const host = cfg.bind === 'lan' && cfg.lanHost ? cfg.lanHost : '127.0.0.1';
    const srv = this.createServer();
    const r = await srv.listen(host, cfg.port);
    if (epoch !== this.epoch) {
      // will-quit ran stopNow() while listen() was pending. Adopting this
      // server now would leave a bound port, a heartbeat and live taps behind
      // a runtime that has been told to be gone.
      srv.closeNow();
      return;
    }
    if (!r.ok) {
      srv.closeNow();
      this.lastError = r.error;
      this.ops.log('remote-console-listen-failed', { error: r.error, port: cfg.port });
      this.emitStatus();
      return;
    }
    this.server = srv;
    this.listening = { host, port: r.port };
    installRemoteTaps({
      deliver: (id, data) => this.tap.deliver(id, data),
      exit: (id, code) => this.tap.exit(id, code),
      noteResize: (id) => this.tap.noteResize(id),
      noteDesktopInput: (id) => this.onDesktopInput(id),
    }, (name, err) => this.ops.log('remote-tap-error', { name, message: errMessage(err) }));
    this.expireTimer = setInterval(() => this.devices.expireIdle(), this.timings.expireEveryMs);
    this.expireTimer.unref?.();
    this.ops.log('remote-console-listening', { host, port: r.port, bind: cfg.bind });
    this.emitStatus();
  }

  private async doStop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    this.listening = null;
    const epoch = this.epoch;
    await srv.close(CLOSE_CODES.STOPPING);
    // stopNow() ran meanwhile and already tore everything down; reinstalling
    // the bind taps here would undo its resetRemoteTaps().
    if (epoch !== this.epoch) return;
    this.teardown();
    resetRemoteTaps();
    this.installBindTaps();
    this.ops.log('remote-console-stopped', {});
    this.emitStatus();
  }

  stopNow(): void {
    this.epoch++;
    const srv = this.server;
    this.server = null;
    this.listening = null;
    try {
      srv?.closeNow();
    } catch {
      // Quit continues whatever the listener does.
    }
    this.teardown();
    resetRemoteTaps();
  }

  /** Everything both stop paths clear once the sockets are gone. Synchronous. */
  private teardown(): void {
    this.stopPump();
    if (this.expireTimer) clearInterval(this.expireTimer);
    this.expireTimer = null;
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.pairTimer = null;
    for (const p of this.pendingModes.values()) {
      clearTimeout(p.timer);
      p.resolve({ error: 'no-terminal' });
    }
    this.pendingModes.clear();
    this.tap.dispose();
    this.sessions.clear();
    this.lastSentKey.clear();
    try {
      this.devices.flush();
    } catch {
      // A failed flush loses at most a minute of lastSeenAt.
    }
  }

  private installBindTaps(): void {
    installRemoteTaps({
      bindSurface: (id, wc) => {
        this.wcBySurface.set(id, wc);
      },
      unbindSurface: (id) => {
        this.wcBySurface.delete(id);
      },
    }, (name, err) => this.ops.log('remote-tap-error', { name, message: errMessage(err) }));
  }

  private createServer(): ConsoleServer {
    return createConsoleServer({
      config: () => this.config,
      devices: this.devices,
      assets: () => this.assets,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      log: (e, f) => this.ops.log(e, f),
      onConnection: (client) => this.onConnection(client),
      onPaired: (device) => this.onPaired(device),
      onRejectedOrigin: (v) => {
        if (v === this.lastRejectedOrigin) return;
        this.lastRejectedOrigin = v;
        this.emitStatus();
      },
      onUiNotBuilt: () => {
        if (this.lastError === 'ui-not-built') return;
        this.lastError = 'ui-not-built';
        this.emitStatus();
      },
    });
  }

  // ── Config / pairing / devices (Settings) ─────────────────────────

  async setConfig(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const v = validateRemoteConfig(raw, this.ops.lanAddresses());
    if (!v.ok) return { ok: false, error: v.error };
    try {
      writeJsonAtomic(this.configFile(), v.config);
    } catch (err) {
      this.ops.log('remote-console-config-save-failed', { message: errMessage(err) });
      return { ok: false, error: 'write-failed' };
    }
    this.config = v.config;
    await this.reconfigure();
    return { ok: true };
  }

  pairStart(o: { name: string; scope: RemoteScope }): PairOffer | { error: string } {
    if (!this.server || !this.listening) return { error: 'not-running' };
    const scope = o?.scope;
    if (scope !== 'viewer' && scope !== 'operator') return { error: 'bad-scope' };
    const minted = this.devices.mintPairing({ scope, name: o.name });
    if ('error' in minted) return minted;
    const base = this.config.publicUrl || `http://${this.listening.host}:${this.listening.port}`;
    if (this.pairTimer) clearTimeout(this.pairTimer);
    // Settings shows its own countdown; this only makes the status agree once it runs out.
    this.pairTimer = unrefTimeout(() => {
      this.pairTimer = null;
      this.emitStatus();
    }, Math.max(0, minted.expiresAt - Date.now()) + 50);
    this.ops.log('remote-pair-offer', { scope });
    this.emitStatus();
    return { url: `${base}/#pair=${minted.secret}`, expiresAt: minted.expiresAt, scope };
  }

  pairCancel(): void {
    this.devices.cancelPairing();
    this.emitStatus();
  }

  revoke(id: string): void {
    this.devices.revoke(id);
    this.emitStatus();
  }

  revokeAll(): void {
    this.devices.revokeAll();
    this.emitStatus();
  }

  rename(id: string, name: string): void {
    this.devices.rename(id, name);
    this.emitStatus();
  }

  private onDevicesRevoked(ids: string[]): void {
    this.server?.closeDevices(ids, CLOSE_CODES.REVOKED, { t: 'revoked' });
    // Disposed NOW, not when the socket's 'close' fires: that waits on the peer
    // answering the close frame, and a revoked phone that never answers would
    // otherwise keep a live session — including an action already past its
    // modes await — for as long as ws lets a CLOSING socket linger.
    const revoked = new Set(ids);
    for (const { client, session } of this.sessions.values()) {
      if (revoked.has(client.device.id)) session.dispose();
    }
    for (const id of ids) {
      this.deviceStates.delete(id);
      this.trackers.delete(id);
    }
    this.ops.log('remote-revoked', { count: ids.length });
    this.emitStatus();
  }

  private onPaired(device: DeviceRecord): void {
    this.greeted.delete(device.id);
    this.ops.notifyDesktop('wmux', `Paired: ${device.name} (${device.scope})`);
    this.emitStatus();
  }

  // ── Status ────────────────────────────────────────────────────────

  getStatus(): RemoteConsoleStatus {
    const counts = new Map<string, number>();
    for (const { client } of this.sessions.values()) counts.set(client.device.id, (counts.get(client.device.id) ?? 0) + 1);
    return {
      config: { ...this.config },
      running: this.server !== null,
      listening: this.listening ? { ...this.listening } : null,
      lastError: this.lastError,
      lastRejectedOrigin: this.lastRejectedOrigin,
      lanAddresses: this.ops.lanAddresses(),
      devices: this.devices.list(),
      connected: [...counts].map(([deviceId, count]) => ({ deviceId, count })),
      pairing: this.devices.pairing(),
    };
  }

  /** Counts only, for the pipe: no names, no ids, no credential (I2). */
  v2Status(): RemoteV2Status {
    return {
      enabled: this.config.enabled,
      running: this.server !== null,
      bind: this.config.bind,
      port: this.listening?.port ?? this.config.port,
      publicUrl: this.config.publicUrl,
      deviceCount: this.devices.count(),
      connectedCount: this.sessions.size,
      lastError: this.lastError,
    };
  }

  onStatus(cb: (status: RemoteConsoleStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.getStatus();
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        this.ops.log('remote-status-listener-error', { message: errMessage(err) });
      }
    }
  }

  // ── Connections ───────────────────────────────────────────────────

  private deviceState(id: string): DeviceSessionState {
    let st = this.deviceStates.get(id);
    if (!st) {
      st = createDeviceSessionState(() => Date.now());
      this.deviceStates.set(id, st);
    }
    return st;
  }

  private tracker(id: string): DoneTracker {
    let t = this.trackers.get(id);
    if (!t) {
      t = new DoneTracker();
      // Seeded with the current roster so its first real update can see an edge.
      t.update(this.roster, Date.now());
      this.trackers.set(id, t);
    }
    return t;
  }

  private onConnection(client: ConsoleClient): ClientHandlers {
    const device = client.device;
    const session = new ConsoleSession({
      ops: this.ops,
      device: { id: device.id, name: device.name, scope: device.scope },
      effectiveScope: client.effectiveScope,
      deviceState: this.deviceState(device.id),
      host: capText(stripBidi(this.ops.hostname()), 64),
      version: this.version,
      send: (msg) => client.send(msg),
      close: (code, reason) => client.close(code, reason),
      queryModes: (s) => this.queryModes(s),
      onHello: () => this.sendRosterTo(client.id, Date.now()),
      onAttach: (s) => {
        this.tap.attach(client.id, s);
        if (this.tracker(device.id).clear(s)) this.broadcastRoster(Date.now());
      },
      onDetach: () => this.tap.detach(client.id),
      onSeen: (s) => {
        if (this.tracker(device.id).clear(s)) this.broadcastRoster(Date.now());
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => {
        unrefTimeout(resolve, ms);
      }),
    });
    this.sessions.set(client.id, { client, session });
    this.ops.log('remote-connect', { device: device.id, scope: client.effectiveScope });
    if (!this.greeted.has(device.id)) {
      this.greeted.add(device.id);
      this.ops.notifyDesktop('wmux', `Remote console: ${device.name} connected`);
    }
    if (this.sessions.size === 1) this.startPump();
    this.emitStatus();
    return {
      onMessage: (text) => {
        session.handleFrame(text).catch((err) => this.ops.log('remote-session-error', { message: errMessage(err) }));
      },
      onClose: () => this.onDisconnect(client.id, session),
    };
  }

  private onDisconnect(clientId: string, session: ConsoleSession): void {
    session.dispose();
    this.sessions.delete(clientId);
    this.lastSentKey.delete(clientId);
    if (this.sessions.size === 0) this.stopPump();
    this.emitStatus();
  }

  // ── Roster pump ───────────────────────────────────────────────────

  private startPump(): void {
    if (this.pumpTimer) return;
    this.notifyState = createNotifyState();
    this.pumpTimer = setInterval(() => this.firePump(), this.timings.pumpMs);
    this.pumpTimer.unref?.();
    this.firePump();
  }

  private stopPump(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.roster = [];
    this.trackers.clear();
  }

  /** From agent-state's broadcast. Nothing to do unless a phone is watching; coalesced 150 ms. */
  notifyAgentStateChanged(): void {
    if (!this.pumpTimer || this.coalesceTimer) return;
    this.coalesceTimer = unrefTimeout(() => {
      this.coalesceTimer = null;
      this.firePump();
    }, this.timings.coalesceMs);
  }

  private firePump(): void {
    this.pumpOnce().catch((err) => this.ops.log('remote-roster-failed', { message: errMessage(err) }));
  }

  /** Exposed for tests: one poll of every window's roster. */
  async pumpOnce(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpStep();
      } while (this.pumpAgain && this.pumpTimer);
    } finally {
      this.pumping = false;
    }
  }

  private async pumpStep(): Promise<void> {
    let raw: unknown[][];
    try {
      raw = await this.ops.listRoster();
    } catch (err) {
      this.ops.log('remote-roster-failed', { message: errMessage(err) });
      return;
    }
    if (!this.pumpTimer) return;
    const now = Date.now();
    this.roster = mergeRosters(raw);
    for (const t of this.trackers.values()) t.update(this.roster, now);
    const notes = diffNotifications(this.notifyState, this.roster, now);
    this.broadcastRoster(now);
    for (const n of notes) {
      for (const { client, session } of this.sessions.values()) {
        if (session.isHelloed) client.send({ t: 'notify', kind: n.kind, s: n.s, label: n.label, at: n.at });
      }
    }
  }

  private sendRosterTo(clientId: string, now: number): void {
    const live = this.sessions.get(clientId);
    if (!live?.session.isHelloed) return;
    const list = buildWireRoster(this.roster, this.tracker(live.client.device.id));
    const key = rosterChangeKey(list);
    if (this.lastSentKey.get(clientId) === key) return;
    this.lastSentKey.set(clientId, key);
    live.client.send({ t: 'agents', list, at: now });
  }

  private broadcastRoster(now: number): void {
    for (const id of this.sessions.keys()) this.sendRosterTo(id, now);
  }

  private onDesktopInput(surfaceId: string): void {
    let changed = false;
    for (const t of this.trackers.values()) changed = t.clear(surfaceId) || changed;
    if (changed) this.broadcastRoster(Date.now());
  }

  // ── Renderer requests ─────────────────────────────────────────────

  setRendererSender(fn: (wc: WebContents, req: RemoteRendererRequest) => boolean): void {
    this.rendererSender = fn;
  }

  /** To the SAME webContents the surface's PTY_DATA goes to (terminal-tap.ts, fact 1). */
  private sendRenderer(surfaceId: string, req: RemoteRendererRequest): boolean {
    const wc = this.wcBySurface.get(surfaceId);
    if (!wc || !this.rendererSender) return false;
    try {
      return this.rendererSender(wc, req);
    } catch {
      return false;
    }
  }

  /** The desktop terminal's bracketed-paste mode. Never the phone's opinion (spec §5 rule 4.6). */
  queryModes(surfaceId: string): Promise<RemoteModesResult> {
    const reqId = crypto.randomUUID();
    return new Promise<RemoteModesResult>((resolve) => {
      const timer = unrefTimeout(() => this.settleModes(reqId, { bracketedPaste: false }), this.timings.modesTimeoutMs);
      this.pendingModes.set(reqId, { resolve, timer });
      if (!this.sendRenderer(surfaceId, { kind: 'modes', surfaceId, reqId })) this.settleModes(reqId, { error: 'no-terminal' });
    });
  }

  private settleModes(reqId: string, result: RemoteModesResult): boolean {
    const p = this.pendingModes.get(reqId);
    if (!p) return false;
    this.pendingModes.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(result);
    return true;
  }

  handleRendererReply(reqId: string, result: RemoteSnapshotResult | RemoteModesResult): void {
    if (typeof reqId !== 'string') return;
    if (this.pendingModes.has(reqId)) {
      this.settleModes(reqId, isModesResult(result) ? result : { error: 'no-terminal' });
      return;
    }
    this.tap.handleReply(reqId, result);
  }
}

export const createRemoteConsoleRuntime: CreateRemoteConsoleRuntime = (ops) => new ConsoleRuntime(ops);

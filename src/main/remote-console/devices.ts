/**
 * Paired devices and the one live pairing offer (#254, spec §8).
 *
 * Pure: file I/O, the clock and the random source are injected by the runtime,
 * so single use, expiry, the failure cap and "the token never reaches disk"
 * are all testable with a fake clock and a Map for a file.
 *
 * What is stored is a HASH of each device token, never the token (I6). The
 * token exists in exactly two places: the phone's HttpOnly cookie, and this
 * process's memory for the length of the POST that minted it. A copy of
 * `remote-devices.json` therefore cannot be replayed as a cookie. It is not
 * sealed further (DPAPI, safeStorage): the only adversary that can read the
 * file runs as the user and holds the same key (spec §1, I2 non-goal).
 *
 * Pairing secrets are hashed too, for the same reason: the offer lives for
 * 120 s in memory only, but there is no cost to comparing hashes and it keeps
 * one comparison routine for both credentials.
 *
 * A device holds TWO credentials, and needs both. The cookie is host-scoped,
 * not port-scoped: on plain http (ssh -L, a LAN bind) the browser sends it to
 * every other server on that host, which can read it and replay it from a
 * non-browser client with any Host/Origin it likes. So pairing also mints a
 * page KEY that the phone keeps in localStorage — scoped to the exact origin,
 * port included — and presents on `/api/session` and on the WebSocket
 * upgrade. A stolen cookie alone opens nothing. Only its hash is stored, like
 * the token's. A record from before the key existed has `keyHash: null` and
 * can never connect again: re-pairing replaces it.
 */
import { timingSafeEqual } from 'crypto';
import type { RemoteDeviceView } from '../../shared/remote-console-config';
import { DEVICE_NAME_MAX, type RemoteScope } from '../../shared/remote-console-protocol';
import { capText, stripBidi } from '../../shared/remote-input';

export const PAIR_TTL_MS = 120_000;
export const PAIR_MAX_FAILURES = 5;
export const MAX_DEVICES = 10;
export const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_PERSIST_MS = 60_000;
const NAME_MAX = DEVICE_NAME_MAX;
const DEFAULT_NAME = 'Phone';

export interface DeviceRecord {
  id: string;
  name: string;
  scope: RemoteScope;
  tokenHash: string;
  /** Hash of the page key (see the header); null for a record paired before it existed. */
  keyHash: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

export interface DeviceDeps {
  /** Parsed contents of remote-devices.json; null when absent. May throw on a corrupt file. */
  load(): unknown;
  /** Throws when the write did not land (a sharing violation on the rename, a full disk). */
  save(data: DevicesFile): void;
  now(): number;
  randomBytes(n: number): Buffer;
  /** Hex sha256 of a UTF-8 string. */
  sha256(s: string): string;
  log?(event: string, fields: Record<string, unknown>): void;
}

interface Offer {
  hash: string;
  scope: RemoteScope;
  name: string;
  expiresAt: number;
  failures: number;
}

export type ConsumeResult =
  | { ok: true; device: DeviceRecord; token: string; key: string }
  | { ok: false; reason: 'expired' | 'invalid' | 'device-cap' };

/** Strip controls and bidi, trim, cap; empty becomes the default. Names are rendered in Settings and on the phone. */
export function cleanDeviceName(raw: unknown, fallback = DEFAULT_NAME): string {
  if (typeof raw !== 'string') return fallback;
  let out = '';
  for (const ch of stripBidi(raw)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f)) out += ch;
  }
  const trimmed = capText(out.trim(), NAME_MAX).trim();
  return trimmed === '' ? fallback : trimmed;
}

function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDevice(v: unknown): DeviceRecord | null {
  if (!isRecord(v)) return null;
  const { id, name, scope, tokenHash, keyHash, createdAt, lastSeenAt } = v;
  if (typeof id !== 'string' || !/^dev-[0-9a-f-]{36}$/.test(id)) return null;
  if (scope !== 'viewer' && scope !== 'operator') return null;
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (typeof createdAt !== 'number' || typeof lastSeenAt !== 'number') return null;
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt)) return null;
  const key = typeof keyHash === 'string' && /^[0-9a-f]{64}$/.test(keyHash) ? keyHash : null;
  return { id, name: cleanDeviceName(name), scope, tokenHash, keyHash: key, createdAt, lastSeenAt };
}

function uuidFrom(bytes: Buffer): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceRecord>();
  private offer: Offer | null = null;
  private readonly revokedListeners = new Set<(ids: string[], replaced: boolean) => void>();
  private lastPersist = 0;
  private dirty = false;
  /**
   * The last write did not land, so memory is ahead of the file. A reload in
   * that state would read the file BEHIND memory — resurrecting a device the
   * user revoked, token hash intact — so it retries the write instead.
   */
  private unsaved = false;
  /**
   * Every id revoked (or expired) in this process lifetime. A reload never
   * brings one back, whatever the file says: a revoke whose write failed must
   * not be undone by the next reconfigure. Ids are random per pairing, so a
   * re-paired phone is a new id and is not caught by this.
   */
  private readonly tombstones = new Set<string>();

  constructor(private readonly deps: DeviceDeps) {
    this.reload();
  }

  /** True while memory holds changes the file does not (the last write failed). */
  hasUnsavedChanges(): boolean {
    return this.unsaved;
  }

  /**
   * Re-read the file. A corrupt or foreign file loads as EMPTY and is logged,
   * never thrown. With an unsaved change pending, memory is authoritative: the
   * write is retried and the file is not read.
   */
  reload(): void {
    if (this.unsaved) {
      this.persist();
      return;
    }
    this.devices.clear();
    let raw: unknown;
    try {
      raw = this.deps.load();
    } catch (err) {
      this.deps.log?.('remote-devices-corrupt', { message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (raw === null || raw === undefined) return;
    if (!isRecord(raw) || !Array.isArray(raw.devices)) {
      this.deps.log?.('remote-devices-corrupt', { message: 'bad-shape' });
      return;
    }
    for (const d of raw.devices) {
      const rec = parseDevice(d);
      if (rec && !this.tombstones.has(rec.id)) this.devices.set(rec.id, rec);
    }
  }

  /** False when the write failed; the change stays in memory and is retried on the next persist or reload. */
  private persist(): boolean {
    this.dirty = false;
    this.lastPersist = this.deps.now();
    try {
      this.deps.save({ version: 1, devices: [...this.devices.values()].map((d) => ({ ...d })) });
      this.unsaved = false;
      return true;
    } catch (err) {
      this.unsaved = true;
      this.deps.log?.('remote-devices-save-failed', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Write a pending `touch` now (stop, quit). */
  flush(): void {
    if (this.dirty) this.persist();
  }

  /** `replaced`: the ids were superseded by a re-pair of the same browser, not removed. */
  onRevoked(cb: (ids: string[], replaced: boolean) => void): () => void {
    this.revokedListeners.add(cb);
    return () => this.revokedListeners.delete(cb);
  }

  private emitRevoked(ids: string[], replaced = false): void {
    if (ids.length === 0) return;
    for (const cb of this.revokedListeners) {
      try {
        cb(ids, replaced);
      } catch {
        // A listener's failure must not keep the revoke from completing.
      }
    }
  }

  // ── Pairing ────────────────────────────────────────────────────────

  /**
   * One live offer at a time: a new mint voids the previous one, so a QR code
   * left on a screen stops working the moment the user makes another.
   */
  mintPairing(o: { scope: RemoteScope; name: string }): { secret: string; expiresAt: number; scope: RemoteScope } | { error: 'device-cap' } {
    if (this.devices.size >= MAX_DEVICES) return { error: 'device-cap' };
    const secret = this.deps.randomBytes(32).toString('base64url');
    const expiresAt = this.deps.now() + PAIR_TTL_MS;
    this.offer = { hash: this.deps.sha256(secret), scope: o.scope, name: cleanDeviceName(o.name), expiresAt, failures: 0 };
    return { secret, expiresAt, scope: o.scope };
  }

  cancelPairing(): void {
    this.offer = null;
  }

  pairing(): { expiresAt: number; scope: RemoteScope } | null {
    if (this.offer && this.deps.now() >= this.offer.expiresAt) this.offer = null;
    return this.offer ? { expiresAt: this.offer.expiresAt, scope: this.offer.scope } : null;
  }

  /**
   * Single use: the first success destroys the offer. Five wrong secrets void
   * it too — 32 random bytes are not guessable, so five misses mean somebody
   * is trying rather than mistyping, and a fresh QR is one click away.
   */
  consumePairing(secret: unknown, name: unknown, replaces?: string | null): ConsumeResult {
    const offer = this.offer;
    if (!offer || this.deps.now() >= offer.expiresAt) {
      this.offer = null;
      return { ok: false, reason: 'expired' };
    }
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 128
      || !hashesEqual(this.deps.sha256(secret), offer.hash)) {
      offer.failures++;
      if (offer.failures >= PAIR_MAX_FAILURES) this.offer = null;
      return { ok: false, reason: 'invalid' };
    }
    this.offer = null;
    // Re-pairing THIS browser (to change its access, or after it lost its
    // page key) replaces its old record rather than leaving a dead duplicate
    // in Settings — and so does not count against the cap it frees.
    const old = replaces ? this.devices.get(replaces) ?? null : null;
    if (this.devices.size - (old ? 1 : 0) >= MAX_DEVICES) return { ok: false, reason: 'device-cap' };
    const token = this.deps.randomBytes(32).toString('base64url');
    const key = this.deps.randomBytes(32).toString('base64url');
    const now = this.deps.now();
    const device: DeviceRecord = {
      id: `dev-${uuidFrom(this.deps.randomBytes(16))}`,
      name: cleanDeviceName(name, offer.name),
      scope: offer.scope,
      tokenHash: this.deps.sha256(token),
      keyHash: this.deps.sha256(key),
      createdAt: now,
      lastSeenAt: now,
    };
    if (old) {
      this.devices.delete(old.id);
      this.tombstones.add(old.id);
    }
    this.devices.set(device.id, device);
    this.persist();
    if (old) this.emitRevoked([old.id], true);
    return { ok: true, device: { ...device }, token, key };
  }

  /** The page key a device must present beside its cookie (see the header). Constant-time. */
  verifyKey(device: DeviceRecord, key: string | null | undefined): boolean {
    if (!device.keyHash || !key || key.length > 128) return false;
    return hashesEqual(this.deps.sha256(key), device.keyHash);
  }

  // ── Devices ────────────────────────────────────────────────────────

  /** `<devId>.<token>` → the device, or null. The hash compare is constant-time. */
  verify(cookie: string | null | undefined): DeviceRecord | null {
    if (!cookie) return null;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return null;
    const dev = this.devices.get(cookie.slice(0, dot));
    if (!dev) return null;
    const token = cookie.slice(dot + 1);
    if (token.length === 0 || token.length > 128) return null;
    return hashesEqual(this.deps.sha256(token), dev.tokenHash) ? dev : null;
  }

  /** Persisted at most once a minute: a connected phone touches on every request. */
  touch(id: string): void {
    const dev = this.devices.get(id);
    if (!dev) return;
    const now = this.deps.now();
    dev.lastSeenAt = now;
    this.dirty = true;
    if (now - this.lastPersist >= TOUCH_PERSIST_MS) this.persist();
  }

  get(id: string): DeviceRecord | null {
    return this.devices.get(id) ?? null;
  }

  count(): number {
    return this.devices.size;
  }

  list(): RemoteDeviceView[] {
    return [...this.devices.values()].map(({ id, name, scope, createdAt, lastSeenAt }) => ({ id, name, scope, createdAt, lastSeenAt }));
  }

  rename(id: string, name: unknown): void {
    const dev = this.devices.get(id);
    if (!dev) return;
    dev.name = cleanDeviceName(name, dev.name);
    this.persist();
  }

  /**
   * The live cutoff happens whatever the disk says (memory and the tombstone
   * are what `verify` answers from). The return value is whether it is also
   * on disk, so Settings can say so rather than show a revoke that a restart
   * of wmux would quietly undo.
   */
  revoke(id: string): boolean {
    if (!this.devices.delete(id)) return true;
    this.tombstones.add(id);
    const saved = this.persist();
    this.emitRevoked([id]);
    return saved;
  }

  revokeAll(): boolean {
    const ids = [...this.devices.keys()];
    for (const id of ids) this.tombstones.add(id);
    this.devices.clear();
    this.offer = null;
    const saved = this.persist();
    this.emitRevoked(ids);
    return saved;
  }

  /** Forget devices unseen for 30 days. Runs at start and hourly. */
  expireIdle(): string[] {
    const cutoff = this.deps.now() - IDLE_EXPIRY_MS;
    const gone: string[] = [];
    for (const [id, d] of this.devices) {
      if (d.lastSeenAt < cutoff) {
        this.devices.delete(id);
        this.tombstones.add(id);
        gone.push(id);
      }
    }
    if (gone.length > 0) {
      this.persist();
      this.emitRevoked(gone);
    }
    return gone;
  }
}

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import {
  cleanDeviceName,
  DeviceRegistry,
  IDLE_EXPIRY_MS,
  MAX_DEVICES,
  PAIR_TTL_MS,
} from '../../src/main/remote-console/devices';
import type { DeviceDeps, DevicesFile } from '../../src/main/remote-console/devices';

function harness(initial: unknown = null): {
  reg: DeviceRegistry;
  saves: DevicesFile[];
  advance: (ms: number) => void;
  deps: DeviceDeps;
} {
  let t = 1_700_000_000_000;
  const saves: DevicesFile[] = [];
  let seed = 0;
  const deps: DeviceDeps = {
    load: () => (typeof initial === 'function' ? (initial as () => unknown)() : initial),
    save: (d) => saves.push(JSON.parse(JSON.stringify(d)) as DevicesFile),
    now: () => t,
    // Deterministic but distinct bytes.
    randomBytes: (n) => crypto.createHash('sha512').update(String(++seed)).digest().subarray(0, n),
    sha256: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    log: vi.fn(),
  };
  return { reg: new DeviceRegistry(deps), saves, advance: (ms) => { t += ms; }, deps };
}

function pair(reg: DeviceRegistry, scope: 'viewer' | 'operator' = 'operator', name = 'Phone') {
  const offer = reg.mintPairing({ scope, name });
  if ('error' in offer) throw new Error(offer.error);
  const r = reg.consumePairing(offer.secret, name);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe('DeviceRegistry pairing (#254)', () => {
  it('a secret is single use', () => {
    const { reg } = harness();
    const offer = reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    if ('error' in offer) throw new Error();
    expect(offer.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = reg.consumePairing(offer.secret, 'My phone');
    expect(first.ok).toBe(true);
    expect(reg.consumePairing(offer.secret, 'Again')).toEqual({ ok: false, reason: 'expired' });
  });

  it('expires after 120 s', () => {
    const { reg, advance } = harness();
    const offer = reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    if ('error' in offer) throw new Error();
    expect(offer.expiresAt).toBeGreaterThan(0);
    advance(PAIR_TTL_MS);
    expect(reg.consumePairing(offer.secret, 'x')).toEqual({ ok: false, reason: 'expired' });
    expect(reg.pairing()).toBeNull();
  });

  it('a new mint voids the previous offer', () => {
    const { reg } = harness();
    const a = reg.mintPairing({ scope: 'viewer', name: 'A' });
    const b = reg.mintPairing({ scope: 'operator', name: 'B' });
    if ('error' in a || 'error' in b) throw new Error();
    expect(reg.consumePairing(a.secret, 'A').ok).toBe(false);
    const ok = reg.consumePairing(b.secret, 'B');
    expect(ok.ok && ok.device.scope).toBe('operator');
  });

  it('wrong secrets never void the offer: any peer can send them, so a cap let a stranger cancel every QR (#254)', () => {
    const { reg } = harness();
    const offer = reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    if ('error' in offer) throw new Error();
    for (let i = 0; i < 50; i++) expect(reg.consumePairing('wrong' + i, 'x')).toEqual({ ok: false, reason: 'invalid' });
    expect(reg.pairing()).not.toBeNull();
    expect(reg.consumePairing(offer.secret, 'x').ok).toBe(true);
  });

  it('pairingMatches answers for the live offer only, with no side effect', () => {
    const { reg, advance } = harness();
    expect(reg.pairingMatches('x')).toBe(false);
    const offer = reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    if ('error' in offer) throw new Error();
    expect(reg.pairingMatches('wrong')).toBe(false);
    expect(reg.pairingMatches(42)).toBe(false);
    expect(reg.pairingMatches(offer.secret)).toBe(true);
    expect(reg.pairingMatches(offer.secret)).toBe(true);
    advance(PAIR_TTL_MS);
    expect(reg.pairingMatches(offer.secret)).toBe(false);
  });

  it('non-string or oversize secrets count as failures, never throw', () => {
    const { reg } = harness();
    reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    expect(reg.consumePairing(42, 'x')).toEqual({ ok: false, reason: 'invalid' });
    expect(reg.consumePairing('a'.repeat(1000), 'x')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('caps at 10 devices', () => {
    const { reg } = harness();
    for (let i = 0; i < MAX_DEVICES; i++) pair(reg);
    expect(reg.mintPairing({ scope: 'viewer', name: 'x' })).toEqual({ error: 'device-cap' });
  });

  it('cancelPairing kills the offer', () => {
    const { reg } = harness();
    const offer = reg.mintPairing({ scope: 'viewer', name: 'Phone' });
    if ('error' in offer) throw new Error();
    reg.cancelPairing();
    expect(reg.consumePairing(offer.secret, 'x').ok).toBe(false);
  });
});

describe('DeviceRegistry persistence and verification', () => {
  it('the token is never saved, only its hash', () => {
    const { reg, saves } = harness();
    const r = pair(reg);
    const disk = JSON.stringify(saves);
    expect(disk).not.toContain(r.token);
    expect(saves.at(-1)?.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.device.id).toMatch(/^dev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('verify accepts <id>.<token> and nothing else', () => {
    const { reg } = harness();
    const r = pair(reg);
    expect(reg.verify(`${r.device.id}.${r.token}`)?.id).toBe(r.device.id);
    expect(reg.verify(`${r.device.id}.${r.token}x`)).toBeNull();
    expect(reg.verify(`${r.device.id}.`)).toBeNull();
    expect(reg.verify(r.token)).toBeNull();
    expect(reg.verify('dev-nope.abc')).toBeNull();
    expect(reg.verify(null)).toBeNull();
  });

  it('a revoked device stops verifying and fires onRevoked', () => {
    const { reg } = harness();
    const r = pair(reg);
    const seen: string[][] = [];
    reg.onRevoked((ids) => seen.push(ids));
    reg.revoke(r.device.id);
    expect(reg.verify(`${r.device.id}.${r.token}`)).toBeNull();
    expect(seen).toEqual([[r.device.id]]);
  });

  it('revokeAll revokes every device in one event', () => {
    const { reg } = harness();
    const a = pair(reg);
    const b = pair(reg);
    const seen: string[][] = [];
    reg.onRevoked((ids) => seen.push(ids));
    reg.revokeAll();
    expect(seen).toEqual([[a.device.id, b.device.id]]);
    expect(reg.count()).toBe(0);
  });

  it('a throwing onRevoked listener does not stop the revoke', () => {
    const { reg } = harness();
    const r = pair(reg);
    reg.onRevoked(() => { throw new Error('boom'); });
    expect(() => reg.revoke(r.device.id)).not.toThrow();
    expect(reg.count()).toBe(0);
  });

  it('a revoke whose write fails is reported, and no reload brings the device back', () => {
    // The file on disk still lists the device: the write that would have
    // removed it failed (antivirus or a sync client holding the rename).
    let disk: DevicesFile | null = null;
    let failWrites = false;
    const h = harness(() => disk);
    h.deps.save = (d) => {
      if (failWrites) throw new Error('EBUSY');
      disk = JSON.parse(JSON.stringify(d)) as DevicesFile;
    };
    const r = pair(h.reg);
    const cookie = `${r.device.id}.${r.token}`;
    failWrites = true;
    expect(h.reg.revoke(r.device.id)).toBe(false);
    expect(h.reg.hasUnsavedChanges()).toBe(true);
    expect(h.reg.verify(cookie)).toBeNull();
    // Reconfigure / start reloads: memory stays authoritative while unsaved.
    h.reg.reload();
    expect(h.reg.verify(cookie)).toBeNull();
    // The retry lands once the file is writable again, and the file agrees.
    failWrites = false;
    h.reg.reload();
    expect(h.reg.hasUnsavedChanges()).toBe(false);
    expect(disk!.devices.map((d) => d.id)).not.toContain(r.device.id);
    expect(h.reg.verify(cookie)).toBeNull();
  });

  it('a device revoked this run stays revoked even if a stale file lists it again', () => {
    let disk: DevicesFile | null = null;
    const h = harness(() => disk);
    h.deps.save = (d) => { disk = JSON.parse(JSON.stringify(d)) as DevicesFile; };
    const r = pair(h.reg);
    const stale = JSON.parse(JSON.stringify(disk)) as DevicesFile;
    expect(h.reg.revoke(r.device.id)).toBe(true);
    disk = stale;
    h.reg.reload();
    expect(h.reg.verify(`${r.device.id}.${r.token}`)).toBeNull();
    expect(h.reg.count()).toBe(0);
  });

  it('reloads saved devices', () => {
    const first = harness();
    const r = pair(first.reg);
    const second = harness(first.saves.at(-1));
    expect(second.reg.verify(`${r.device.id}.${r.token}`)?.name).toBe('Phone');
  });

  it('a corrupt file loads as empty and is logged', () => {
    const h = harness(() => { throw new SyntaxError('Unexpected token'); });
    expect(h.reg.count()).toBe(0);
    expect(h.deps.log).toHaveBeenCalledWith('remote-devices-corrupt', expect.any(Object));
    const bad = harness({ devices: 'nope' });
    expect(bad.reg.count()).toBe(0);
    const partial = harness({ version: 1, devices: [{ id: 'dev-x' }, null] });
    expect(partial.reg.count()).toBe(0);
  });

  it('touch persists at most once a minute; flush writes the rest', () => {
    const { reg, saves, advance } = harness();
    const r = pair(reg);
    advance(60_000);
    const before = saves.length;
    reg.touch(r.device.id);
    expect(saves.length).toBe(before + 1);
    advance(1000);
    reg.touch(r.device.id);
    expect(saves.length).toBe(before + 1);
    reg.flush();
    expect(saves.length).toBe(before + 2);
    reg.flush();
    expect(saves.length).toBe(before + 2);
  });

  it('expires devices idle for 30 days', () => {
    const { reg, advance } = harness();
    const old = pair(reg);
    advance(IDLE_EXPIRY_MS - 1000);
    const fresh = pair(reg);
    advance(2000);
    const revoked: string[][] = [];
    reg.onRevoked((ids) => revoked.push(ids));
    expect(reg.expireIdle()).toEqual([old.device.id]);
    expect(reg.get(fresh.device.id)).not.toBeNull();
    expect(revoked).toEqual([[old.device.id]]);
    expect(reg.expireIdle()).toEqual([]);
  });

  it('list and rename expose no hash', () => {
    const { reg } = harness();
    const r = pair(reg);
    reg.rename(r.device.id, '  Pixel‮ 8 ');
    const [view] = reg.list();
    expect(view).toEqual({ id: r.device.id, name: 'Pixel 8', scope: 'operator', createdAt: expect.any(Number), lastSeenAt: expect.any(Number) });
    expect(JSON.stringify(reg.list())).not.toMatch(/hash|token/i);
  });
});

describe('cleanDeviceName', () => {
  it('strips controls and bidi, trims, caps, defaults', () => {
    expect(cleanDeviceName('a\x1b[31mb')).toBe('a[31mb');
    expect(cleanDeviceName('   ')).toBe('Phone');
    expect(cleanDeviceName(undefined, 'Tablet')).toBe('Tablet');
    expect(cleanDeviceName('x'.repeat(200)).length).toBe(64);
  });
});

describe('DeviceRegistry: page key and re-pairing (#254)', () => {
  it('pairing mints a page key; only its hash is stored, and verifyKey checks it', () => {
    const { reg, saves } = harness();
    const r = pair(reg);
    expect(r.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(saves.at(-1))).not.toContain(r.key);
    const dev = reg.get(r.device.id)!;
    expect(reg.verifyKey(dev, r.key)).toBe(true);
    expect(reg.verifyKey(dev, r.token)).toBe(false);
    expect(reg.verifyKey(dev, null)).toBe(false);
  });

  it('a record from before the key existed loads, and can never connect', () => {
    const { reg } = harness({
      version: 1,
      devices: [{ id: 'dev-00000000-0000-4000-8000-000000000001', name: 'Old', scope: 'operator', tokenHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 1_700_000_000_000 }],
    });
    const dev = reg.get('dev-00000000-0000-4000-8000-000000000001')!;
    expect(dev.keyHash).toBeNull();
    expect(reg.verifyKey(dev, 'anything-at-all-000000')).toBe(false);
  });

  it('re-pairing the same browser replaces its record instead of leaving a dead duplicate', () => {
    const { reg } = harness();
    const revoked: string[][] = [];
    reg.onRevoked((ids) => revoked.push(ids));
    const first = pair(reg, 'viewer');
    pair(reg);
    const offer = reg.mintPairing({ scope: 'operator', name: 'Phone' });
    if ('error' in offer) throw new Error();
    const again = reg.consumePairing(offer.secret, 'Phone', first.device.id);
    if (!again.ok) throw new Error(again.reason);
    expect(reg.get(first.device.id)).toBeNull();
    expect(reg.count()).toBe(2);
    expect(again.device.scope).toBe('operator');
    expect(revoked.at(-1)).toEqual([first.device.id]);
    // The old cookie is dead for good (tombstoned), even across a reload.
    expect(reg.verify(`${first.device.id}.${first.token}`)).toBeNull();
  });
});

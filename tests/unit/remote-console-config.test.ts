import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMOTE_CONFIG,
  REMOTE_DEFAULT_PORT,
  REMOTE_ENTRY_KEY,
  REMOTE_MANIFEST_FILE,
  normalizePublicUrl,
  validateRemoteConfig,
} from '../../src/shared/remote-console-config';

// Addresses assembled from octets: fixtures standing for "an interface this
// machine has" and "one it does not", never something to connect to.
const ipv4 = (...octets: number[]): string => octets.join('.');
const HERE = ipv4(10, 0, 0, 5);
const GONE = ipv4(192, 168, 1, 99);
const LAN = [ipv4(192, 168, 1, 20), HERE];

describe('remote console constants (#254)', () => {
  it('pins the port and the manifest names', () => {
    expect(REMOTE_DEFAULT_PORT).toBe(9790);
    expect(REMOTE_MANIFEST_FILE).toBe('remote-manifest.json');
    expect(REMOTE_ENTRY_KEY).toBe('remote/index.html');
  });
  it('is off and loopback by default (I3)', () => {
    expect(DEFAULT_REMOTE_CONFIG).toEqual({
      enabled: false, bind: 'loopback', lanHost: null, port: 9790, publicUrl: '', allowInsecureControl: false,
    });
  });
});

describe('validateRemoteConfig', () => {
  it('an empty object is the default config', () => {
    expect(validateRemoteConfig({}, LAN)).toEqual({ ok: true, config: { ...DEFAULT_REMOTE_CONFIG } });
  });

  it('rejects a non-object', () => {
    expect(validateRemoteConfig(null, LAN)).toEqual({ ok: false, error: 'bad-shape' });
    expect(validateRemoteConfig([], LAN)).toEqual({ ok: false, error: 'bad-shape' });
  });

  const errors: [string, Record<string, unknown>, string][] = [
    ['string enabled', { enabled: 'true' }, 'bad-enabled'],
    ['unknown bind', { bind: 'any' }, 'bad-bind'],
    ['privileged port', { port: 80 }, 'bad-port'],
    ['port too high', { port: 65536 }, 'bad-port'],
    ['fractional port', { port: 9790.5 }, 'bad-port'],
    ['string port', { port: '9790' }, 'bad-port'],
    ['lan with no host', { bind: 'lan' }, 'bad-lan-host'],
    ['lan with a host not on this machine', { bind: 'lan', lanHost: GONE }, 'bad-lan-host'],
    ['lan with the wildcard address', { bind: 'lan', lanHost: ipv4(0, 0, 0, 0) }, 'bad-lan-host'],
    ['non-boolean allowInsecureControl', { allowInsecureControl: 1 }, 'bad-allow-insecure'],
    ['public url with a path', { publicUrl: 'https://box.ts.net/wmux' }, 'bad-public-url'],
    ['public url with a query', { publicUrl: 'https://box.ts.net/?a=1' }, 'bad-public-url'],
    ['public url with an empty query', { publicUrl: 'https://box.ts.net?' }, 'bad-public-url'],
    ['public url with a hash', { publicUrl: 'https://box.ts.net/#x' }, 'bad-public-url'],
    ['public url with userinfo', { publicUrl: 'https://u:p@box.ts.net' }, 'bad-public-url'],
    ['non-http scheme', { publicUrl: 'wss://box.ts.net' }, 'bad-public-url'],
    ['javascript scheme', { publicUrl: 'javascript:alert(1)' }, 'bad-public-url'],
    ['garbage url', { publicUrl: 'not a url' }, 'bad-public-url'],
  ];
  for (const [name, raw, error] of errors) {
    it(`rejects ${name}`, () => expect(validateRemoteConfig(raw, LAN)).toEqual({ ok: false, error }));
  }

  it('accepts a LAN bind on a present address', () => {
    const r = validateRemoteConfig({ enabled: true, bind: 'lan', lanHost: HERE, allowInsecureControl: true }, LAN);
    expect(r).toEqual({ ok: true, config: { ...DEFAULT_REMOTE_CONFIG, enabled: true, bind: 'lan', lanHost: HERE, allowInsecureControl: true } });
  });

  it('loading from disk (null) keeps a LAN host whose interface has gone, for start() to report', () => {
    const r = validateRemoteConfig({ enabled: true, bind: 'lan', lanHost: GONE }, null);
    expect(r.ok && r.config.lanHost).toBe(GONE);
  });

  it('loading from disk (null) still refuses a host that is not a bindable IPv4', () => {
    for (const lanHost of [ipv4(0, 0, 0, 0), 'box.local', '10.0.0.256', '10.0.0.05', '10.0.0', '::1', 42]) {
      expect(validateRemoteConfig({ bind: 'lan', lanHost }, null)).toEqual({ ok: false, error: 'bad-lan-host' });
    }
  });

  it('drops lanHost and forces allowInsecureControl off on loopback', () => {
    const r = validateRemoteConfig({ bind: 'loopback', lanHost: HERE, allowInsecureControl: true }, LAN);
    expect(r.ok && r.config.lanHost).toBe(null);
    expect(r.ok && r.config.allowInsecureControl).toBe(false);
  });

  it('normalises the public url to its origin', () => {
    const r = validateRemoteConfig({ publicUrl: '  HTTPS://Box.TS.net:443/ ' }, LAN);
    expect(r.ok && r.config.publicUrl).toBe('https://box.ts.net');
  });

  it('keeps a non-default port in the origin', () => {
    expect(normalizePublicUrl('http://127.0.0.1:9790')).toBe('http://127.0.0.1:9790');
  });
});

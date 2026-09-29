import { describe, it, expect } from 'vitest';
import {
  buildAllowlists,
  clearCookieHeader,
  cookieHeader,
  isAllowedHost,
  isAllowedOrigin,
  isHttpsRequest,
  normalizeHost,
  readCookie,
  rejectedOriginValue,
  routeOf,
  SECURITY_HEADERS,
} from '../../src/main/remote-console/guards';

/** Plain-HTTP origins are the product's LAN reality (spec §7), not an oversight in the test. */
const plain = (rest: string): string => `http://${rest}`;

const loopback = buildAllowlists({ port: 9790, bind: 'loopback', lanHost: null, publicUrl: '' });
const lan = buildAllowlists({ port: 9790, bind: 'lan', lanHost: '192.0.2.20', publicUrl: '' });
const tailnet = buildAllowlists({ port: 9790, bind: 'loopback', lanHost: null, publicUrl: 'https://box.tail1234.ts.net' });

// LAN addresses are RFC 5737 documentation addresses, never a real interface.
describe('remote-console guards: Host (#254, DNS rebinding)', () => {
  it.each([
    ['127.0.0.1:9790', true],
    ['localhost:9790', true],
    ['LOCALHOST:9790', true],
    ['[::1]:9790', true],
    ['127.0.0.1', false],            // no port: not what a browser sends for :9790
    ['127.0.0.1:9791', false],
    ['evil.example:9790', false],    // the rebinding case: right IP, attacker's name
    ['127.0.0.1.nip.io:9790', false],
    ['192.0.2.20:9790', false],    // a LAN name on a loopback bind
    ['', false],
  ])('loopback bind: %s → %s', (host, ok) => {
    expect(isAllowedHost(host, loopback)).toBe(ok);
  });

  it('a missing Host header is refused', () => {
    expect(isAllowedHost(undefined, loopback)).toBe(false);
  });

  it('a LAN bind adds exactly its interface', () => {
    expect(isAllowedHost('192.0.2.20:9790', lan)).toBe(true);
    expect(isAllowedHost('192.0.2.21:9790', lan)).toBe(false);
  });

  it('publicUrl adds its host with the default port folded', () => {
    expect(isAllowedHost('box.tail1234.ts.net', tailnet)).toBe(true);
    expect(isAllowedHost('box.tail1234.ts.net:443', tailnet)).toBe(true);
    expect(isAllowedHost('box.tail1234.ts.net:8443', tailnet)).toBe(false);
    expect(normalizeHost('Example.COM:80')).toBe('example.com');
  });
});

describe('remote-console guards: Origin', () => {
  it('exact origins only', () => {
    expect(isAllowedOrigin(plain('127.0.0.1:9790'), loopback)).toBe(true);
    expect(isAllowedOrigin(plain('localhost:9790'), loopback)).toBe(true);
    expect(isAllowedOrigin(plain('[::1]:9790'), loopback)).toBe(true);
    expect(isAllowedOrigin('https://127.0.0.1:9790', loopback)).toBe(false); // scheme mismatch
    expect(isAllowedOrigin(plain('127.0.0.1:9790/'), loopback)).toBe(false);
    expect(isAllowedOrigin(plain('evil.example'), loopback)).toBe(false);
  });

  it('missing and "null" Origins are refused (sandboxed iframe, file://)', () => {
    expect(isAllowedOrigin(undefined, loopback)).toBe(false);
    expect(isAllowedOrigin('null', loopback)).toBe(false);
    expect(isAllowedOrigin('', loopback)).toBe(false);
  });

  it('publicUrl origin is exact, scheme included', () => {
    expect(isAllowedOrigin('https://box.tail1234.ts.net', tailnet)).toBe(true);
    expect(isAllowedOrigin(plain('box.tail1234.ts.net'), tailnet)).toBe(false);
  });
});

describe('remote-console guards: routeOf (traversal)', () => {
  it.each([
    ['/', '/'],
    ['/ws', '/ws'],
    ['/ws/', '/ws'],
    ['/api/session?x=1', '/api/session'],
    ['/assets/a-123.js#frag', '/assets/a-123.js'],
    ['/../secret', null],
    ['/assets/..%2fmain.js', null],
    ['/%2e%2e/x', null],
    ['/%2E%2E/x', null],
    ['/assets\\..\\x', null],
    ['//evil.example/x', null],
    ['/a%00b', null],
    ['relative', null],
    ['', null],
  ])('%s → %s', (url, route) => {
    expect(routeOf(url)).toBe(route);
  });

  it('undefined is null', () => {
    expect(routeOf(undefined)).toBeNull();
  });
});

describe('remote-console guards: https, cookies, headers', () => {
  it('https only through the configured https publicUrl host', () => {
    expect(isHttpsRequest('box.tail1234.ts.net', tailnet)).toBe(true);
    expect(isHttpsRequest('127.0.0.1:9790', tailnet)).toBe(false);
    expect(isHttpsRequest('box.tail1234.ts.net', loopback)).toBe(false);
    expect(isHttpsRequest(undefined, tailnet)).toBe(false);
    const httpPublic = buildAllowlists({ port: 9790, bind: 'loopback', lanHost: null, publicUrl: plain('box.local:8080') });
    expect(isHttpsRequest('box.local:8080', httpPublic)).toBe(false);
  });

  it('cookie is HttpOnly, SameSite=Strict, 30 days, Secure only when asked', () => {
    expect(cookieHeader('dev-x.tok', false)).toBe('wmux_rc=dev-x.tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
    expect(cookieHeader('v', true).endsWith('; Secure')).toBe(true);
    expect(clearCookieHeader(false)).toContain('Max-Age=0');
  });

  it('readCookie finds wmux_rc among others', () => {
    expect(readCookie('a=1; wmux_rc=dev-1.abc; b=2')).toBe('dev-1.abc');
    expect(readCookie('a=1')).toBeNull();
    expect(readCookie('wmux_rc=')).toBeNull();
    expect(readCookie(undefined)).toBeNull();
  });

  it('the CSP is byte-exact with the spec', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(Object.keys(SECURITY_HEADERS).map((k) => k.toLowerCase())).not.toContain('server');
  });

  it('rejectedOriginValue prefers Origin, guesses https for a bare proxied host, refuses junk', () => {
    expect(rejectedOriginValue('https://x.ts.net', 'x.ts.net')).toBe('https://x.ts.net');
    expect(rejectedOriginValue(undefined, 'X.ts.net')).toBe('https://x.ts.net');
    expect(rejectedOriginValue(undefined, '192.0.2.5:9790')).toBe(plain('192.0.2.5:9790'));
    expect(rejectedOriginValue('null', undefined)).toBeNull();
    expect(rejectedOriginValue(plain('a b'), undefined)).toBeNull();
  });
});

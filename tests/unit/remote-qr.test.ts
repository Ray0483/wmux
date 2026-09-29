import { describe, it, expect } from 'vitest';
import { qrSvg, qrDataUri } from '../../src/renderer/components/Settings/remote-qr';

// The pairing QR (#254). A wrong QR does not fail loudly — the phone camera
// just never finds a code — so the shape is pinned here rather than by eye.

// The longest URL pairing realistically produces: a public origin plus a
// 43-character base64url secret in the fragment, padded out to 120.
const LONG_URL = ('https://my-desktop.tail1234.ts.net/#pair=' + 'A'.repeat(120)).slice(0, 120);

describe('qrSvg', () => {
  it('returns an SVG document', () => {
    const svg = qrSvg('http://127.0.0.1:9790/#pair=abc');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('is deterministic — the same URL always draws the same code', () => {
    expect(qrSvg(LONG_URL)).toBe(qrSvg(LONG_URL));
  });

  it('encodes a 120-character pairing URL', () => {
    expect(LONG_URL).toHaveLength(120);
    const svg = qrSvg(LONG_URL);
    const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
    // Version 6-M holds 106 bytes and version 7-M 122, so 120 bytes needs at
    // least version 7 (45 modules) plus the 4-module quiet zone on each side.
    expect(size).toBeGreaterThanOrEqual(45 + 8);
    expect(svg).toContain('h1v1h-1z');
  });

  it('draws different codes for different URLs', () => {
    expect(qrSvg('http://127.0.0.1:9790/#pair=a')).not.toBe(qrSvg('http://127.0.0.1:9790/#pair=b'));
  });

  it('paints an opaque background, so the code scans on a dark theme', () => {
    expect(qrSvg('x')).toContain('fill="#fff"');
  });

  it('carries none of the encoded text in the markup', () => {
    // The payload lives only in the module pattern; nothing user-typed is
    // interpolated into the SVG where it would need escaping.
    expect(qrSvg('https://evil.example/"><script>')).not.toContain('evil');
  });
});

describe('qrDataUri', () => {
  it('is a percent-encoded SVG data URI for an <img>', () => {
    const uri = qrDataUri('x');
    expect(uri.startsWith('data:image/svg+xml;utf8,%3Csvg')).toBe(true);
    expect(decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length))).toBe(qrSvg('x'));
  });
});

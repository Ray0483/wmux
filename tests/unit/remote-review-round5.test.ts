// @vitest-environment jsdom
/**
 * Remote Console (#254), review round 5: the phone- and Settings-side halves.
 * Server-side halves live in the terminal-tap, session, server-integration and
 * runtime suites.
 */
import fs from 'fs';
import path from 'path';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorPans, MIN_FONT_PX, CELL_WIDTH_EM } from '../../src/renderer/remote/fit';
import { viewerNoticeKey } from '../../src/renderer/remote/screens/ConsoleScreen';
import { REMOTE_LANGUAGES } from '../../src/renderer/remote/i18n';
import RemoteConsoleSettings, { connectedDevices } from '../../src/renderer/components/Settings/RemoteConsoleSettings';
import { DICTIONARIES, SUPPORTED_LANGUAGES } from '../../src/renderer/i18n';
import type { RemoteConsoleStatus } from '../../src/shared/remote-console-config';
import { DEFAULT_REMOTE_CONFIG } from '../../src/shared/remote-console-config';
import { readCookie, readCookies, MAX_COOKIE_CANDIDATES } from '../../src/main/remote-console/guards';
import { actionNonceOf } from '../../src/main/remote-console/session';
import { effectiveScopeFor } from '../../src/main/remote-console/server';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PHONE_CODES = REMOTE_LANGUAGES.map((l) => l.code);
function phoneDict(code: string): Record<string, string> {
  return REMOTE_LANGUAGES.find((l) => l.code === code)?.dict as Record<string, string>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
function render(el: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(el); });
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function status(over: Partial<RemoteConsoleStatus> = {}): RemoteConsoleStatus {
  return {
    config: { ...DEFAULT_REMOTE_CONFIG, enabled: true },
    running: true,
    listening: { host: '127.0.0.1', port: 9790 },
    lastError: null,
    lastRejectedOrigin: null,
    lanAddresses: ['192.0.2.5'],
    devices: [{ id: 'dev-1', name: 'Pixel', scope: 'operator', createdAt: 1, lastSeenAt: 2 }],
    connected: [],
    pairing: null,
    ...over,
  };
}

function mountSettings(s: RemoteConsoleStatus) {
  const bridge = {
    getState: vi.fn(async () => s),
    onState: vi.fn(() => () => undefined),
    revoke: vi.fn(async () => undefined),
    revokeAll: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => ({ ok: true as const })),
    dismissRejectedOrigin: vi.fn(async () => undefined),
    pairStart: vi.fn(), pairCancel: vi.fn(), onRendererRequest: vi.fn(), replyRenderer: vi.fn(),
  };
  (window as unknown as { wmux: unknown }).wmux = { remoteConsole: bridge };
  return bridge;
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

describe('fit mode never crops columns it cannot show (#254)', () => {
  it('pans whenever the floor font is still too wide, by arithmetic or by the drawn grid', () => {
    // 100 columns on a 289 px screen: 7 px is the floor and still 385 px wide.
    expect(mirrorPans('fit', 289, 100)).toBe(true);
    expect(mirrorPans('fit', 390, 60)).toBe(false);
    // The 0.6 em estimate says it fits; the measured grid says otherwise.
    const cols = Math.floor(390 / (MIN_FONT_PX * CELL_WIDTH_EM));
    expect(mirrorPans('fit', 390, cols, 0)).toBe(false);
    expect(mirrorPans('fit', 390, cols, 420)).toBe(true);
    expect(mirrorPans('pan', 2000, 10)).toBe(true);
  });

  it('TermView gives a clipped fit mirror the sideways-scrolling wrap', () => {
    const src = read('src/renderer/remote/components/TermView.tsx');
    expect(src).toContain("mode === 'pan' || clipped ? 'rc-term__wrap rc-term__wrap--pan'");
    expect(src).toMatch(/setClipped\(mirrorPans\(/);
  });
});

describe('a demoted Control device is told the real reason (#254)', () => {
  it('a secure page names the pairing, not the plain-HTTP bind', () => {
    expect(viewerNoticeKey('operator', 'viewer', false)).toBe('console.controlLimited');
    expect(viewerNoticeKey('operator', 'viewer', true)).toBe('console.repairForControl');
    expect(viewerNoticeKey('viewer', 'viewer', true)).toBe('console.viewerNotice');
    expect(viewerNoticeKey('operator', 'operator', true)).toBeNull();
  });

  it('every phone language has the message', async () => {
    expect(PHONE_CODES).toHaveLength(18);
    for (const lang of PHONE_CODES) {
      const d = phoneDict(lang);
      expect(d['console.repairForControl'], lang).toBeTruthy();
    }
  });

  it('effectiveScopeFor: cleartext devices are view-only off the LAN, and the LAN rule is unchanged', () => {
    const loop = { ...DEFAULT_REMOTE_CONFIG, bind: 'loopback' as const };
    const lan = { ...DEFAULT_REMOTE_CONFIG, bind: 'lan' as const, allowInsecureControl: false };
    const lanOk = { ...lan, allowInsecureControl: true };
    expect(effectiveScopeFor(loop, { scope: 'operator' })).toBe('operator');
    expect(effectiveScopeFor(loop, { scope: 'operator', cleartext: true })).toBe('viewer');
    expect(effectiveScopeFor(lan, { scope: 'operator' })).toBe('viewer');
    expect(effectiveScopeFor(lanOk, { scope: 'operator', cleartext: true })).toBe('operator');
  });

  it('the pair dialog comment says what main does', () => {
    expect(read('src/renderer/components/Settings/PairDeviceDialog.tsx')).not.toContain('is refused by main anyway');
    expect(read('src/main/remote-console/runtime.ts')).toMatch(/insecure \? 'viewer' : o\.scope/);
  });
});

describe('cookies and nonces (#254)', () => {
  it('readCookies returns every wmux_rc value in order, capped', () => {
    expect(readCookies('wmux_rc=junk; a=1; wmux_rc=dev-1.abc')).toEqual(['junk', 'dev-1.abc']);
    expect(readCookie('wmux_rc=junk; wmux_rc=dev-1.abc')).toBe('junk');
    expect(readCookies(Array.from({ length: 10 }, (_, i) => `wmux_rc=v${i}`).join('; '))).toHaveLength(MAX_COOKIE_CANDIDATES);
    expect(readCookies('wmux_rc=; b=2')).toEqual([]);
  });

  it('actionNonceOf finds the nonce of an action frame, valid or not, and nothing else', () => {
    expect(actionNonceOf(JSON.stringify({ t: 'send', nonce: 'abcdefgh-1', text: 5 }))).toBe('abcdefgh-1');
    expect(actionNonceOf(JSON.stringify({ t: 'answer', nonce: 'abcdefgh-2' }))).toBe('abcdefgh-2');
    expect(actionNonceOf(JSON.stringify({ t: 'ping', nonce: 'abcdefgh-3' }))).toBeNull();
    expect(actionNonceOf(JSON.stringify({ t: 'key', nonce: 'bad nonce!' }))).toBeNull();
    expect(actionNonceOf('not json')).toBeNull();
    expect(actionNonceOf('[1]')).toBeNull();
  });
});

describe('Settings → Remote (#254, review round 5)', () => {
  it('"Use as Public URL" spells out the address and what adopting it means before saving', async () => {
    const bridge = mountSettings(status({ lastRejectedOrigin: 'https://evil-tailnet.ts.net' }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    act(() => { button(el, 'Use as Public URL')!.click(); });
    expect(bridge.setConfig).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Pairing links and QR codes will send phones to https://evil-tailnet.ts.net');
    await act(async () => { button(el, 'Yes, use this address')!.click(); });
    expect(bridge.setConfig).toHaveBeenCalledWith(expect.objectContaining({ publicUrl: 'https://evil-tailnet.ts.net' }));
  });

  it('Cancel leaves the Public URL alone', async () => {
    const bridge = mountSettings(status({ lastRejectedOrigin: 'https://pc.tail1234.ts.net' }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    act(() => { button(el, 'Use as Public URL')!.click(); });
    act(() => { button(el, 'Cancel')!.click(); });
    expect(bridge.setConfig).not.toHaveBeenCalled();
    expect(button(el, 'Use as Public URL')).toBeDefined();
  });

  it('counts connected DEVICES, as the CLI does', async () => {
    expect(connectedDevices({ connected: [{ deviceId: 'dev-1', count: 2 }] })).toBe(1);
    expect(connectedDevices({ connected: [{ deviceId: 'dev-1', count: 2 }, { deviceId: 'dev-2', count: 0 }, { deviceId: 'dev-3', count: 1 }] })).toBe(2);
    mountSettings(status({ connected: [{ deviceId: 'dev-1', count: 2 }] }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    expect(el.textContent).toContain('· 1 connected');
  });

  it('no locale puts a plural word right after a bare {count} in the status line', () => {
    for (const lang of ['es', 'it', 'pt', 'sv']) {
      const s = DICTIONARIES[lang]?.['settings.remote.statusListening'] ?? '';
      expect(s, lang).toMatch(/: \{count\}$/);
    }
  });

  it('the German Remote tab uses Sie throughout', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang !== 'de') continue;
      const d = DICTIONARIES[lang] as Record<string, string>;
      for (const [k, v] of Object.entries(d)) {
        if (!k.startsWith('settings.remote.')) continue;
        expect(v, k).not.toMatch(/\b(du|dich|dir|dein|deine|deinen|Verwende|Versuche|Schalte|Widerrufe)\b/);
      }
    }
  });
});

describe('phone wording (#254, review round 5)', () => {
  it('a blocked card does not say "Needs you" a third time', async () => {
    for (const lang of PHONE_CODES) {
      const d = phoneDict(lang);
      const needs = d['console.needsYou'];
      if (!needs) continue;
      for (const k of ['card.openToAnswer', 'card.answerOnComputer']) {
        if (d[k]) expect(d[k], `${lang} ${k}`).not.toContain(needs);
      }
    }
  });

  it('Chinese and Japanese use one word each for "agent" and "device"', async () => {
    const zh = phoneDict('zh');
    expect(Object.values(zh).join('\n')).not.toContain('智能体');
    expect(zh['card.answerOnComputer']).not.toContain('需要你处理');
    expect(zh['prefs.alertsUnsupported']).toContain('系统提醒');
    expect(zh['prefs.alertsUnsupported']).toContain('页面内提醒仍然可用');
    const ja = phoneDict('ja');
    expect(Object.values(ja).join('\n')).not.toContain('デバイス');
  });
});

describe('CLAUDE.md (#254, review round 5)', () => {
  it('describes the two-entry build and the shared chunk, and drops the stale bundle size', () => {
    const md = read('CLAUDE.md');
    expect(md).not.toContain('already at ~1.8 MB');
    expect(md).toContain('remote-manifest.json (the console server refuses to serve without it)');
    expect(md).toMatch(/separate shared chunk that the desktop window loads too/);
  });
});

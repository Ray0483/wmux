// @vitest-environment jsdom
/**
 * Remote Console (#254), review round 6: the Settings, refused-page and phone
 * wording halves. Server-side halves live in the session, server-integration,
 * devices, config and ws-client suites.
 */
import crypto from 'crypto';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RemoteConsoleSettings, { deviceScopeKey } from '../../src/renderer/components/Settings/RemoteConsoleSettings';
import { DICTIONARIES, SUPPORTED_LANGUAGES } from '../../src/renderer/i18n';
import { REMOTE_LANGUAGES } from '../../src/renderer/remote/i18n';
import type { RemoteConsoleStatus } from '../../src/shared/remote-console-config';
import { DEFAULT_REMOTE_CONFIG } from '../../src/shared/remote-console-config';
import { REFUSED_TEXT } from '../../src/main/remote-console/refused-page';
import { effectiveScopeFor } from '../../src/main/remote-console/server';
import { DeviceRegistry } from '../../src/main/remote-console/devices';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const desktop = (lang: string): Record<string, string> => DICTIONARIES[lang] as Record<string, string>;
const phone = (code: string): Record<string, string> =>
  REMOTE_LANGUAGES.find((l) => l.code === code)?.dict as Record<string, string>;

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

function mountSettings(s: RemoteConsoleStatus): void {
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
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('Settings says what a device can actually do (#254, round 6)', () => {
  it('the Access column agrees with effectiveScopeFor on every bind, override and cleartext combination', () => {
    for (const bind of ['loopback', 'lan'] as const) {
      for (const allowInsecureControl of [false, true]) {
        for (const cleartext of [undefined, true] as const) {
          const cfg = { ...DEFAULT_REMOTE_CONFIG, bind, allowInsecureControl };
          const key = deviceScopeKey({ scope: 'operator', cleartext }, cfg);
          const canControl = effectiveScopeFor(cfg, { scope: 'operator', cleartext }) === 'operator';
          expect(key === 'settings.remote.scope.operator', `${bind} ${allowInsecureControl} ${cleartext}`).toBe(canControl);
        }
      }
    }
    expect(deviceScopeKey({ scope: 'operator', cleartext: true }, { bind: 'loopback', allowInsecureControl: false }))
      .toBe('settings.remote.scope.operatorRepair');
  });

  it('the device list carries the cleartext mark', () => {
    const reg = new DeviceRegistry({
      load: () => null, save: () => undefined, now: () => Date.now(),
      randomBytes: (n) => crypto.randomBytes(n),
      sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    });
    const offer = reg.mintPairing({ scope: 'operator', name: 'Phone' });
    if ('error' in offer) throw new Error();
    const r = reg.consumePairing(offer.secret, 'Phone');
    if (!r.ok) throw new Error();
    expect(reg.list()[0].cleartext).toBeUndefined();
    reg.markCleartext(r.device.id);
    expect(reg.list()[0].cleartext).toBe(true);
  });

  it('a Control device that crossed plain HTTP reads as needing a re-pair, not as Control', async () => {
    mountSettings(status({ devices: [{ id: 'dev-1', name: 'Pixel', scope: 'operator', createdAt: 1, lastSeenAt: 2, cleartext: true }] }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    expect(el.textContent).toContain('Control (view only until paired again)');
  });

  it('the Connected column says yes for a device with two tabs, never "2"', async () => {
    mountSettings(status({ connected: [{ deviceId: 'dev-1', count: 2 }] }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    const cells = [...el.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells).toContain('Yes');
    expect(cells).not.toContain('2');
  });

  it('every desktop language has the new strings', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const d = desktop(lang);
      expect(d['settings.remote.scope.operatorRepair'], lang).toBeTruthy();
      expect(d['settings.remote.connectedYes'], lang).toBeTruthy();
      expect(d['settings.remote.configError.badPublicUrl'], lang).toContain('https://my-pc.tailnet.ts.net');
    }
  });
});

describe('the refused-address page never promises a button that is not there (#254, round 6)', () => {
  it('every language also names the Public URL FIELD, beside the conditional one-click button', () => {
    expect(Object.keys(REFUSED_TEXT)).toHaveLength(18);
    for (const [lang, text] of Object.entries(REFUSED_TEXT)) {
      const d = desktop(lang);
      expect(text, lang).toContain(d['settings.remote.useAsPublicUrl']);
      const withoutButton = text.split(d['settings.remote.useAsPublicUrl']).join('');
      expect(withoutButton, lang).toContain(d['settings.remote.publicUrl']);
    }
    expect(REFUSED_TEXT.en).toMatch(/if it is offered/);
    expect(REFUSED_TEXT.en).toMatch(/pairing QR code/);
  });
});

describe('phone wording (#254, round 6)', () => {
  it('"pair again" names the desktop menu that makes a code, in every language', () => {
    for (const { code } of REMOTE_LANGUAGES) {
      const text = phone(code)['console.repairForControl'];
      expect(text, code).toContain(desktop(code)['settings.remote.pair']);
      expect(text, code).toContain(desktop(code)['settings.tab.remote']);
    }
    expect(phone('en')['console.repairForControl']).not.toMatch(/from here/);
  });

  it('Russian says сопрячь for pairing everywhere, as the desktop does', () => {
    for (const [k, v] of Object.entries(phone('ru'))) expect(v, k).not.toMatch(/привяз/i);
  });
});

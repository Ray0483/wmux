// @vitest-environment jsdom
/**
 * Remote Console fixes from the #254 integration review, round 3 — the pure
 * decisions and the phone/Settings rendering. Server- and session-level
 * regressions live beside their harnesses (remote-console-*.test.ts).
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackPeer, keyFromProtocols, offersAsPublicUrl } from '../../src/main/remote-console/guards';
import { REFUSED_TEXT, refusedPage, refusedPageLang } from '../../src/main/remote-console/refused-page';
import { CLOSE_CODES, WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL } from '../../src/shared/remote-console-protocol';
import type { RemoteConsoleStatus } from '../../src/shared/remote-console-config';
import { DEFAULT_REMOTE_CONFIG } from '../../src/shared/remote-console-config';
import { createWsClient, socketProtocols, type WsLike } from '../../src/renderer/remote/ws-client';
import { DEVICE_KEY_ITEM, forgetDeviceKey, loadDeviceKey, saveDeviceKey } from '../../src/renderer/remote/device-key';
import { viewerNoticeKey } from '../../src/renderer/remote/screens/ConsoleScreen';
import { acceptsInput, attachHeaderChips } from '../../src/renderer/remote/screens/AttachScreen';
import { claimAltHint } from '../../src/renderer/remote/components/TermView';
import { hasRealAge } from '../../src/renderer/remote/components/AgentCard';
import { PairScreen } from '../../src/renderer/remote/screens/PairScreen';
import { PrefsScreen, DEFAULT_PREFS } from '../../src/renderer/remote/screens/PrefsScreen';
import { KeyBar } from '../../src/renderer/remote/components/KeyBar';
import { createT } from '../../src/renderer/remote/i18n';
import { fr as phoneFr } from '../../src/renderer/remote/i18n/messages/fr';
import { de as phoneDe } from '../../src/renderer/remote/i18n/messages/de';
import { es as phoneEs } from '../../src/renderer/remote/i18n/messages/es';
import { it as phoneIt } from '../../src/renderer/remote/i18n/messages/it';
import RemoteConsoleSettings, { deviceScopeKey } from '../../src/renderer/components/Settings/RemoteConsoleSettings';
import { DICTIONARIES, SUPPORTED_LANGUAGES } from '../../src/renderer/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createT('en');
const LOOPBACK = '127.0.0.1';
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
  delete (window as { wmux?: unknown }).wmux;
});

describe('refused origins: only a proxy of the user\'s own is offered (#254)', () => {
  it('loopback, https, a Tailscale name, no port or path', () => {
    expect(offersAsPublicUrl('https://pc.tail1234.ts.net', '127.0.0.1')).toBe(true);
    expect(offersAsPublicUrl('https://pc.tail1234.ts.net', `::ffff:${LOOPBACK}`)).toBe(true);
    // A LAN peer can forge any Host; a rebinding page reaches plain http only.
    expect(offersAsPublicUrl('https://pc.tail1234.ts.net', '192.0.2.20')).toBe(false);
    expect(offersAsPublicUrl(`${'http'}://evil.com:9790`, '127.0.0.1')).toBe(false);
    expect(offersAsPublicUrl('https://evil.com', '127.0.0.1')).toBe(false);
    expect(offersAsPublicUrl('https://pc.ts.net:8443', '127.0.0.1')).toBe(false);
    expect(offersAsPublicUrl('not a url', '127.0.0.1')).toBe(false);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });
});

describe('the page key rides as a second subprotocol (#254)', () => {
  it('is found in Sec-WebSocket-Protocol and never is the selected one', () => {
    expect(keyFromProtocols(`${WS_SUBPROTOCOL}, ${WS_KEY_PROTOCOL_PREFIX}abc_DEF-123`)).toBe('abc_DEF-123');
    expect(keyFromProtocols(WS_SUBPROTOCOL)).toBeNull();
    expect(keyFromProtocols(undefined)).toBeNull();
    expect(socketProtocols('k'.repeat(43))).toEqual([WS_SUBPROTOCOL, WS_KEY_PROTOCOL_PREFIX + 'k'.repeat(43)]);
    expect(socketProtocols(null)).toEqual([WS_SUBPROTOCOL]);
  });

  it('is kept in origin-scoped storage, validated on the way in and out', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
    expect(saveDeviceKey('a'.repeat(43), storage)).toBe(true);
    expect(loadDeviceKey(storage)).toBe('a'.repeat(43));
    expect(saveDeviceKey('bad key', storage)).toBe(false);
    map.set(DEVICE_KEY_ITEM, 'x y');
    expect(loadDeviceKey(storage)).toBeNull();
    forgetDeviceKey(undefined, storage);
    expect(map.has(DEVICE_KEY_ITEM)).toBe(false);
  });
});

describe('a tab over the connection cap stops and says why (#254)', () => {
  it('close 4409 is final: stopped as too-many, no reconnect loop', () => {
    const sockets: { onclose: WsLike['onclose'] }[] = [];
    const timers: unknown[] = [];
    const client = createWsClient({
      url: 'ws://h/ws',
      createSocket: () => {
        const s = { readyState: 0, send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null } as WsLike;
        sockets.push(s);
        return s;
      },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
      isVisible: () => true,
    });
    client.start();
    sockets[0].onclose?.({ code: CLOSE_CODES.TOO_MANY });
    expect(client.state.status).toBe('stopped');
    expect(client.state.stopReason).toBe('too-many');
    expect(timers).toHaveLength(0);
  });
});

describe('the refused-address page speaks the phone\'s language (#254)', () => {
  it('picks by q-value and region, English otherwise, and names the desktop menus', () => {
    expect(refusedPageLang('fr-CA,fr;q=0.9')).toBe('fr');
    expect(refusedPageLang('xx, de;q=0.5, fr;q=0.8')).toBe('fr');
    expect(refusedPageLang('zh-Hant-TW')).toBe('zh-TW');
    expect(refusedPageLang('zh-CN')).toBe('zh');
    expect(refusedPageLang('xx-YY')).toBe('en');
    expect(refusedPageLang(undefined)).toBe('en');
    expect(Object.keys(REFUSED_TEXT)).toHaveLength(18);
    expect(refusedPage('de')).toContain('Einstellungen → Fernzugriff');
    expect(refusedPage('<script>')).not.toContain('<script>');
  });
});

describe('phone screens (#254)', () => {
  it('a Control device narrowed by a plain-HTTP bind is told so, not just "view only"', () => {
    expect(viewerNoticeKey('operator', 'operator')).toBeNull();
    expect(viewerNoticeKey('operator', 'viewer')).toBe('console.controlLimited');
    expect(viewerNoticeKey('viewer', 'viewer')).toBe('console.viewerNotice');
    const el = render(createElement(PrefsScreen, {
      t, prefs: DEFAULT_PREFS, host: 'pc', device: { name: 'Pixel', scope: 'operator' }, effectiveScope: 'viewer',
      onChange: vi.fn(), onBack: vi.fn(), onForget: vi.fn(),
    }));
    expect(el.textContent).toContain(t.t('console.controlLimited'));
  });

  it('the four text-size buttons each have a name a screen reader can tell apart', () => {
    const el = render(createElement(PrefsScreen, {
      t, prefs: DEFAULT_PREFS, host: 'pc', device: null, effectiveScope: 'operator',
      onChange: vi.fn(), onBack: vi.fn(), onForget: vi.fn(),
    }));
    const names = [...el.querySelectorAll('button[aria-pressed]')]
      .map((b) => b.getAttribute('aria-label'))
      .filter((n): n is string => n !== null && n.includes('%'));
    expect(names).toEqual(['Text size 85%', 'Text size 100%', 'Text size 115%', 'Text size 130%']);
  });

  it('the pairing confirm can be declined', () => {
    const onCancel = vi.fn();
    const el = render(createElement(PairScreen, { t, busy: false, failed: null, onPair: vi.fn(), onCancel }));
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === t.t('common.cancel'))!;
    expect(cancel).toBeDefined();
    act(() => { cancel.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('⋯ is outside the scrolling key row, so it is always on screen', () => {
    const el = render(createElement(KeyBar, { armed: null, armedFor: null, t, onKey: vi.fn() }));
    const more = el.querySelector(`button[aria-label="${t.t('keys.more')}"]`)!;
    expect(more.closest('.rc-keybar__scroll')).toBeNull();
    expect(el.querySelector('.rc-keybar__scroll')?.querySelectorAll('button')).toHaveLength(11);
  });

  it('the attach header shows the connection whenever it is not ready, beside the state', () => {
    expect(attachHeaderChips(true, 'ready')).toEqual(['state']);
    expect(attachHeaderChips(true, 'waiting')).toEqual(['state', 'conn']);
    expect(attachHeaderChips(false, 'connecting')).toEqual(['conn']);
  });

  it('no composer, keys or choices into a terminal that exited or errored', () => {
    expect(acceptsInput(true, 'live')).toBe(true);
    expect(acceptsInput(true, 'loading')).toBe(true);
    expect(acceptsInput(true, 'exit')).toBe(false);
    expect(acceptsInput(true, 'error')).toBe(false);
    expect(acceptsInput(false, 'live')).toBe(false);
  });

  it('the full-screen hint is shown once per surface', () => {
    const shown = new Set<string>();
    expect(claimAltHint(shown, 's1')).toBe(true);
    expect(claimAltHint(shown, 's1')).toBe(false);
    expect(claimAltHint(shown, 's2')).toBe(true);
  });

  it('an agent with no timestamp of its own shows no age', () => {
    expect(hasRealAge({ state: 'blocked', stateSource: 'detected' })).toBe(true);
    expect(hasRealAge({ state: 'working', stateSource: 'declared' })).toBe(true);
    expect(hasRealAge({ state: 'working', stateSource: 'detected' })).toBe(false);
    expect(hasRealAge({ state: 'idle', stateSource: null })).toBe(false);
    expect(hasRealAge({ state: 'unknown', stateSource: 'declared' })).toBe(false);
  });
});

describe('phone and desktop wording (#254)', () => {
  it('French: the alerts limitation is grammatical, and the card hint does not repeat "Needs you"', () => {
    expect(phoneFr['prefs.limits']).toContain('il se peut que rien n’arrive');
    expect(phoneFr['prefs.limits']).not.toContain('rien peut ne pas');
    // The section heading and the state chip already say it (review round 5).
    expect(phoneFr['card.answerOnComputer']).not.toContain(phoneFr['console.needsYou']);
  });

  it('de/es/it name the key caps the key bar actually shows', () => {
    for (const d of [phoneDe, phoneEs, phoneIt]) expect(d['attach.altHint']).toContain('PgUp / PgDn');
  });

  it('"revoke all" reads right with one device in every language', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const s = DICTIONARIES[lang]?.['settings.remote.revokeAllConfirm'];
      if (!s) continue;
      expect(s, lang).toMatch(/[(（]\{count\}[)）]/);
    }
  });
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

describe('Settings → Remote (#254)', () => {
  it('a Control device on a plain-HTTP LAN bind reads as limited', () => {
    expect(deviceScopeKey({ scope: 'operator' }, { bind: 'lan', allowInsecureControl: false })).toBe('settings.remote.scope.operatorLimited');
    expect(deviceScopeKey({ scope: 'operator' }, { bind: 'lan', allowInsecureControl: true })).toBe('settings.remote.scope.operator');
    expect(deviceScopeKey({ scope: 'operator' }, { bind: 'loopback', allowInsecureControl: false })).toBe('settings.remote.scope.operator');
    expect(deviceScopeKey({ scope: 'viewer' }, { bind: 'lan', allowInsecureControl: false })).toBe('settings.remote.scope.viewer');
  });

  it('revoking one device asks first', async () => {
    const bridge = mountSettings(status());
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    const revoke = [...el.querySelectorAll('td button')].find((b) => b.textContent === 'Revoke') as HTMLButtonElement;
    act(() => { revoke.click(); });
    expect(bridge.revoke).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Revoke Pixel?');
    const confirm = [...el.querySelectorAll('.remote-settings__card--danger button')].find((b) => b.textContent === 'Revoke') as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    expect(bridge.revoke).toHaveBeenCalledWith('dev-1');
  });

  it('on a LAN bind the refused-origin card offers no "Use as Public URL"', async () => {
    const lan = status({
      config: { ...DEFAULT_REMOTE_CONFIG, enabled: true, bind: 'lan', lanHost: '192.0.2.5' },
      lastRejectedOrigin: 'https://pc.tail1234.ts.net',
    });
    mountSettings(lan);
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    expect(el.textContent).toContain('https://pc.tail1234.ts.net');
    expect(el.textContent).not.toContain('Use as Public URL');
  });

  it('on loopback it still does', async () => {
    mountSettings(status({ lastRejectedOrigin: 'https://pc.tail1234.ts.net' }));
    const el = render(createElement(RemoteConsoleSettings));
    await settle();
    expect(el.textContent).toContain('Use as Public URL');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DICTIONARIES, SUPPORTED_LANGUAGES, type TranslationKey } from '../../src/renderer/i18n';
import { en } from '../../src/renderer/i18n/locales/en';
import { DEFAULT_REMOTE_CONFIG } from '../../src/shared/remote-console-config';
import { fillTemplate, offerOutcome, remoteErrorText, requestOffer } from '../../src/renderer/components/Settings/PairDeviceDialog';
import { formatRemoteNotice } from '../../src/renderer/utils/remote-notice';
import { showsProxySetup, suggestedPublicUrl } from '../../src/renderer/components/Settings/RemoteConsoleSettings';

// Settings → Remote (#254). This tab is where a user decides whether wmux is
// reachable from another device and hands out credentials for it; an English
// fallback there is merely untidy, but a missing warning or a dropped
// placeholder ("Port  is already used") is the wrong sentence at the one
// moment the user is reading carefully. So every key ships in every language,
// and every placeholder the component substitutes survives translation.

const REMOTE_KEYS = (Object.keys(en) as TranslationKey[]).filter(
  (k) => k === 'settings.tab.remote' || k.startsWith('settings.remote.'),
);

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe('remote console translations', () => {
  it('defines the tab and a full settings.remote.* vocabulary in English', () => {
    expect(REMOTE_KEYS).toContain('settings.tab.remote');
    expect(REMOTE_KEYS.length).toBeGreaterThan(60);
  });

  it('ships every remote string, non-empty, in all 18 languages', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(18);
    const missing: string[] = [];
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = DICTIONARIES[lang];
      for (const key of REMOTE_KEYS) {
        const value = dict?.[key];
        if (typeof value !== 'string' || value.trim() === '') missing.push(`${lang}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every {placeholder} the tab substitutes at render', () => {
    const drift: string[] = [];
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = DICTIONARIES[lang];
      for (const key of REMOTE_KEYS) {
        const want = placeholders(en[key]).join();
        const got = placeholders(dict?.[key] ?? '').join();
        if (want !== got) drift.push(`${lang}:${key} has [${got}] want [${want}]`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('uses no remote key the English dictionary does not define', () => {
    // TranslationKey already makes a typo a compile error at a typed call site;
    // this catches the one untyped path — a key built as a string.
    const dir = join(__dirname, '../../src/renderer/components/Settings');
    const source = ['RemoteConsoleSettings.tsx', 'PairDeviceDialog.tsx', 'SettingsWindow.tsx']
      .map((f) => join(dir, f))
      // The desktop bells for pairing/connecting are worded in the renderer too.
      .concat(join(__dirname, '../../src/renderer/utils/remote-notice.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const used = new Set(source.match(/'settings\.(?:remote\.[\w.]+|tab\.remote)'/g)?.map((s) => s.slice(1, -1)));
    expect(used.size).toBeGreaterThan(0);
    const unknown = [...used].filter((k) => !(k in en));
    expect(unknown).toEqual([]);
    // And nothing defined for the tab is dead weight in 18 files.
    const unused = REMOTE_KEYS.filter((k) => !used.has(k));
    expect(unused).toEqual([]);
  });
});

// ── The dialog's and the tab's pure decisions (#254 review) ─────────────
// vitest runs in node with no React renderer, so the effects are reduced to
// plumbing around these helpers and the helpers are what gets pinned.

describe('fillTemplate', () => {
  it('substitutes values literally, even ones carrying $ patterns', () => {
    // A device name is whatever the phone POSTed; `String.replace` with a
    // string would expand $' into the template tail.
    expect(fillTemplate('Paired: {name}', { name: "$'x$&" })).toBe("Paired: $'x$&");
    expect(fillTemplate('{host}:{port} · {count}', { host: 'h', port: 9790, count: 2 })).toBe('h:9790 · 2');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(fillTemplate('a {missing} b', {})).toBe('a {missing} b');
  });
});

describe('offerOutcome', () => {
  const offer = { expiresAt: 5_000, offeredAt: 1_000, knownIds: new Set(['dev-old']) };
  const device = (id: string, createdAt: number) =>
    ({ id, name: `n-${id}`, scope: 'viewer' as const, createdAt, lastSeenAt: createdAt });

  it('reports the pairing when a new device appears after the offer', () => {
    const status = { devices: [device('dev-old', 10), device('dev-new', 1_500)], pairing: null };
    expect(offerOutcome(status, offer, true)).toEqual({ kind: 'paired', name: 'n-dev-new' });
  });

  it('ignores a device that predates the offer', () => {
    const status = { devices: [device('dev-x', 900)], pairing: { expiresAt: 5_000, scope: 'viewer' as const } };
    expect(offerOutcome(status, offer, false)).toEqual({ kind: 'live', sawLive: true });
  });

  it('does not call an offer voided before it has been seen', () => {
    expect(offerOutcome({ devices: [], pairing: null }, offer, false)).toEqual({ kind: 'live', sawLive: false });
    // A stale push still carrying the PREVIOUS offer is not this one.
    const stale = { devices: [], pairing: { expiresAt: 1_234, scope: 'viewer' as const } };
    expect(offerOutcome(stale, offer, false)).toEqual({ kind: 'live', sawLive: false });
  });

  it('calls it voided when pairing goes null after being seen', () => {
    expect(offerOutcome({ devices: [], pairing: null }, offer, true)).toEqual({ kind: 'voided' });
  });

  it('calls it voided when another window superseded it with a newer offer', () => {
    const newer = { devices: [], pairing: { expiresAt: 9_000, scope: 'operator' as const } };
    expect(offerOutcome(newer, offer, true)).toEqual({ kind: 'voided' });
  });
});

describe('requestOffer', () => {
  const OFFER = { url: 'http://127.0.0.1:9790/#pair=s', expiresAt: 1, scope: 'viewer' as const };

  it('returns the offer while the dialog is open', async () => {
    const pairCancel = vi.fn(async () => undefined);
    const r = await requestOffer({ pairStart: async () => OFFER, pairCancel }, { name: 'P', scope: 'viewer' }, () => false);
    expect(r).toBe(OFFER);
    expect(pairCancel).not.toHaveBeenCalled();
  });

  it('cancels in main an offer that arrives after the dialog closed', async () => {
    let closed = false;
    const pairCancel = vi.fn(async () => undefined);
    const pairStart = async () => { closed = true; return OFFER; };
    const r = await requestOffer({ pairStart, pairCancel }, { name: 'P', scope: 'viewer' }, () => closed);
    expect(r).toBeNull();
    expect(pairCancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel when main refused to mint', async () => {
    const pairCancel = vi.fn(async () => undefined);
    const r = await requestOffer({ pairStart: async () => ({ error: 'x' }), pairCancel }, { name: 'P', scope: 'viewer' }, () => true);
    expect(r).toBeNull();
    expect(pairCancel).not.toHaveBeenCalled();
  });
});

describe('showsProxySetup (#254)', () => {
  it('the Public URL row and the Tailscale / SSH recipes are loopback-only', () => {
    expect(showsProxySetup('loopback')).toBe(true);
    expect(showsProxySetup('lan')).toBe(false);
  });
});

describe('suggestedPublicUrl', () => {
  const config = { ...DEFAULT_REMOTE_CONFIG, publicUrl: 'https://mine.ts.net' };

  it('offers a well-formed refused origin that is not already set', () => {
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: 'https://pc.tailnet.ts.net' })).toBe('https://pc.tailnet.ts.net');
  });

  it('offers nothing for the current Public URL, null, or a non-origin', () => {
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: 'https://mine.ts.net' })).toBeNull();
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: null })).toBeNull();
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: 'null' })).toBeNull();
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: 'chrome-extension://abc' })).toBeNull();
    expect(suggestedPublicUrl({ config, lastRejectedOrigin: 'https://a.example/path' })).toBeNull();
  });

  it('shows the caution beside the button', () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/components/Settings/RemoteConsoleSettings.tsx'), 'utf8');
    expect(src).toContain("t('settings.remote.rejectedOriginCaution')");
  });
});

describe('remoteErrorText (#254 review)', () => {
  const tr = (lang: string) => (key: TranslationKey) => (DICTIONARIES[lang]?.[key] ?? en[key]) as string;

  it('words every error Settings can receive, never the raw slug', () => {
    for (const code of ['device-cap', 'not-running', 'write-failed', 'failed', 'bad-port', 'unavailable']) {
      for (const lang of ['en', 'fr', 'ja']) {
        const text = remoteErrorText(tr(lang), code);
        expect(text, `${lang}:${code}`).not.toContain(code);
        expect(text).not.toBe(tr(lang)('settings.remote.actionFailed'));
      }
    }
    expect(remoteErrorText(tr('en'), 'device-cap')).toMatch(/revoke/i);
  });
});

describe('formatRemoteNotice (#254 review)', () => {
  const tr = (lang: string) => (key: TranslationKey) => (DICTIONARIES[lang]?.[key] ?? en[key]) as string;

  it('words the bell in the UI language and names the scope the way Settings does', () => {
    const fr = formatRemoteNotice(['paired', 'Pixel', 'operator'], tr('fr'));
    expect(fr).toContain('Pixel');
    expect(fr).toContain(tr('fr')('settings.remote.scope.operator'));
    expect(fr).not.toMatch(/operator|Paired/);
    expect(formatRemoteNotice(['connected', 'Pixel', 'viewer'], tr('en'))).toBe('Remote console: Pixel connected');
  });

  it('words nothing for args it does not recognise', () => {
    expect(formatRemoteNotice(['hacked', 'x', 'operator'], tr('en'))).toBeNull();
    expect(formatRemoteNotice(['paired', 'x', 'root'], tr('en'))).toBeNull();
    expect(formatRemoteNotice('paired', tr('en'))).toBeNull();
  });

  it('keeps a $ pattern in a device name literal', () => {
    expect(formatRemoteNotice(['connected', "$'x", 'viewer'], tr('en'))).toBe("Remote console: $'x connected");
  });
});

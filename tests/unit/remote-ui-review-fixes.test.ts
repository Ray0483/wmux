import { describe, it, expect } from 'vitest';
import { takePairFragment, watchPairFragment } from '../../src/renderer/remote/pair-fragment';
import { forgetDeviceStorage, logoutUnpaired, type ListableStorage } from '../../src/renderer/remote/device-storage';
import { AnswerGate, ANSWER_ECHO_MS } from '../../src/renderer/remote/answer-gate';
import { alertState, type AlertEnv } from '../../src/renderer/remote/screens/PrefsScreen';
import { attachTitle } from '../../src/renderer/remote/screens/attach-title';
import { REMOTE_LANGUAGES, createT } from '../../src/renderer/remote/i18n';
import { DICTIONARIES } from '../../src/renderer/i18n';

const SECRET = 'AGNpF5goe4R5_tDFCkNSEbZL23k17UrDLu7Z7lDVTI4';

function fakeWindow(hash = '') {
  const loc = { hash, pathname: '/' };
  const replaced: string[] = [];
  const hist = {
    replaceState: (_d: unknown, _u: string, url: string) => {
      replaced.push(url);
      loc.hash = '';
    },
  };
  let listener: (() => void) | null = null;
  const target = {
    addEventListener: (_t: 'hashchange', cb: () => void) => { listener = cb; },
    removeEventListener: () => { listener = null; },
  };
  const navigate = (h: string) => { loc.hash = h; listener?.(); };
  return { loc, hist, target, replaced, navigate };
}

describe('pairing fragment (#254, I5)', () => {
  it('scrubs any fragment and returns only a well-formed secret', () => {
    const w = fakeWindow(`#pair=${SECRET}`);
    expect(takePairFragment(w.loc, w.hist)).toBe(SECRET);
    expect(w.replaced).toEqual(['/']);
    const junk = fakeWindow('#pair=<script>');
    expect(takePairFragment(junk.loc, junk.hist)).toBeNull();
    expect(junk.replaced).toEqual(['/']);
    expect(takePairFragment(fakeWindow('').loc, fakeWindow('').hist)).toBeNull();
  });

  it('a #pair= link pasted into an already-open tab is scrubbed at once and reaches the app', () => {
    // Same-document navigation: no reload, so main.tsx's startup scrub never runs again.
    const w = fakeWindow();
    const source = watchPairFragment(w.target, w.loc, w.hist);
    const got: string[] = [];
    source.subscribe((s) => got.push(s));
    w.navigate(`#pair=${SECRET}`);
    expect(w.loc.hash).toBe('');
    expect(w.replaced).toEqual(['/']);
    expect(got).toEqual([SECRET]);
  });

  it('holds a secret that arrived before the app subscribed', () => {
    const w = fakeWindow();
    const source = watchPairFragment(w.target, w.loc, w.hist);
    w.navigate(`#pair=${SECRET}`);
    expect(w.loc.hash).toBe('');
    const got: string[] = [];
    source.subscribe((s) => got.push(s));
    expect(got).toEqual([SECRET]);
  });
});

function memStorage(entries: Record<string, string>): ListableStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
  };
}

describe('forgetting this device (#254)', () => {
  it('sweeps drafts and fit modes from both storages, and leaves the prefs', () => {
    const local = memStorage({ 'wmux-remote-draft:surf-a': 'hunter2', 'wmux-remote-fit:surf-a': 'pan', 'wmux-remote-prefs': '{}' });
    const session = memStorage({ 'wmux-remote-draft:surf-b': 'sudo password', other: 'x' });
    forgetDeviceStorage([local, null, session]);
    expect([...local.data.keys()]).toEqual(['wmux-remote-prefs']);
    expect([...session.data.keys()]).toEqual(['other']);
  });

  it('a storage that throws does not throw out of the sweep', () => {
    const boom: ListableStorage = { get length(): number { throw new Error('SecurityError'); }, key: () => null, removeItem: () => undefined };
    expect(() => forgetDeviceStorage([boom])).not.toThrow();
  });

  it('only a 200 or a 401 from /api/logout means unpaired; no answer means still paired', () => {
    expect(logoutUnpaired(200)).toBe(true);
    expect(logoutUnpaired(401)).toBe(true);
    expect(logoutUnpaired(null)).toBe(false);
    expect(logoutUnpaired(503)).toBe(false);
    expect(logoutUnpaired(403)).toBe(false);
  });
});

describe('answer gate (#254)', () => {
  it('drops a second tap while the first answer is in flight', () => {
    const g = new AnswerGate();
    expect(g.begin('s1')).toBe(true);
    expect(g.begin('s1')).toBe(false);
    expect(g.begin('s2')).toBe(true);
    g.settle('s1', true, 0);
    expect(g.begin('s1')).toBe(true);
  });

  it('a "nothing to answer" right after our own success is not an error; later, or after a failure, it is', () => {
    const g = new AnswerGate();
    g.begin('s1');
    g.settle('s1', true, 1000);
    expect(g.shouldReport('s1', 'no-choices', 1500)).toBe(false);
    expect(g.shouldReport('s1', 'not-blocked', 1500)).toBe(false);
    expect(g.shouldReport('s1', 'rate', 1500)).toBe(true);
    expect(g.shouldReport('s1', 'no-choices', 1000 + ANSWER_ECHO_MS + 1)).toBe(true);
    expect(g.shouldReport('s2', 'no-choices', 1500)).toBe(true);
  });
});

describe('system alerts state (#254)', () => {
  class Throws { static readonly permission: NotificationPermission = 'default'; constructor() { throw new TypeError('Illegal constructor'); } }
  class Works { static readonly permission: NotificationPermission = 'granted'; }
  const env = (over: Partial<AlertEnv>): AlertEnv => ({
    isSecureContext: true, Notification: Works as unknown as AlertEnv['Notification'], userAgent: 'Mozilla/5.0 (Windows NT 10.0)', ...over,
  });

  it('Android Chrome is never "on": its Notification constructor needs a service worker', () => {
    expect(alertState(env({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129' }))).toBe('unsupported');
  });

  it('a constructor that throws (probed only without a grant) is unsupported', () => {
    expect(alertState(env({ Notification: Throws as unknown as AlertEnv['Notification'] }))).toBe('unsupported');
  });

  it('iOS Safari over HTTPS is "unsupported", not "needs HTTPS"; plain http is "insecure"', () => {
    expect(alertState(env({ Notification: undefined }))).toBe('unsupported');
    expect(alertState(env({ isSecureContext: false }))).toBe('insecure');
  });

  it('a desktop browser with a grant is on', () => {
    expect(alertState(env({}))).toBe('on');
  });
});

describe('attach header (#254)', () => {
  const t = createT('en');
  it('keeps the last label once the pane closes, and never shows a raw surface id', () => {
    expect(attachTitle('claude · api', null, t)).toBe('claude · api');
    expect(attachTitle(undefined, 'claude · api', t)).toBe('claude · api');
    expect(attachTitle(undefined, null, t)).toBe('Closed terminal');
  });
});

describe('"Not paired" instructions name the real desktop menu (#254)', () => {
  it('each language quotes its own Settings, Remote tab and Pair button labels', () => {
    const wrong: string[] = [];
    for (const { code, dict } of REMOTE_LANGUAGES) {
      const desk = DICTIONARIES[code as keyof typeof DICTIONARIES] as Record<string, string> | undefined;
      const body = dict['unpaired.body'];
      for (const key of ['settings.title', 'settings.tab.remote', 'settings.remote.pair']) {
        const label = desk?.[key];
        if (!label || !body.includes(label)) wrong.push(`${code}: ${key} = ${label}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

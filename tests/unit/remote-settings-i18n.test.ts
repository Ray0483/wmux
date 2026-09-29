import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DICTIONARIES, SUPPORTED_LANGUAGES, type TranslationKey } from '../../src/renderer/i18n';
import { en } from '../../src/renderer/i18n/locales/en';

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
      .map((f) => readFileSync(join(dir, f), 'utf8'))
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

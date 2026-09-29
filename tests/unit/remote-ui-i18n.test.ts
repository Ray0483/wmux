import { describe, it, expect } from 'vitest';
import {
  REMOTE_LANGUAGES,
  createT,
  format,
  matchLanguage,
  relativeTime,
  translatePlural,
  PLURAL_CATEGORIES,
} from '../../src/renderer/remote/i18n';
import { en } from '../../src/renderer/remote/i18n/messages/en';

const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join('|')})$`);
const baseOf = (k: string) => k.replace(PLURAL_SUFFIX, '');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b));

const enKeys = Object.keys(en);
const enBases = new Set(enKeys.map(baseOf));
const pluralBases = new Set(enKeys.filter((k) => k.endsWith('_other')).map(baseOf));

describe('remote i18n', () => {
  it('bundles the same 18 languages as the desktop', () => {
    expect(REMOTE_LANGUAGES.map((l) => l.code).sort((a, b) => a.localeCompare(b))).toEqual(
      ['cs', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'uk', 'zh', 'zh-TW'],
    );
  });

  for (const { code, dict } of REMOTE_LANGUAGES) {
    describe(code, () => {
      const keys = Object.keys(dict);

      it('has exactly the English keys (plural variants folded)', () => {
        expect(new Set(keys.map(baseOf))).toEqual(enBases);
        for (const k of keys) {
          if (PLURAL_SUFFIX.test(k)) expect(pluralBases.has(baseOf(k))).toBe(true);
          else expect(Object.hasOwn(en, k)).toBe(true);
        }
      });

      it('carries every plural category Intl selects for it, and no foreign one', () => {
        const rules = new Intl.PluralRules(code);
        const allowed = new Set(rules.resolvedOptions().pluralCategories);
        const used = new Set<string>();
        for (let n = 0; n <= 200; n++) used.add(rules.select(n));
        for (const base of pluralBases) {
          for (const cat of used) expect(keys, `${code} ${base}_${cat}`).toContain(`${base}_${cat}`);
          expect(keys).toContain(`${base}_other`);
        }
        for (const k of keys.filter((x) => PLURAL_SUFFIX.test(x))) {
          expect(allowed.has(k.match(PLURAL_SUFFIX)![1] as Intl.LDMLPluralRule)).toBe(true);
        }
      });

      it('keeps the same placeholders and no empty strings', () => {
        for (const k of keys) {
          expect(dict[k].trim().length, `${code} ${k}`).toBeGreaterThan(0);
          const src = (en as Record<string, string>)[k] ?? (en as Record<string, string>)[`${baseOf(k)}_other`];
          expect(placeholders(dict[k]), `${code} ${k}`).toEqual(placeholders(src));
        }
      });

      if (code !== 'en') {
        it('is a real translation, not a copy of English', () => {
          const same = keys.filter((k) => dict[k] === (en as Record<string, string>)[k]);
          // A handful of strings legitimately coincide (e.g. "Offline", "System").
          expect(same.length, `${code}: ${same.join(', ')}`).toBeLessThan(keys.length * 0.1);
        });
      }
    });
  }

  it('matches navigator languages, folding regions except for Chinese script', () => {
    expect(matchLanguage(['fr-FR', 'en'])).toBe('fr');
    expect(matchLanguage(['pt-BR'])).toBe('pt');
    expect(matchLanguage(['zh-TW'])).toBe('zh-TW');
    expect(matchLanguage(['zh-Hant-HK'])).toBe('zh-TW');
    expect(matchLanguage(['zh-CN'])).toBe('zh');
    expect(matchLanguage(['zh'])).toBe('zh');
    expect(matchLanguage(['xx-YY', 'de-AT'])).toBe('de');
    expect(matchLanguage(['xx'])).toBe('en');
    expect(matchLanguage([])).toBe('en');
  });

  it('formats placeholders as text and leaves unknown ones visible', () => {
    expect(format('{a} and {b}', { a: '<b>x</b>' })).toBe('<b>x</b> and {b}');
    expect(createT('fr').t('toast.done', { label: 'build' })).toBe('build a terminé');
  });

  it('selects plural forms through Intl.PluralRules', () => {
    expect(translatePlural('en', 'console.needsYouCount', 1)).toBe('1 agent needs you');
    expect(translatePlural('en', 'console.needsYouCount', 3)).toBe('3 agents need you');
    expect(translatePlural('ru', 'console.needsYouCount', 2)).toBe('2 агента ждут вас');
    expect(translatePlural('ru', 'console.needsYouCount', 5)).toBe('5 агентов ждут вас');
    expect(translatePlural('pl', 'console.needsYouCount', 22)).toBe('22 agenty czekają na ciebie');
    expect(translatePlural('ja', 'console.needsYouCount', 1)).toContain('1');
  });

  it('formats relative times through Intl.RelativeTimeFormat', () => {
    expect(relativeTime('en', 3 * 60_000)).toMatch(/3 min/);
    expect(relativeTime('en', 2 * 3_600_000)).toMatch(/2 h/);
    expect(relativeTime('fr', 3 * 60_000)).toMatch(/3/);
    expect(relativeTime('en', -5)).toBe('');
    expect(relativeTime('en', Number.NaN)).toBe('');
  });
});

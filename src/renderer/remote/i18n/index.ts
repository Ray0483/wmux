/**
 * The phone console's own i18n (#254).
 *
 * Deliberately NOT `src/renderer/i18n`: that module's `useT` reads the desktop
 * Zustand store, and importing it would drag the store — and with it the whole
 * desktop renderer — into a page served to a phone. The isolation test pins
 * the boundary. What is shared is the language LIST (the same 18 bundled
 * languages), so a user who reads wmux in Polish on the desktop reads it in
 * Polish on the phone.
 *
 * Plurals and relative times come from `Intl.PluralRules` and
 * `Intl.RelativeTimeFormat` rather than hand-written rules: Czech, Polish,
 * Russian and Ukrainian have four plural categories, and getting "3 minuty"
 * vs "5 minut" right by hand in 18 languages is how translations rot.
 */

import type { AckCode, RemoteAgentState } from '../../../shared/remote-console-protocol';
import { en, type RemoteMessageKey } from './messages/en';
import { cs } from './messages/cs';
import { de } from './messages/de';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { hi } from './messages/hi';
import { it } from './messages/it';
import { ja } from './messages/ja';
import { ko } from './messages/ko';
import { nl } from './messages/nl';
import { pl } from './messages/pl';
import { pt } from './messages/pt';
import { ru } from './messages/ru';
import { sv } from './messages/sv';
import { tr } from './messages/tr';
import { uk } from './messages/uk';
import { zh } from './messages/zh';
import { zhTW } from './messages/zh-TW';

export type RemoteDictionary = Readonly<Record<string, string>>;

/** Order and labels follow the desktop dropdown (src/renderer/i18n/core.ts). */
export const REMOTE_LANGUAGES = [
  { code: 'en', label: 'English', dict: en as RemoteDictionary },
  { code: 'fr', label: 'Français', dict: fr },
  { code: 'es', label: 'Español', dict: es },
  { code: 'de', label: 'Deutsch', dict: de },
  { code: 'pt', label: 'Português', dict: pt },
  { code: 'it', label: 'Italiano', dict: it },
  { code: 'nl', label: 'Nederlands', dict: nl },
  { code: 'pl', label: 'Polski', dict: pl },
  { code: 'tr', label: 'Türkçe', dict: tr },
  { code: 'ru', label: 'Русский', dict: ru },
  { code: 'uk', label: 'Українська', dict: uk },
  { code: 'cs', label: 'Čeština', dict: cs },
  { code: 'sv', label: 'Svenska', dict: sv },
  { code: 'ja', label: '日本語', dict: ja },
  { code: 'ko', label: '한국어', dict: ko },
  { code: 'zh', label: '简体中文', dict: zh },
  { code: 'zh-TW', label: '繁體中文', dict: zhTW },
  { code: 'hi', label: 'हिन्दी', dict: hi },
] as const;

export type RemoteLang = (typeof REMOTE_LANGUAGES)[number]['code'];

const BY_CODE: ReadonlyMap<string, RemoteDictionary> = new Map(
  REMOTE_LANGUAGES.map((l) => [l.code, l.dict as RemoteDictionary]),
);

export function isRemoteLang(v: unknown): v is RemoteLang {
  return typeof v === 'string' && BY_CODE.has(v);
}

/** Traditional-script Chinese regions; everything else `zh` is Simplified. */
const TRADITIONAL = /^zh-(tw|hk|mo|hant)/;

/**
 * The first browser language we bundle, else English. Region subtags fold to
 * the language (`pt-BR` → `pt`) except for Chinese, where the region or script
 * picks the SCRIPT and is the whole point.
 */
export function matchLanguage(preferred: readonly string[]): RemoteLang {
  for (const raw of preferred) {
    if (typeof raw !== 'string' || !raw) continue;
    const tag = raw.toLowerCase();
    if (tag.startsWith('zh')) return TRADITIONAL.test(tag) ? 'zh-TW' : 'zh';
    const primary = tag.split('-')[0];
    if (isRemoteLang(primary)) return primary;
  }
  return 'en';
}

/** `{name}` → vars.name; an unknown placeholder is left visible rather than blanked. */
export function format(template: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return template;
  return template.replaceAll(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

type PluralBase = RemoteMessageKey extends infer K
  ? K extends `${infer B}_other` ? B : never
  : never;

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

function lookup(lang: RemoteLang, key: string): string | undefined {
  return BY_CODE.get(lang)?.[key] ?? (en as RemoteDictionary)[key];
}

export function translate(lang: RemoteLang, key: RemoteMessageKey, vars?: Readonly<Record<string, string | number>>): string {
  return format(lookup(lang, key) ?? key, vars);
}

function pluralCategory(lang: RemoteLang, n: number): string {
  try {
    return new Intl.PluralRules(lang).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/** `{n}` is always available to a plural template. Falls back to `_other`, then to English. */
export function translatePlural(
  lang: RemoteLang,
  base: PluralBase,
  n: number,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const dict = BY_CODE.get(lang);
  const cat = pluralCategory(lang, n);
  const template = dict?.[`${base}_${cat}`] ?? dict?.[`${base}_other`] ?? (en as RemoteDictionary)[`${base}_other`] ?? base;
  return format(template, { n, ...vars });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the user's language ("3 min ago", "il y a 3 min").
 * Empty when the runtime has no RelativeTimeFormat — a missing age is better
 * than an English one in a Korean UI.
 */
export function relativeTime(lang: RemoteLang, elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '';
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (elapsedMs < MINUTE) { value = Math.floor(elapsedMs / 1000); unit = 'second'; }
  else if (elapsedMs < HOUR) { value = Math.floor(elapsedMs / MINUTE); unit = 'minute'; }
  else if (elapsedMs < DAY) { value = Math.floor(elapsedMs / HOUR); unit = 'hour'; }
  else { value = Math.floor(elapsedMs / DAY); unit = 'day'; }
  try {
    return new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' }).format(-value, unit);
  } catch {
    return '';
  }
}

export interface RemoteT {
  lang: RemoteLang;
  t(key: RemoteMessageKey, vars?: Readonly<Record<string, string | number>>): string;
  tn(base: PluralBase, n: number, vars?: Readonly<Record<string, string | number>>): string;
  ago(elapsedMs: number): string;
}

export function createT(lang: RemoteLang): RemoteT {
  return {
    lang,
    t: (key, vars) => translate(lang, key, vars),
    tn: (base, n, vars) => translatePlural(lang, base, n, vars),
    ago: (ms) => relativeTime(lang, ms),
  };
}

const ACK_KEYS: Readonly<Record<AckCode, RemoteMessageKey>> = {
  forbidden: 'ack.forbidden',
  rate: 'ack.rate',
  gone: 'ack.gone',
  // A confirm is never shown as an error — it opens a sheet or arms a key —
  // but the table is exhaustive over AckCode so a new code cannot go unworded.
  confirm: 'ack.writeFailed',
  'not-blocked': 'ack.notBlocked',
  'no-choices': 'ack.noChoices',
  'unknown-choice': 'ack.unknownChoice',
  'too-long': 'ack.tooLong',
  'bad-key': 'ack.badKey',
  'write-failed': 'ack.writeFailed',
};

export function ackMessageKey(code: AckCode | undefined): RemoteMessageKey {
  return code ? ACK_KEYS[code] : 'ack.writeFailed';
}

/**
 * The word a card shows for its state. `unknown` has NONE (#235): it means "an
 * agent is here and has not said what it is doing", and printing "Unknown" on
 * it was exactly the desktop sidebar bug that issue fixed.
 */
export function stateWordKey(state: RemoteAgentState): RemoteMessageKey | null {
  switch (state) {
    case 'blocked': return 'console.needsYou';
    case 'working': return 'console.working';
    case 'idle': return 'console.idle';
    default: return null;
  }
}

export type { RemoteMessageKey };

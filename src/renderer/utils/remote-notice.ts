/**
 * Words a Remote Console desktop bell (#254). Main sends the facts of a
 * `remote_notice` — kind, device name, scope — because only the renderer knows
 * the UI language; the scope is named the way Settings → Remote names it
 * ("Control" / "View only"), never as the internal `operator`/`viewer`.
 *
 * The args came over IPC from main and are checked like anything else that
 * crossed a process boundary: an unknown kind or scope words nothing.
 */

import type { TranslationKey } from '../i18n';

type Translate = (key: TranslationKey, fallback?: string) => string;

const KIND_KEYS: Readonly<Record<string, TranslationKey>> = {
  paired: 'settings.remote.notice.paired',
  connected: 'settings.remote.notice.connected',
};

const SCOPE_KEYS: Readonly<Record<string, TranslationKey>> = {
  operator: 'settings.remote.scope.operator',
  viewer: 'settings.remote.scope.viewer',
};

/** Same function-replacer substitution as Settings: a device name is chosen by the phone, `$&` must stay literal. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : whole));
}

export function formatRemoteNotice(args: unknown, t: Translate): string | null {
  if (!Array.isArray(args)) return null;
  const [kind, name, scope] = args as unknown[];
  if (typeof kind !== 'string' || typeof name !== 'string' || typeof scope !== 'string') return null;
  const kindKey = KIND_KEYS[kind];
  const scopeKey = SCOPE_KEYS[scope];
  if (!kindKey || !scopeKey) return null;
  return fill(t(kindKey), { name, scope: t(scopeKey) });
}

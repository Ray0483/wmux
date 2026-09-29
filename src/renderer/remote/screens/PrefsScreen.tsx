/**
 * Phone-side preferences (#254): language, theme, text size, alerts, and
 * "Forget this device".
 *
 * These live in this browser's localStorage and nowhere else — they are about
 * how THIS phone renders, not about wmux, and the desktop never needs to know.
 * Every access is in try/catch (private mode, blocked site data) and a failure
 * just means the defaults.
 *
 * The limitations line is deliberate honesty: with no service worker and no
 * Web Push in 2.15.0, a closed page receives nothing, and iOS Safari has no
 * `navigator.vibrate`. Saying so beats a user trusting an alert that cannot come.
 */

import { useState } from 'react';
import { REMOTE_LANGUAGES, isRemoteLang, type RemoteLang, type RemoteT } from '../i18n';
import type { RemoteScope } from '../../../shared/remote-console-protocol';
import { ConfirmSheet } from '../components/ConfirmSheet';
import type { WsStatus } from '../ws-client';
import { connKey } from './ConsoleScreen';

export type ThemePref = 'system' | 'light' | 'dark';

export interface RemotePrefs {
  lang: 'auto' | RemoteLang;
  theme: ThemePref;
  fontScale: number;
}

export const DEFAULT_PREFS: RemotePrefs = { lang: 'auto', theme: 'system', fontScale: 1 };
export const FONT_SCALES = [0.85, 1, 1.15, 1.3] as const;
const PREFS_KEY = 'wmux-remote-prefs';

export function loadPrefs(): RemotePrefs {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFS;
    const o = raw as Record<string, unknown>;
    return {
      lang: o.lang === 'auto' || isRemoteLang(o.lang) ? o.lang : 'auto',
      theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : 'system',
      fontScale: FONT_SCALES.includes(o.fontScale as (typeof FONT_SCALES)[number]) ? (o.fontScale as number) : 1,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: RemotePrefs): void {
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* defaults next time */ }
}

/**
 * `insecure` and `unsupported` are different problems with different fixes:
 * the first needs an https address, the second is this browser (iOS Safari
 * outside a home-screen app has no `Notification` even over https; Android
 * Chrome has one whose constructor throws without a service worker, which this
 * page does not have). Telling an iPhone already on Tailscale HTTPS to "use
 * HTTPS", or an Android user that alerts are "on", was wrong both times.
 */
export type AlertState = 'on' | 'off' | 'denied' | 'insecure' | 'unsupported';

export interface AlertEnv {
  isSecureContext: boolean;
  Notification: { readonly permission: NotificationPermission; new (title: string): unknown } | undefined;
  userAgent: string;
}

/** Can `new Notification()` show anything here? Probed only while nothing could be shown by it. */
function constructible(env: AlertEnv): boolean {
  const N = env.Notification;
  if (!N) return false;
  // Android browsers only show notifications through a service worker.
  if (/Android/i.test(env.userAgent)) return false;
  if (N.permission === 'granted') return true;
  try {
    // Without a grant this shows nothing; it only tells whether it would throw.
    new N('');
  } catch (err) {
    if (err instanceof TypeError) return false;
  }
  return true;
}

export function alertState(env: AlertEnv): AlertState {
  // A Notification needs a secure context: a LAN bind over plain http never has one.
  if (!env.isSecureContext) return 'insecure';
  if (!constructible(env)) return 'unsupported';
  const permission = env.Notification?.permission;
  if (permission === 'granted') return 'on';
  return permission === 'denied' ? 'denied' : 'off';
}

function currentAlertState(): AlertState {
  return alertState({
    isSecureContext: globalThis.isSecureContext === true,
    Notification: typeof Notification === 'undefined' ? undefined : Notification,
    userAgent: globalThis.navigator?.userAgent ?? '',
  });
}

/**
 * The host line: "Connected to {host}" only while the socket is up. Otherwise
 * the bare host, beside the chip that says Reconnecting… or Offline — the
 * offline Forget path used to print "Could not reach your computer" under a
 * line claiming a connection.
 */
export function prefsHostLine(t: RemoteT, host: string, status: WsStatus): string {
  return status === 'ready' ? t.t('prefs.connectedTo', { host }) : host;
}

interface Props {
  t: RemoteT;
  prefs: RemotePrefs;
  host: string;
  status: WsStatus;
  device: { name: string; scope: RemoteScope } | null;
  effectiveScope: RemoteScope;
  onChange(p: RemotePrefs): void;
  onBack(): void;
  onForget(): void;
}

export function PrefsScreen({ t, prefs, host, status, device, effectiveScope, onChange, onBack, onForget }: Readonly<Props>) {
  const [alerts, setAlerts] = useState<AlertState>(currentAlertState);
  const [confirmForget, setConfirmForget] = useState(false);

  const enableAlerts = () => {
    // Asked only from this click — a permission prompt on page load is the
    // pattern every browser now quietly auto-denies.
    Notification.requestPermission().then(() => setAlerts(currentAlertState()), () => setAlerts(currentAlertState()));
  };

  const alertText: Record<Exclude<AlertState, 'off'>, string> = {
    on: t.t('prefs.alertsOn'),
    denied: t.t('prefs.alertsDenied'),
    insecure: t.t('prefs.alertsUnavailable'),
    unsupported: t.t('prefs.alertsUnsupported'),
  };

  return (
    <main className="rc-screen rc-prefs">
      <header className="rc-bar">
        <button type="button" className="rc-bar__btn" onClick={onBack} aria-label={t.t('common.back')}>‹</button>
        <h1 className="rc-bar__title">{t.t('common.settings')}</h1>
        <span className={`rc-chip rc-chip--${status}`}>{t.t(connKey(status))}</span>
      </header>

      <div className="rc-prefs__body">
        <section className="rc-prefs__section">
          <p className="rc-prefs__line">{prefsHostLine(t, host, status)}</p>
          {device && <p className="rc-prefs__line">{t.t('prefs.device', { name: device.name })}</p>}
          <p className="rc-prefs__line rc-prefs__muted">
            {effectiveScope === 'operator' ? t.t('prefs.scopeOperator') : t.t('prefs.scopeViewer')}
          </p>
          {/* Paired with Control, narrowed by a plain-HTTP bind: say why. */}
          {device?.scope === 'operator' && effectiveScope !== 'operator' && (
            <p className="rc-prefs__line">{t.t('console.controlLimited')}</p>
          )}
        </section>

        <label className="rc-field">
          <span className="rc-field__label">{t.t('prefs.language')}</span>
          <select
            className="rc-field__input"
            value={prefs.lang}
            onChange={(e) => onChange({ ...prefs, lang: e.target.value as RemotePrefs['lang'] })}
          >
            <option value="auto">{t.t('prefs.languageAuto')}</option>
            {REMOTE_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>

        <fieldset className="rc-field rc-seg">
          <legend className="rc-field__label">{t.t('prefs.theme')}</legend>
          {(['system', 'light', 'dark'] as const).map((th) => {
            const labelKey = { system: 'prefs.themeSystem', light: 'prefs.themeLight', dark: 'prefs.themeDark' } as const;
            return (
              <button
                key={th}
                type="button"
                className={prefs.theme === th ? 'rc-seg__btn rc-seg__btn--on' : 'rc-seg__btn'}
                aria-pressed={prefs.theme === th}
                onClick={() => onChange({ ...prefs, theme: th })}
              >
                {t.t(labelKey[th])}
              </button>
            );
          })}
        </fieldset>

        <fieldset className="rc-field rc-seg">
          <legend className="rc-field__label">{t.t('prefs.fontScale')}</legend>
          {FONT_SCALES.map((sc) => (
            <button
              key={sc}
              type="button"
              className={prefs.fontScale === sc ? 'rc-seg__btn rc-seg__btn--on' : 'rc-seg__btn'}
              aria-pressed={prefs.fontScale === sc}
              // The visible "A" differs only in size, which a screen reader
              // cannot hear: four buttons all named "A" told nothing apart.
              aria-label={t.t('prefs.fontScaleN', { pct: Math.round(sc * 100) })}
              style={{ fontSize: `${Math.round(14 * sc)}px` }}
              onClick={() => onChange({ ...prefs, fontScale: sc })}
            >
              A
            </button>
          ))}
        </fieldset>

        <section className="rc-prefs__section">
          <h2 className="rc-field__label">{t.t('prefs.alerts')}</h2>
          {alerts === 'off'
            ? <button type="button" className="rc-btn" onClick={enableAlerts}>{t.t('prefs.enableAlerts')}</button>
            : <p className="rc-prefs__line">{alertText[alerts]}</p>}
          <p className="rc-prefs__line rc-prefs__muted">{t.t('prefs.limits')}</p>
        </section>

        <button type="button" className="rc-btn rc-btn--danger rc-prefs__forget" onClick={() => setConfirmForget(true)}>
          {t.t('prefs.forget')}
        </button>
      </div>

      {confirmForget && (
        <ConfirmSheet
          title={t.t('prefs.forgetTitle')}
          body={t.t('prefs.forgetBody')}
          okLabel={t.t('prefs.forget')}
          cancelLabel={t.t('common.cancel')}
          danger
          onOk={() => { setConfirmForget(false); onForget(); }}
          onCancel={() => setConfirmForget(false)}
        />
      )}
    </main>
  );
}

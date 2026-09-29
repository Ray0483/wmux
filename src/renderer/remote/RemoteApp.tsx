/**
 * The phone console's top level (#254): which screen, and the one socket.
 *
 *   pairing secret in the fragment ─▶ PairScreen ─POST /api/pair─▶ 200: reload · 410: Expired
 *   otherwise ─GET /api/session─▶ 401: Unpaired · 200: connect ─▶ Console ⇄ Attach ⇄ Prefs
 *   close 4401 or a `revoked` frame ─▶ Revoked      close 4400 ─▶ Incompatible (reload)
 *
 * The cookie is HttpOnly, so this page never sees its own credential — it
 * learns whether it is paired only by asking `/api/session`, and pairing ends
 * in a RELOAD rather than a state change so the next page load starts from
 * that same single source of truth.
 *
 * Roster and toasts are React state (they change at human speed, coalesced by
 * the server). Terminal bytes are not: TermView subscribes to the client
 * directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_TEXT, type RemoteRosterEntry, type RemoteScope, type ServerMessage } from '../../shared/remote-console-protocol';
import { ackMessageKey, createT, matchLanguage, type RemoteT } from './i18n';
import { createBrowserWsClient, newNonce, type WelcomeMessage, type WsClient, type WsStatus } from './ws-client';
import { NoticeScreen, PairScreen } from './screens/PairScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { AttachScreen } from './screens/AttachScreen';
import { PrefsScreen, loadPrefs, savePrefs, type RemotePrefs } from './screens/PrefsScreen';
import { Toasts, type Toast, type ToastInput } from './components/Toasts';

interface SessionInfo {
  scope: RemoteScope;
  effectiveScope: RemoteScope;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'pair'; secret: string; busy: boolean; failed: boolean }
  | { kind: 'expired' }
  | { kind: 'unpaired' }
  | { kind: 'revoked' }
  | { kind: 'incompatible' }
  | { kind: 'unreachable' }
  | { kind: 'console'; session: SessionInfo };

type View = { screen: 'list' } | { screen: 'attach'; s: string } | { screen: 'prefs' };

type SessionResult = { kind: 'ok'; session: SessionInfo } | { kind: 'unpaired' } | { kind: 'error' };

async function fetchSession(): Promise<SessionResult> {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return { kind: 'unpaired' };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json()) as Partial<SessionInfo>;
    const scope: RemoteScope = body.scope === 'operator' ? 'operator' : 'viewer';
    const effectiveScope: RemoteScope = body.effectiveScope === 'operator' ? 'operator' : 'viewer';
    return { kind: 'ok', session: { scope, effectiveScope } };
  } catch {
    return { kind: 'error' };
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resolveDark(theme: RemotePrefs['theme']): boolean {
  if (theme !== 'system') return theme === 'dark';
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

const TOAST_MS = { blocked: 20_000, done: 8_000, error: 6_000 } as const;
const MAX_TOASTS = 4;

/** A newer alert about the same surface and kind replaces the older one rather than stacking. */
const withToast = (full: Toast) => (list: Toast[]): Toast[] => {
  const same = (x: Toast) => 's' in x && 's' in full && x.s === full.s && x.kind === full.kind;
  return [...list.filter((x) => !same(x)), full].slice(-MAX_TOASTS);
};
const withoutToast = (id: number) => (list: Toast[]): Toast[] => list.filter((x) => x.id !== id);

export function RemoteApp({ pairSecret }: Readonly<{ pairSecret: string | null }>) {
  const [prefs, setPrefsState] = useState<RemotePrefs>(loadPrefs);
  const lang = prefs.lang === 'auto' ? matchLanguage(navigator.languages ?? [navigator.language]) : prefs.lang;
  const t: RemoteT = useMemo(() => createT(lang), [lang]);

  const [phase, setPhase] = useState<Phase>(
    pairSecret ? { kind: 'pair', secret: pairSecret, busy: false, failed: false } : { kind: 'loading' },
  );
  const [view, setView] = useState<View>({ screen: 'list' });
  const [client, setClient] = useState<WsClient | null>(null);
  const [status, setStatus] = useState<WsStatus>('idle');
  const [welcome, setWelcome] = useState<WelcomeMessage | null>(null);
  const [roster, setRoster] = useState<RemoteRosterEntry[]>([]);
  const [rosterAt, setRosterAt] = useState(() => Date.now());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dark, setDark] = useState(() => resolveDark(prefs.theme));
  const toastSeq = useRef(0);

  // ── Theme: tokens switch on [data-theme]; "system" leaves it to the media query.
  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = prefs.theme;
    root.lang = lang;
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => setDark(resolveDark(prefs.theme));
    update();
    mq?.addEventListener('change', update);
    return () => mq?.removeEventListener('change', update);
  }, [prefs.theme, lang]);

  const setPrefs = (p: RemotePrefs) => {
    setPrefsState(p);
    savePrefs(p);
  };

  const pushToast = useCallback((toast: ToastInput) => {
    const full = { ...toast, id: ++toastSeq.current } as Toast;
    setToasts(withToast(full));
    globalThis.setTimeout(() => setToasts(withoutToast(full.id)), TOAST_MS[full.kind]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(withoutToast(id)), []);
  const showError = useCallback((text: string) => pushToast({ kind: 'error', text }), [pushToast]);

  // ── No pairing secret: ask the server who we are.
  useEffect(() => {
    if (phase.kind !== 'loading') return;
    let live = true;
    fetchSession().then((r) => {
      if (!live) return;
      if (r.kind === 'ok') setPhase({ kind: 'console', session: r.session });
      else setPhase({ kind: r.kind === 'unpaired' ? 'unpaired' : 'unreachable' });
    });
    return () => { live = false; };
  }, [phase.kind]);

  const pair = async (name: string) => {
    if (phase.kind !== 'pair') return;
    setPhase({ ...phase, busy: true, failed: false });
    try {
      const res = await postJson('/api/pair', { secret: phase.secret, name });
      if (res.ok) {
        globalThis.location.reload();
        return;
      }
      if (res.status === 410) {
        setPhase({ kind: 'expired' });
        return;
      }
    } catch { /* fall through to failed */ }
    setPhase({ ...phase, busy: false, failed: true });
  };

  // ── Frames that feed React state: the roster, notifications, errors.
  // Held in a ref and subscribed BEFORE the socket starts: the server sends
  // `agents` only on change, so a listener attached one render later could
  // miss the first (and, on a quiet desktop, only) roster.
  const onFrameRef = useRef<(msg: ServerMessage) => void>(() => undefined);
  onFrameRef.current = (msg) => {
    switch (msg.t) {
      case 'agents':
        setRoster(msg.list);
        setRosterAt(Date.now());
        break;
      case 'notify':
        onNotify(msg, pushToast, t);
        break;
      case 'error':
        if (msg.code === 'rate') showError(t.t('ack.rate'));
        else if (msg.code === 'forbidden') showError(t.t('ack.forbidden'));
        break;
      default:
        break;
    }
  };

  // ── Connected: one socket for the page's life.
  const consoleActive = phase.kind === 'console';
  useEffect(() => {
    if (!consoleActive) return;
    const c = createBrowserWsClient(async () => (await fetchSession()).kind !== 'unpaired');
    const offState = c.onState((st) => {
      setStatus(st.status);
      setWelcome(st.welcome);
      if (st.status !== 'stopped') return;
      if (st.stopReason === 'revoked') setPhase({ kind: 'revoked' });
      else if (st.stopReason === 'incompatible') setPhase({ kind: 'incompatible' });
      else if (st.stopReason === 'unauthorized') setPhase({ kind: 'unpaired' });
    });
    const offFrames = c.subscribe((msg) => onFrameRef.current(msg));
    setClient(c);
    c.start();
    const onVisible = () => { if (document.visibilityState === 'visible') c.nudge(); };
    document.addEventListener('visibilitychange', onVisible);
    globalThis.addEventListener('online', c.nudge);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      globalThis.removeEventListener('online', c.nudge);
      offState();
      offFrames();
      c.stop();
      setClient(null);
    };
  }, [consoleActive]);

  // ── Title: "(N) wmux", N = agents waiting on a human.
  const blockedCount = roster.filter((e) => e.state === 'blocked').length;
  useEffect(() => {
    document.title = blockedCount > 0 ? `(${blockedCount}) wmux` : 'wmux';
  }, [blockedCount]);

  const answer = useCallback((s: string, choiceId: string) => {
    if (!client) return;
    client.request({ t: 'answer', s, nonce: newNonce(), choiceId }).then(
      (ack) => { if (!ack.ok) showError(t.t(ackMessageKey(ack.code), { max: MAX_TEXT })); },
      () => { /* stopped: the full-screen state says why */ },
    );
  }, [client, showError, t]);

  const open = useCallback((s: string) => setView({ screen: 'attach', s }), []);

  const forget = async () => {
    try { await postJson('/api/logout', {}); } catch { /* the cookie dies with the device record either way */ }
    client?.stop('closed');
    setPhase({ kind: 'unpaired' });
  };

  switch (phase.kind) {
    case 'loading':
      return <NoticeScreen title={t.t('loading')} body="" />;
    case 'pair':
      return <PairScreen t={t} busy={phase.busy} failed={phase.failed} onPair={(n) => { pair(n).catch(() => undefined); }} />;
    case 'expired':
      return <NoticeScreen title={t.t('expired.title')} body={t.t('expired.body')} />;
    case 'unpaired':
      return <NoticeScreen title={t.t('unpaired.title')} body={t.t('unpaired.body')} />;
    case 'revoked':
      return <NoticeScreen title={t.t('revoked.title')} body={t.t('revoked.body')} />;
    case 'incompatible':
      return (
        <NoticeScreen
          title={t.t('incompatible.title')}
          body={t.t('incompatible.body')}
          action={{ label: t.t('common.reload'), onClick: () => globalThis.location.reload() }}
        />
      );
    case 'unreachable':
      return (
        <NoticeScreen
          title={t.t('unreachable.title')}
          body={t.t('unreachable.body')}
          action={{ label: t.t('common.retry'), onClick: () => setPhase({ kind: 'loading' }) }}
        />
      );
    default:
      break;
  }

  // The server's word wins once it has spoken: the welcome's effective scope
  // reflects the live bind, the session probe only the bind at page load.
  const effectiveScope = welcome?.effectiveScope ?? phase.session.effectiveScope;
  const operator = effectiveScope === 'operator';
  const host = welcome?.host ?? globalThis.location.host;
  const maxText = welcome?.limits.maxText ?? MAX_TEXT;

  let screen: ReactNode;
  if (!client) screen = <NoticeScreen title={t.t('loading')} body="" />;
  else if (view.screen === 'attach') {
    screen = (
      <AttachScreen
        client={client}
        s={view.s}
        entry={roster.find((e) => e.s === view.s)}
        status={status}
        operator={operator}
        maxText={maxText}
        fontScale={prefs.fontScale}
        dark={dark}
        t={t}
        onBack={() => setView({ screen: 'list' })}
        onAnswer={answer}
        onError={showError}
      />
    );
  } else if (view.screen === 'prefs') {
    screen = (
      <PrefsScreen
        t={t}
        prefs={prefs}
        host={host}
        device={welcome ? { name: welcome.device.name, scope: welcome.device.scope } : null}
        effectiveScope={effectiveScope}
        onChange={setPrefs}
        onBack={() => setView({ screen: 'list' })}
        onForget={() => { forget().catch(() => undefined); }}
      />
    );
  } else {
    screen = (
      <ConsoleScreen
        t={t}
        roster={roster}
        rosterAt={rosterAt}
        status={status}
        host={host}
        operator={operator}
        onOpen={open}
        onAnswer={answer}
        onSeen={(s) => client.seen(s)}
        onPrefs={() => setView({ screen: 'prefs' })}
      />
    );
  }

  return (
    <>
      {screen}
      <Toasts
        toasts={toasts}
        roster={roster}
        operator={operator}
        t={t}
        onOpen={open}
        onAnswer={answer}
        onDismiss={dismissToast}
      />
    </>
  );
}

/**
 * A `notify` frame: an in-page toast always; a buzz where the platform has
 * one; a system notification only when the page is hidden, the context is
 * secure and the user granted it from the Prefs click. The frame carries a
 * label, never agent text, and neither does anything built from it.
 */
function onNotify(
  msg: Extract<ServerMessage, { t: 'notify' }>,
  pushToast: (toast: ToastInput) => void,
  t: RemoteT,
): void {
  pushToast({ kind: msg.kind, s: msg.s, label: msg.label });
  if (msg.kind === 'blocked') {
    try { navigator.vibrate?.(120); } catch { /* not a phone, or not allowed */ }
  }
  if (!document.hidden || !globalThis.isSecureContext || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const body = msg.kind === 'blocked' ? t.t('toast.blocked', { label: msg.label }) : t.t('toast.done', { label: msg.label });
  try {
    // `tag` per surface+kind, so a flapping agent replaces its notification instead of stacking them.
    const note = new Notification('wmux', { body, tag: `${msg.kind}:${msg.s}` });
    note.onclick = () => globalThis.focus();
  } catch { /* Android Chrome requires a service worker for this; the toast already showed */ }
}

/**
 * One agent, attached (#254): header, the terminal mirror, and a bottom stack
 * of choice bar → key bar → composer.
 *
 * The bottom stack follows `visualViewport`, not the layout viewport. When the
 * phone keyboard opens, iOS Safari does NOT shrink the layout viewport — it
 * pans it — so a `bottom: 0` stack ends up under the keyboard exactly when the
 * user is typing into it. Sizing the screen to `visualViewport.height` (and
 * offsetting by its `offsetTop`) keeps the composer on top of the keyboard on
 * both engines; the safe-area inset pads the home indicator when it is closed.
 *
 * An effective VIEWER sees no composer, no key bar and no choice buttons: the
 * server would refuse every one of those frames (`forbidden`, then 4429 on the
 * third), so offering them would be offering a way to get disconnected.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RemoteKey, RemoteRosterEntry } from '../../../shared/remote-console-protocol';
import { ackMessageKey, stateWordKey, type RemoteT } from '../i18n';
import { armFromConfirm, tapKey, type KeyArm } from '../composer-state';
import { loadFitMode, saveFitMode, type FitMode } from '../fit';
import { isUnconfirmed, newNonce, type WsClient, type WsStatus } from '../ws-client';
import { ChoiceRow } from '../components/ChoiceRow';
import { attachTitle } from './attach-title';
import { Composer } from '../components/Composer';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { KeyBar } from '../components/KeyBar';
import { TermView } from '../components/TermView';
import { connKey } from './ConsoleScreen';

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The visual viewport's box, or null where the API does not exist. */
function useVisualViewport(): { height: number; top: number } | null {
  const read = () => {
    const vv = globalThis.visualViewport;
    return vv ? { height: Math.round(vv.height), top: Math.round(vv.offsetTop) } : null;
  };
  const [box, setBox] = useState(read);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const update = () => setBox(read());
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

interface Props {
  client: WsClient;
  s: string;
  entry: RemoteRosterEntry | undefined;
  status: WsStatus;
  operator: boolean;
  maxText: number;
  fontScale: number;
  dark: boolean;
  t: RemoteT;
  onBack(): void;
  onAnswer(s: string, choiceId: string): void;
  onError(text: string): void;
}

export function AttachScreen({ client, s, entry, status, operator, maxText, fontScale, dark, t, onBack, onAnswer, onError }: Readonly<Props>) {
  const [mode, setMode] = useState<FitMode>(() => loadFitMode(safeStorage(), s));
  const [arm, setArm] = useState<KeyArm | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const vv = useVisualViewport();

  // Disarm when the window lapses, so the red key goes back to normal by itself.
  useEffect(() => {
    if (!arm) return;
    const id = globalThis.setTimeout(() => setArm(null), Math.max(0, arm.until - Date.now()));
    return () => globalThis.clearTimeout(id);
  }, [arm]);

  const agentState = entry?.state ?? null;
  // The roster drops a closed pane's entry; the header keeps the name it had
  // rather than falling back to a raw surf-<uuid>.
  const [lastLabel, setLastLabel] = useState<string | null>(entry?.label ?? null);
  const label = entry?.label;
  useEffect(() => { if (label) setLastLabel(label); }, [label]);
  const blocked = agentState === 'blocked';

  const sendKey = useCallback((key: RemoteKey) => {
    const now = Date.now();
    const r = tapKey(arm, key, agentState, now, newNonce);
    if (r.action === 'arm') {
      setArm(r.arm);
      return;
    }
    setArm(null);
    // Exactly the listed fields: an empty `force` is noise, and the validator refuses one.
    const frame = r.force.length > 0
      ? { t: 'key' as const, s, nonce: r.nonce, key, force: r.force }
      : { t: 'key' as const, s, nonce: r.nonce, key };
    client.request(frame).then(
      (ack) => {
        if (ack.ok) return;
        // The server knew better than the roster (declared blocked, or a live
        // run depth): arm with the nonce it refused, so the next tap is it.
        if (ack.code === 'confirm' && ack.confirm) setArm(armFromConfirm(key, ack.nonce, Date.now(), ack.confirm, r.force));
        else onError(t.t(ackMessageKey(ack.code), { max: maxText }));
      },
      (err: unknown) => {
        // Too old to resend (ws-client rule 4): it may have landed.
        if (isUnconfirmed(err)) onError(t.t('ack.unconfirmed'));
      },
    );
  }, [arm, agentState, client, s, onError, t, maxText]);

  const toggleMode = () => {
    const next: FitMode = mode === 'fit' ? 'pan' : 'fit';
    setMode(next);
    saveFitMode(safeStorage(), s, next);
  };

  const wordKey = entry ? stateWordKey(entry.state) : null;
  const style = vv ? { height: `${vv.height}px`, transform: `translateY(${vv.top}px)` } : undefined;

  return (
    <main className="rc-screen rc-attach" style={style}>
      <header className="rc-bar">
        <button type="button" className="rc-bar__btn" onClick={onBack} aria-label={t.t('common.back')}>‹</button>
        <h1 className="rc-bar__title rc-attach__title">{attachTitle(entry?.label, lastLabel, t)}</h1>
        {wordKey
          ? <span className={`rc-chip rc-chip--${entry?.state}`}>{t.t(wordKey)}</span>
          : status !== 'ready' && <span className={`rc-chip rc-chip--${status}`}>{t.t(connKey(status))}</span>}
        <button type="button" className="rc-bar__btn rc-bar__btn--text" onClick={toggleMode} aria-pressed={mode === 'pan'}>
          {mode === 'fit' ? t.t('attach.pan') : t.t('attach.fit')}
        </button>
      </header>

      <TermView client={client} s={s} mode={mode} fontScale={fontScale} dark={dark} t={t} onLink={setLink} />

      <div className="rc-attach__stack">
        {operator && blocked && entry && !entry.answerPending && (
          <ChoiceRow choices={entry.choices} onAnswer={(id) => onAnswer(s, id)} />
        )}
        {blocked && entry?.answerPending && <p className="rc-attach__pending">{t.t('card.answerPending')}</p>}
        {operator && <KeyBar armed={arm?.key ?? null} t={t} onKey={sendKey} />}
        {operator && <Composer key={s} client={client} s={s} blocked={blocked} maxText={maxText} t={t} />}
      </div>

      {link && (
        <ConfirmSheet
          title={t.t('link.title')}
          detail={link}
          okLabel={t.t('link.ok')}
          cancelLabel={t.t('common.cancel')}
          onOk={() => {
            globalThis.open(link, '_blank', 'noopener,noreferrer');
            setLink(null);
          }}
          onCancel={() => setLink(null)}
        />
      )}
    </main>
  );
}

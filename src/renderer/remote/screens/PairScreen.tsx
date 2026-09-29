/**
 * The full-screen states (#254): pair confirm, and the dead ends — expired,
 * unpaired, revoked, incompatible, unreachable.
 *
 * Pairing asks before it POSTs, with the device name editable, for the QR
 * phishing case (A2): a code somebody else generated and got the user to scan
 * would pair THIS browser to THEIR wmux, and everything typed afterwards would
 * go to a machine the user does not own. One screen saying "only continue if
 * you just scanned this yourself" is the cheapest stop for that.
 */

import { useState } from 'react';
import type { RemoteT } from '../i18n';

interface NoticeProps {
  title: string;
  body: string;
  action?: { label: string; onClick(): void };
}

export function NoticeScreen({ title, body, action }: Readonly<NoticeProps>) {
  return (
    <main className="rc-full">
      <div className="rc-full__panel">
        <div className="rc-full__mark" aria-hidden="true">wmux</div>
        <h1 className="rc-full__title">{title}</h1>
        <p className="rc-full__body">{body}</p>
        {action && (
          <button type="button" className="rc-btn rc-btn--primary rc-full__action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </main>
  );
}

interface PairProps {
  t: RemoteT;
  busy: boolean;
  failed: boolean;
  onPair(name: string): void;
}

/** Same cap the server applies to a device name; the rest would be cut there anyway. */
const NAME_MAX = 40;

export function PairScreen({ t, busy, failed, onPair }: Readonly<PairProps>) {
  const [name, setName] = useState(() => t.t('pair.defaultName'));
  const trimmed = name.trim();
  return (
    <main className="rc-full">
      <form
        className="rc-full__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !busy) onPair(trimmed);
        }}
      >
        <div className="rc-full__mark" aria-hidden="true">wmux</div>
        <h1 className="rc-full__title">{t.t('pair.title')}</h1>
        <p className="rc-full__body">{t.t('pair.body')}</p>
        <label className="rc-field">
          <span className="rc-field__label">{t.t('pair.nameLabel')}</span>
          <input
            className="rc-field__input"
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {failed && <p className="rc-full__error" role="alert">{t.t('pair.failed')}</p>}
        <button type="submit" className="rc-btn rc-btn--primary rc-full__action" disabled={busy || !trimmed}>
          {busy ? t.t('pair.pairing') : t.t('pair.confirm')}
        </button>
      </form>
    </main>
  );
}

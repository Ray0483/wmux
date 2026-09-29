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
import { DEVICE_NAME_MAX } from '../../../shared/remote-console-protocol';
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

/** Why a pairing attempt failed, as the message key the screen shows. */
export type PairFailure = 'pair.failed' | 'pair.rate' | 'pair.deviceCap';

/**
 * Word a refused `POST /api/pair` (410 is handled before this, as "expired").
 * "Make a new code" is the right advice only for a bad or used code: after a
 * 429 the same code still works once the limit lifts, and at the device cap
 * the computer refuses to make a new code at all until a device is revoked.
 */
export function pairFailureKey(status: number | null, body: unknown): PairFailure {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (status === 429 || error === 'rate') return 'pair.rate';
  if (error === 'device-cap') return 'pair.deviceCap';
  return 'pair.failed';
}

interface PairProps {
  t: RemoteT;
  busy: boolean;
  failed: PairFailure | null;
  onPair(name: string): void;
}

/**
 * The name field starts EMPTY. The desktop already asked for a device name
 * when it made the code, and an empty field here is what lets that name win:
 * the server falls back to it (`cleanDeviceName(name, offer.name)`). Prefilling
 * "Phone" here overrode the desktop's choice on every single pairing.
 */
export function PairScreen({ t, busy, failed, onPair }: Readonly<PairProps>) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  return (
    <main className="rc-full">
      <form
        className="rc-full__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onPair(trimmed);
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
            placeholder={t.t('pair.namePlaceholder')}
            maxLength={DEVICE_NAME_MAX}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {failed && <p className="rc-full__error" role="alert">{t.t(failed)}</p>}
        <button type="submit" className="rc-btn rc-btn--primary rc-full__action" disabled={busy}>
          {busy ? t.t('pair.pairing') : t.t('pair.confirm')}
        </button>
      </form>
    </main>
  );
}

/**
 * In-page alerts (#254): an agent needs you, an agent is done, an action was
 * refused.
 *
 * In-page first, because it is the one alert channel that works everywhere the
 * console does — a system `Notification` needs a secure context and a granted
 * permission, and does nothing on a LAN bind over plain http. The `notify`
 * frame carries a surface and a label, never agent text; a blocked toast looks
 * the choices up in the CURRENT roster, so a toast that outlived its question
 * offers nothing stale to tap.
 */

import type { RemoteRosterEntry } from '../../../shared/remote-console-protocol';
import type { RemoteT } from '../i18n';
import { ChoiceRow } from './ChoiceRow';

export type Toast =
  | { id: number; kind: 'blocked' | 'done'; s: string; label: string }
  | { id: number; kind: 'error'; text: string };

/** A toast before it has an id. Distributive, so each variant keeps its own fields. */
export type ToastInput = Toast extends infer T ? (T extends Toast ? Omit<T, 'id'> : never) : never;

interface Props {
  toasts: readonly Toast[];
  roster: readonly RemoteRosterEntry[];
  operator: boolean;
  t: RemoteT;
  onOpen(s: string): void;
  onAnswer(s: string, choiceId: string, prompt: number | null): void;
  onDismiss(id: number): void;
}

function AgentToast({ toast, entry, operator, t, onOpen, onAnswer, onDismiss }: Readonly<{
  toast: Extract<Toast, { s: string }>;
  entry: RemoteRosterEntry | undefined;
  operator: boolean;
  t: RemoteT;
  onOpen(s: string): void;
  onAnswer(s: string, choiceId: string, prompt: number | null): void;
  onDismiss(id: number): void;
}>) {
  const stillBlocked = toast.kind === 'blocked' && entry?.state === 'blocked' && !entry.answerPending;
  const text = toast.kind === 'blocked' ? t.t('toast.blocked', { label: toast.label }) : t.t('toast.done', { label: toast.label });
  return (
    <div className={`rc-toast rc-toast--${toast.kind}`} role="status">
      <button type="button" className="rc-toast__body" onClick={() => { onDismiss(toast.id); onOpen(toast.s); }}>
        {text}
      </button>
      <button type="button" className="rc-toast__close" aria-label={t.t('common.dismiss')} onClick={() => onDismiss(toast.id)}>×</button>
      {operator && stillBlocked && entry && (
        <ChoiceRow
          choices={entry.choices}
          onAnswer={(id) => { onDismiss(toast.id); onAnswer(toast.s, id, entry.promptId); }}
        />
      )}
    </div>
  );
}

export function Toasts({ toasts, roster, operator, t, onOpen, onAnswer, onDismiss }: Readonly<Props>) {
  if (toasts.length === 0) return null;
  return (
    <div className="rc-toasts" aria-live="polite">
      {toasts.map((toast) =>
        toast.kind === 'error' ? (
          <div key={toast.id} className="rc-toast rc-toast--error" role="alert">
            <span className="rc-toast__body">{toast.text}</span>
            <button type="button" className="rc-toast__close" aria-label={t.t('common.dismiss')} onClick={() => onDismiss(toast.id)}>×</button>
          </div>
        ) : (
          <AgentToast
            key={toast.id}
            toast={toast}
            entry={roster.find((e) => e.s === toast.s)}
            operator={operator}
            t={t}
            onOpen={onOpen}
            onAnswer={onAnswer}
            onDismiss={onDismiss}
          />
        ),
      )}
    </div>
  );
}

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
import { useVisualViewport } from '../visual-viewport';

export type Toast =
  | { id: number; kind: 'blocked' | 'done'; s: string; label: string }
  | { id: number; kind: 'error'; text: string };

/** A toast before it has an id. Distributive, so each variant keeps its own fields. */
export type ToastInput = Toast extends infer T ? (T extends Toast ? Omit<T, 'id'> : never) : never;

/**
 * The toasts worth showing: not an agent's toast for the surface already on
 * screen. The attach screen shows that pane's state and its answer buttons
 * itself, and the toast only repeated them over the mirrored terminal.
 */
export function visibleToasts(toasts: readonly Toast[], attached: string | null): Toast[] {
  return toasts.filter((x) => x.kind === 'error' || x.s !== attached);
}

interface Props {
  toasts: readonly Toast[];
  /** The surface the attach screen is showing, or null. */
  attached: string | null;
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

export function Toasts({ toasts, attached, roster, operator, t, onOpen, onAnswer, onDismiss }: Readonly<Props>) {
  // Placed against the VISUAL viewport, like the attach screen: with the
  // keyboard open iOS pans the layout viewport, and a stack fixed to it ends
  // up off-screen.
  const vv = useVisualViewport();
  const shown = visibleToasts(toasts, attached);
  if (shown.length === 0) return null;
  return (
    <div className="rc-toasts" aria-live="polite" style={vv && vv.top !== 0 ? { transform: `translateY(${vv.top}px)` } : undefined}>
      {shown.map((toast) =>
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

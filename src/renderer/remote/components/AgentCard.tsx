/**
 * One agent on the console list (#254).
 *
 * The three blocked sub-states read differently on purpose, because they ask
 * different things of the user: choices declared → answer here; none declared
 * → "open to answer" (the question is on the screen, not in the roster); an
 * answer already sent → wait, and do not tap again. `unknown` renders with no
 * state word at all (#235).
 */

import type { RemoteRosterEntry } from '../../../shared/remote-console-protocol';
import { stateWordKey, type RemoteT } from '../i18n';
import { ChoiceRow } from './ChoiceRow';

interface Props {
  entry: RemoteRosterEntry;
  /** ms elapsed since the roster frame arrived, added to its dwell. */
  sinceRoster: number;
  operator: boolean;
  t: RemoteT;
  onOpen(s: string): void;
  onAnswer(s: string, choiceId: string): void;
}

function blockedLine(entry: RemoteRosterEntry, operator: boolean, t: RemoteT): string | null {
  if (entry.state !== 'blocked') return null;
  if (entry.answerPending) return t.t('card.answerPending');
  // A view-only device opens the card to find no composer, keys or choices:
  // "open to answer" would send it looking for a way that is not there.
  if (!operator) return t.t('card.answerOnComputer');
  if (entry.choices.length === 0) return t.t('card.openToAnswer');
  return null;
}

export function AgentCard({ entry, sinceRoster, operator, t, onOpen, onAnswer }: Readonly<Props>) {
  const wordKey = stateWordKey(entry.state);
  const hint = blockedLine(entry, operator, t);
  const showChoices = operator && entry.state === 'blocked' && !entry.answerPending && entry.choices.length > 0;
  const age = entry.state === 'unknown' ? '' : t.ago(entry.dwellMs + sinceRoster);

  return (
    <article className={`rc-card rc-card--${entry.state}${entry.done ? ' rc-card--done' : ''}`}>
      <button type="button" className="rc-card__open" onClick={() => onOpen(entry.s)}>
        <span className="rc-card__head">
          <span className="rc-card__dot" aria-hidden="true" />
          <span className="rc-card__label">{entry.label}</span>
          {wordKey && <span className="rc-card__state">{t.t(wordKey)}</span>}
          {entry.done && <span className="rc-card__badge">{t.t('console.done')}</span>}
        </span>
        <span className="rc-card__meta">
          <span className="rc-card__ws">{entry.workspaceTitle}</span>
          {age && <span className="rc-card__age">{age}</span>}
        </span>
        {entry.state === 'blocked' && entry.blockedReason && (
          <span className="rc-card__reason">{entry.blockedReason}</span>
        )}
        {hint && <span className="rc-card__hint">{hint}</span>}
      </button>
      {showChoices && <ChoiceRow choices={entry.choices} onAnswer={(id) => onAnswer(entry.s, id)} />}
    </article>
  );
}

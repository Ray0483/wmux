/**
 * The declared answers to a blocked agent, as buttons (#254, back-channel #128).
 *
 * A button carries only the choice `id`. The payload it stands for (a key, or
 * literal text) never left main — `toWire` strips it (I7) — and main looks it
 * up again when the answer arrives, through the same `deliverAnswer` →
 * `answerAgent` path as `wmux answer-agent`. So this row cannot send anything
 * the agent did not declare, and cannot clear `blocked` either: answering never
 * does, the agent must confirm.
 */

import type { RemoteRosterEntry } from '../../../shared/remote-console-protocol';

interface Props {
  choices: RemoteRosterEntry['choices'];
  disabled?: boolean;
  onAnswer(choiceId: string): void;
}

export function ChoiceRow({ choices, disabled, onAnswer }: Readonly<Props>) {
  if (choices.length === 0) return null;
  return (
    <div className="rc-choices">
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          className={c.isDefault ? 'rc-btn rc-btn--primary rc-choices__btn' : 'rc-btn rc-choices__btn'}
          disabled={disabled}
          onClick={() => onAnswer(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

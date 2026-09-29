/**
 * The keys a phone keyboard does not have (#254).
 *
 * The primary row is what driving an agent TUI needs — Esc, Tab, ⇧Tab, arrows,
 * Enter, ^C, y/n — and ⋯ reveals the rest. An ARMED key is red: its first tap
 * was held back (by the roster, or by a server `confirm`), and a second tap
 * inside 1.5 s sends it with the same nonce and `force`. The decision is made
 * by `tapKey` in composer-state.ts; this component only renders it.
 */

import { useState } from 'react';
import type { RemoteKey } from '../../../shared/remote-console-protocol';
import type { RemoteT } from '../i18n';

interface KeyDef { key: RemoteKey; label: string; aria?: string }

const PRIMARY: readonly KeyDef[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'shift-tab', label: '⇧Tab' },
  { key: 'up', label: '↑', aria: 'Up' },
  { key: 'down', label: '↓', aria: 'Down' },
  { key: 'left', label: '←', aria: 'Left' },
  { key: 'right', label: '→', aria: 'Right' },
  { key: 'enter', label: '↵', aria: 'Enter' },
  { key: 'ctrl-c', label: '^C', aria: 'Ctrl+C' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
];

const EXTRA: readonly KeyDef[] = [
  { key: 'ctrl-d', label: '^D', aria: 'Ctrl+D' },
  { key: 'ctrl-l', label: '^L', aria: 'Ctrl+L' },
  { key: 'ctrl-r', label: '^R', aria: 'Ctrl+R' },
  { key: 'pageup', label: 'PgUp' },
  { key: 'pagedown', label: 'PgDn' },
  { key: 'home', label: 'Home' },
  { key: 'end', label: 'End' },
  { key: 'backspace', label: '⌫', aria: 'Backspace' },
];

interface Props {
  armed: RemoteKey | null;
  t: RemoteT;
  onKey(key: RemoteKey): void;
}

function KeyButton({ def, armed, armedLabel, onKey }: Readonly<{ def: KeyDef; armed: boolean; armedLabel: string; onKey(k: RemoteKey): void }>) {
  return (
    <button
      type="button"
      className={armed ? 'rc-key rc-key--armed' : 'rc-key'}
      aria-label={armed ? `${def.aria ?? def.label} — ${armedLabel}` : (def.aria ?? def.label)}
      // pointerdown-free on purpose: a key sent on touch START fires during a
      // scroll of the bar itself. `click` only fires on a tap that stayed put.
      onClick={() => onKey(def.key)}
    >
      {def.label}
    </button>
  );
}

export function KeyBar({ armed, t, onKey }: Readonly<Props>) {
  const [more, setMore] = useState(false);
  const armedLabel = t.t('keys.armed');
  return (
    <div className="rc-keybar">
      <div className="rc-keybar__row">
        {PRIMARY.map((d) => <KeyButton key={d.key} def={d} armed={armed === d.key} armedLabel={armedLabel} onKey={onKey} />)}
        <button
          type="button"
          className={more ? 'rc-key rc-key--on' : 'rc-key'}
          aria-expanded={more}
          aria-label={t.t('keys.more')}
          onClick={() => setMore((m) => !m)}
        >
          ⋯
        </button>
      </div>
      {more && (
        <div className="rc-keybar__row">
          {EXTRA.map((d) => <KeyButton key={d.key} def={d} armed={armed === d.key} armedLabel={armedLabel} onKey={onKey} />)}
        </div>
      )}
    </div>
  );
}

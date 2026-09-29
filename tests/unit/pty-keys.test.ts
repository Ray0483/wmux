import { describe, it, expect } from 'vitest';
import { PTY_KEY_MAP, REMOTE_KEY_BYTES, translateKeyName } from '../../src/main/pty-keys';
import { REMOTE_KEYS } from '../../src/shared/remote-console-protocol';

// Literal bytes, not re-derived from the module: this is what `surface.send_key`
// has typed since before #254 moved the table, and the move must not change it.
const EXPECTED_PTY_KEYS: Record<string, string> = {
  enter: '\r', return: '\r', tab: '\t', esc: '\x1b', escape: '\x1b',
  backspace: '\x7f', delete: '\x1b[3~', space: ' ',
  'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-u': '\x15', 'ctrl-l': '\x0c',
  'ctrl-a': '\x01', 'ctrl-e': '\x05', 'ctrl-k': '\x0b', 'ctrl-w': '\x17',
  'ctrl-r': '\x12', 'ctrl-z': '\x1a',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};

const EXPECTED_REMOTE_KEYS: Record<string, string> = {
  esc: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', enter: '\r',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F', backspace: '\x7f',
  'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', 'ctrl-r': '\x12',
  y: 'y', n: 'n',
};

describe('PTY_KEY_MAP (#254 move)', () => {
  it('is byte-identical to the pre-move table', () => {
    expect(PTY_KEY_MAP).toEqual(EXPECTED_PTY_KEYS);
  });
});

describe('translateKeyName', () => {
  it('passes a single character through, upper-cased with shift', () => {
    expect(translateKeyName('a', false)).toBe('a');
    expect(translateKeyName('a', true)).toBe('A');
  });
  it('translates names case-insensitively', () => {
    expect(translateKeyName('Enter', false)).toBe('\r');
    expect(translateKeyName('CTRL-C', false)).toBe('\x03');
  });
  it('answers null for an unknown name', () => {
    expect(translateKeyName('hyper-q', false)).toBe(null);
  });
});

describe('REMOTE_KEY_BYTES', () => {
  it('pins every byte', () => {
    expect({ ...REMOTE_KEY_BYTES }).toEqual(EXPECTED_REMOTE_KEYS);
  });
  it('covers exactly the protocol key set', () => {
    expect(Object.keys(REMOTE_KEY_BYTES).sort()).toEqual([...REMOTE_KEYS].sort());
  });
});

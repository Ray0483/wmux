import { describe, it, expect } from 'vitest';
import {
  CLOSE_CODES,
  MAX_FRAME,
  MAX_TEXT,
  REMOTE_KEYS,
  SCOPE_OF,
  validateClientMessage,
  type ClientMessageType,
} from '../../src/shared/remote-console-protocol';

const S = 'surf-0123abcd-0123-4567-89ab-0123456789ab';
const N = 'nonce-1234';

describe('SCOPE_OF (#254)', () => {
  it('is exhaustive over the client table, and nothing more', () => {
    // Kept in sync with the ClientMessage union by hand: a new message type must
    // be added here AND given a scope, which is the review moment we want.
    const expected: ClientMessageType[] = ['hello', 'attach', 'detach', 'seen', 'ping', 'send', 'key', 'answer'];
    expect(Object.keys(SCOPE_OF).sort()).toEqual([...expected].sort());
  });

  it('only send, key and answer need operator scope', () => {
    const operator = Object.entries(SCOPE_OF).filter(([, s]) => s === 'operator').map(([t]) => t).sort();
    expect(operator).toEqual(['answer', 'key', 'send']);
  });
});

describe('CLOSE_CODES', () => {
  it('pins the wire values', () => {
    expect(CLOSE_CODES).toEqual({ HELLO: 4400, REVOKED: 4401, HEARTBEAT: 4408, TOO_MANY: 4409, RATE: 4429, STOPPING: 1001 });
  });
});

describe('validateClientMessage', () => {
  const accept: [string, unknown][] = [
    ['hello', { t: 'hello', v: 1 }],
    ['hello with a future version (session closes 4400, not the validator)', { t: 'hello', v: 2 }],
    ['attach', { t: 'attach', s: S }],
    ['detach', { t: 'detach' }],
    ['seen', { t: 'seen', s: S }],
    ['ping', { t: 'ping' }],
    ['send', { t: 'send', s: S, nonce: N, text: 'hi', submit: true }],
    ['send with force', { t: 'send', s: S, nonce: N, text: '', submit: false, force: ['blocked'] }],
    ['send with force and prompt', { t: 'send', s: S, nonce: N, text: '', submit: false, force: ['blocked'], prompt: 3 }],
    ['key with prompt', { t: 'key', s: S, nonce: N, key: 'enter', force: ['blocked'], prompt: 1 }],
    ['key with two waivers', { t: 'key', s: S, nonce: N, key: 'esc', force: ['interrupt', 'blocked'] }],
    ['send over MAX_TEXT (answered too-long by the session)', { t: 'send', s: S, nonce: N, text: 'x'.repeat(MAX_TEXT + 1), submit: true }],
    ['every remote key', { t: 'key', s: S, nonce: N, key: 'shift-tab' }],
    ['answer', { t: 'answer', s: S, nonce: N, choiceId: 'yes_1-a', prompt: 42 }],
  ];
  for (const [name, msg] of accept) {
    it(`accepts ${name}`, () => {
      const r = validateClientMessage(msg);
      expect(r.ok).toBe(true);
      expect(validateClientMessage(JSON.stringify(msg)).ok).toBe(true);
    });
  }

  it('accepts every key in REMOTE_KEYS', () => {
    for (const key of REMOTE_KEYS) {
      expect(validateClientMessage({ t: 'key', s: S, nonce: N, key }).ok).toBe(true);
    }
  });

  const reject: [string, unknown][] = [
    ['non-JSON text', '{nope'],
    ['a JSON array', '[]'],
    ['null', null],
    ['a number', 42],
    ['missing t', { s: S }],
    ['unknown t', { t: 'exec', cmd: 'rm' }],
    ['a prototype key as t', { t: 'toString' }],
    ['an unknown field', { t: 'ping', extra: 1 }],
    ['hello without v', { t: 'hello' }],
    ['hello with a string v', { t: 'hello', v: '1' }],
    ['upper-case surface id', { t: 'attach', s: S.toUpperCase() }],
    ['pane id instead of surface id', { t: 'attach', s: 'pane-0123abcd-0123-4567-89ab-0123456789ab' }],
    ['short nonce', { t: 'send', s: S, nonce: 'abc', text: 'x', submit: true }],
    ['nonce with a slash', { t: 'send', s: S, nonce: 'abcd/efgh', text: 'x', submit: true }],
    ['65-char nonce', { t: 'send', s: S, nonce: 'a'.repeat(65), text: 'x', submit: true }],
    ['send without submit', { t: 'send', s: S, nonce: N, text: 'x' }],
    ['send with a non-list force', { t: 'send', s: S, nonce: N, text: 'x', submit: true, force: 'yes' }],
    ['send with the old boolean force (it waived every confirm at once)', { t: 'send', s: S, nonce: N, text: 'x', submit: true, force: true }],
    ['send with an empty force', { t: 'send', s: S, nonce: N, text: 'x', submit: true, force: [] }],
    ['send with an unknown force kind', { t: 'send', s: S, nonce: N, text: 'x', submit: true, force: ['all'] }],
    ['key with a repeated force kind', { t: 'key', s: S, nonce: N, key: 'esc', force: ['interrupt', 'interrupt'] }],
    ['send with a non-string text', { t: 'send', s: S, nonce: N, text: 1, submit: true }],
    ['a key not in the table', { t: 'key', s: S, nonce: N, key: 'f5' }],
    ['a raw byte as key', { t: 'key', s: S, nonce: N, key: '\x1b' }],
    ['a bad choice id', { t: 'answer', s: S, nonce: N, choiceId: 'a b', prompt: 1 }],
    ['a 33-char choice id', { t: 'answer', s: S, nonce: N, choiceId: 'a'.repeat(33), prompt: 1 }],
    ['answer carrying a payload', { t: 'answer', s: S, nonce: N, choiceId: 'y', prompt: 1, text: 'y\r' }],
    ['answer with no prompt id', { t: 'answer', s: S, nonce: N, choiceId: 'y' }],
    ['answer with a zero prompt id', { t: 'answer', s: S, nonce: N, choiceId: 'y', prompt: 0 }],
    ['answer with a fractional prompt id', { t: 'answer', s: S, nonce: N, choiceId: 'y', prompt: 1.5 }],
    ['key with a string prompt id', { t: 'key', s: S, nonce: N, key: 'enter', prompt: '1' }],
  ];
  for (const [name, msg] of reject) {
    it(`rejects ${name}`, () => {
      expect(validateClientMessage(msg)).toEqual({ ok: false, code: 'bad-frame' });
    });
  }

  it('rejects an oversize text frame before parsing it', () => {
    const big = JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_FRAME) });
    expect(validateClientMessage(big)).toEqual({ ok: false, code: 'bad-frame' });
  });
});

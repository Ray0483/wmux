import { describe, it, expect } from 'vitest';
import { buildComposerWrites, capText, sanitizeComposerText, stripBidi } from '../../src/shared/remote-input';

describe('sanitizeComposerText (#254)', () => {
  const table: [string, string, string][] = [
    ['plain text', 'hello world', 'hello world'],
    ['keeps TAB and LF', 'a\tb\nc', 'a\tb\nc'],
    ['CRLF → LF', 'a\r\nb', 'a\nb'],
    ['lone CR → LF', 'a\rb', 'a\nb'],
    ['bracketed-paste terminator is defused', 'x\x1b[201~rm -rf /', 'x[201~rm -rf /'],
    ['OSC 52 clipboard write is defused', '\x1b]52;c;ZXZpbA==\x07', ']52;c;ZXZpbA=='],
    ['OSC 52 with ST', '\x1b]52;c;QQ==\x1b\\', ']52;c;QQ==\\'],
    ['C0 controls go', 'a\x00b\x03c\x04d\x08e\x0bf\x0cg\x1fh', 'abcdefgh'],
    ['DEL goes', 'a\x7fb', 'ab'],
    ['8-bit CSI (C1) goes', 'a\u009b31mb', 'a31mb'],
    ['whole C1 range goes', '\u0080\u0085\u009f', ''],
    ['bidi overrides go', 'a‮b‪c⁦d⁩e', 'abcde'],
    ['non-control unicode stays', 'café 日本 😀  ', 'café 日本 😀  '],
  ];
  for (const [name, input, out] of table) {
    it(name, () => expect(sanitizeComposerText(input)).toBe(out));
  }
});

describe('buildComposerWrites', () => {
  it('bracketed wraps the text and submits separately', () => {
    expect(buildComposerWrites('a\nb', { bracketed: true, submit: true })).toEqual(['\x1b[200~a\nb\x1b[201~', '\r']);
  });
  it('unbracketed turns LF into CR', () => {
    expect(buildComposerWrites('a\nb', { bracketed: false, submit: false })).toEqual(['a\rb']);
  });
  it('unbracketed with submit', () => {
    expect(buildComposerWrites('ls', { bracketed: false, submit: true })).toEqual(['ls', '\r']);
  });
  it('empty text with submit is a bare Enter, never an empty paste', () => {
    expect(buildComposerWrites('', { bracketed: true, submit: true })).toEqual(['\r']);
    expect(buildComposerWrites('', { bracketed: false, submit: true })).toEqual(['\r']);
  });
  it('empty text without submit writes nothing', () => {
    expect(buildComposerWrites('', { bracketed: true, submit: false })).toEqual([]);
  });
});

describe('stripBidi / capText', () => {
  it('stripBidi removes only bidi controls', () => {
    expect(stripBidi('‮evil‬ ok\x1b')).toBe('evil ok\x1b');
  });
  it('capText leaves short text alone', () => {
    expect(capText('abc', 3)).toBe('abc');
  });
  it('capText truncates', () => {
    expect(capText('abcdef', 4)).toBe('abcd');
  });
  it('capText never splits a surrogate pair', () => {
    expect(capText('ab😀', 3)).toBe('ab');
  });
  it('capText with a non-positive cap is empty', () => {
    expect(capText('abc', 0)).toBe('');
  });
});

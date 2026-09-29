import { describe, it, expect } from 'vitest';
import {
  ARM_WINDOW_MS,
  armFromConfirm,
  canSubmit,
  composerLabel,
  composerReducer,
  initialComposer,
  isArmed,
  keyNeedsArming,
  loadDraft,
  saveDraft,
  tapKey,
  type ComposerState,
  type DraftStorage,
} from '../../src/renderer/remote/composer-state';

const typed = (text: string): ComposerState => composerReducer(initialComposer(), { type: 'edit', text });

describe('composer state machine', () => {
  it('idle → sending → acked clears the draft', () => {
    let s = typed('hello');
    s = composerReducer(s, { type: 'submit', nonce: 'n-00000001', blocked: false });
    expect(s).toMatchObject({ phase: 'sending', draft: 'hello', frame: { nonce: 'n-00000001', text: 'hello', submit: true, force: false } });
    s = composerReducer(s, { type: 'ack', nonce: 'n-00000001', ok: true });
    expect(s).toMatchObject({ phase: 'acked', draft: '', frame: null });
  });

  it('keeps the draft on every outcome except ack ok', () => {
    const sending = composerReducer(typed('keep me'), { type: 'submit', nonce: 'n-00000002', blocked: false });
    for (const next of [
      composerReducer(sending, { type: 'ack', nonce: 'n-00000002', ok: false, code: 'rate' }),
      composerReducer(sending, { type: 'ack', nonce: 'n-00000002', ok: false, code: 'confirm', confirm: 'multiline' }),
      composerReducer(sending, { type: 'error' }),
      composerReducer(sending, { type: 'ack', nonce: 'someone-else', ok: true }),
    ]) {
      expect(next.draft).toBe('keep me');
    }
  });

  it('sending → failed carries the ack code', () => {
    const s = composerReducer(
      composerReducer(typed('x'), { type: 'submit', nonce: 'n-00000003', blocked: false }),
      { type: 'ack', nonce: 'n-00000003', ok: false, code: 'too-long' },
    );
    expect(s).toMatchObject({ phase: 'failed', code: 'too-long' });
    expect(composerReducer(s, { type: 'edit', text: 'y' })).toMatchObject({ phase: 'idle', code: null, draft: 'y' });
  });

  it('a server multiline confirm resends the same nonce with force, keeping submit', () => {
    let s = composerReducer(typed('a\nb'), { type: 'submit', nonce: 'n-00000004', blocked: false });
    s = composerReducer(s, { type: 'ack', nonce: 'n-00000004', ok: false, code: 'confirm', confirm: 'multiline' });
    expect(s).toMatchObject({ phase: 'confirm', confirm: 'multiline' });
    s = composerReducer(s, { type: 'accept' });
    expect(s).toMatchObject({ phase: 'sending', frame: { nonce: 'n-00000004', submit: true, force: true } });
  });

  it('blocked: the button reads Insert, pre-confirms, and inserts without Enter', () => {
    let s = typed('some text');
    expect(composerLabel(s, true)).toBe('insert');
    expect(composerLabel(s, false)).toBe('send');
    s = composerReducer(s, { type: 'submit', nonce: 'n-00000005', blocked: true });
    expect(s).toMatchObject({ phase: 'confirm', confirm: 'blocked', frame: { submit: false, force: false } });
    s = composerReducer(s, { type: 'accept' });
    expect(s).toMatchObject({ phase: 'sending', frame: { nonce: 'n-00000005', submit: false, force: true } });
  });

  it('a SERVER blocked confirm (roster was stale) also turns the resend into an Insert', () => {
    let s = composerReducer(typed('y'), { type: 'submit', nonce: 'n-00000006', blocked: false });
    s = composerReducer(s, { type: 'ack', nonce: 'n-00000006', ok: false, code: 'confirm', confirm: 'blocked' });
    s = composerReducer(s, { type: 'accept' });
    expect(s.frame).toMatchObject({ nonce: 'n-00000006', submit: false, force: true });
  });

  it('cancel from confirm returns to idle with the text intact', () => {
    let s = composerReducer(typed('t'), { type: 'submit', nonce: 'n-00000007', blocked: true });
    s = composerReducer(s, { type: 'cancel' });
    expect(s).toMatchObject({ phase: 'idle', draft: 't', frame: null });
  });

  it('refuses a second submit while one is in flight (send-once)', () => {
    const s = composerReducer(typed('once'), { type: 'submit', nonce: 'n-00000008', blocked: false });
    expect(canSubmit(s, false)).toBe(false);
    expect(composerLabel(s, false)).toBe('sending');
    expect(composerReducer(s, { type: 'submit', nonce: 'n-99999999', blocked: false })).toBe(s);
  });

  it('empty Send is a bare Enter; empty Insert is refused', () => {
    expect(canSubmit(initialComposer(), false)).toBe(true);
    expect(canSubmit(initialComposer(), true)).toBe(false);
  });

  it('editing mid-flight changes the box, not the frame', () => {
    let s = composerReducer(typed('first'), { type: 'submit', nonce: 'n-0000000a', blocked: false });
    s = composerReducer(s, { type: 'edit', text: 'second' });
    expect(s).toMatchObject({ phase: 'sending', draft: 'second', frame: { text: 'first' } });
  });
});

describe('draft persistence', () => {
  const mem = (): DraftStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); },
    };
  };

  it('saves per surface and removes an empty draft', () => {
    const st = mem();
    saveDraft(st, 'surf-a', 'hello');
    saveDraft(st, 'surf-b', 'other');
    expect(loadDraft(st, 'surf-a')).toBe('hello');
    saveDraft(st, 'surf-a', '');
    expect(st.data.has('wmux-remote-draft:surf-a')).toBe(false);
    expect(loadDraft(st, 'surf-b')).toBe('other');
  });

  it('survives a Storage that throws, and a missing one', () => {
    const boom: DraftStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(() => saveDraft(boom, 's', 'x')).not.toThrow();
    expect(loadDraft(boom, 's')).toBe('');
    expect(loadDraft(null, 's')).toBe('');
  });
});

describe('key arming', () => {
  it('arms esc and ctrl-c while working; enter, y, n while blocked; never arrows', () => {
    expect(keyNeedsArming('esc', 'working')).toBe(true);
    expect(keyNeedsArming('ctrl-c', 'working')).toBe(true);
    expect(keyNeedsArming('enter', 'working')).toBe(false);
    for (const k of ['enter', 'y', 'n'] as const) expect(keyNeedsArming(k, 'blocked')).toBe(true);
    expect(keyNeedsArming('up', 'blocked')).toBe(false);
    expect(keyNeedsArming('esc', 'idle')).toBe(false);
    expect(keyNeedsArming('esc', null)).toBe(false);
  });

  it('first tap arms, second tap inside 1.5 s sends the SAME nonce with force', () => {
    let n = 0;
    const mint = () => `nonce-${++n}-xxxx`;
    const first = tapKey(null, 'esc', 'working', 1000, mint);
    expect(first.action).toBe('arm');
    const arm = first.action === 'arm' ? first.arm : null;
    expect(isArmed(arm, 'esc', 1000 + ARM_WINDOW_MS - 1)).toBe(true);
    const second = tapKey(arm, 'esc', 'working', 1000 + ARM_WINDOW_MS - 1, mint);
    expect(second).toEqual({ action: 'send', nonce: 'nonce-1-xxxx', force: true, arm: null });
  });

  it('an expired arm starts over, and a different key never borrows it', () => {
    const mint = () => 'nonce-fresh-1';
    const arm = { key: 'esc' as const, nonce: 'nonce-old-01', until: 2500 };
    expect(tapKey(arm, 'esc', 'working', 2500, mint)).toMatchObject({ action: 'arm', arm: { nonce: 'nonce-fresh-1' } });
    expect(tapKey(arm, 'up', 'working', 2000, mint)).toEqual({ action: 'send', nonce: 'nonce-fresh-1', force: false, arm: null });
  });

  it('a server confirm arms the refused nonce', () => {
    const arm = armFromConfirm('ctrl-c', 'nonce-refused', 100);
    expect(arm).toEqual({ key: 'ctrl-c', nonce: 'nonce-refused', until: 100 + ARM_WINDOW_MS });
    expect(tapKey(arm, 'ctrl-c', 'idle', 200, () => 'never')).toMatchObject({ nonce: 'nonce-refused', force: true });
  });
});

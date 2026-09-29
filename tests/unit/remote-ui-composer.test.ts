import { describe, it, expect } from 'vitest';
import {
  ARM_WINDOW_MS,
  armFromConfirm,
  canSubmit,
  clearSentDraft,
  composerLabel,
  composerReducer,
  initialComposer,
  isArmed,
  keyArmKinds,
  keyNeedsArming,
  loadDraft,
  saveDraft,
  tapKey,
  waivablePrompt,
  type ComposerState,
  type DraftStorage,
} from '../../src/renderer/remote/composer-state';

const typed = (text: string): ComposerState => composerReducer(initialComposer(), { type: 'edit', text });

describe('composer state machine', () => {
  it('idle → sending → acked clears the draft', () => {
    let s = typed('hello');
    s = composerReducer(s, { type: 'submit', nonce: 'n-00000001', blocked: false });
    expect(s).toMatchObject({ phase: 'sending', draft: 'hello', frame: { nonce: 'n-00000001', text: 'hello', submit: true, force: [] } });
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

  it('ack ok clears only what was sent: text typed mid-flight survives', () => {
    let s = composerReducer(typed('first'), { type: 'submit', nonce: 'n-0000000b', blocked: false });
    s = composerReducer(s, { type: 'edit', text: 'second' });
    s = composerReducer(s, { type: 'ack', nonce: 'n-0000000b', ok: true });
    expect(s).toMatchObject({ phase: 'acked', draft: 'second', frame: null });
  });

  it('an unconfirmed request is not reported as a plain send failure', () => {
    const sending = composerReducer(typed('maybe'), { type: 'submit', nonce: 'n-0000000c', blocked: false });
    expect(composerReducer(sending, { type: 'error', unconfirmed: true })).toMatchObject({ phase: 'failed', code: 'unconfirmed', draft: 'maybe' });
    expect(composerReducer(sending, { type: 'error' })).toMatchObject({ phase: 'failed', code: 'write-failed' });
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
    expect(s).toMatchObject({ phase: 'sending', frame: { nonce: 'n-00000004', submit: true, force: ['multiline'] } });
  });

  it('each accepted confirm waives only its own kind, and they accumulate across one frame', () => {
    // Blocked accepted (Insert), then the server asks multiline: the resend
    // carries both, and still no Enter.
    let s = composerReducer(typed('a\nb'), { type: 'submit', nonce: 'n-0000000d', blocked: true });
    s = composerReducer(s, { type: 'accept' });
    expect(s.frame).toMatchObject({ submit: false, force: ['blocked'] });
    s = composerReducer(s, { type: 'ack', nonce: 'n-0000000d', ok: false, code: 'confirm', confirm: 'multiline' });
    s = composerReducer(s, { type: 'accept' });
    expect(s.frame).toMatchObject({ nonce: 'n-0000000d', submit: false, force: ['blocked', 'multiline'] });
  });

  it('an ok ack that withheld the Enter is surfaced, and editing clears it', () => {
    let s = composerReducer(typed('hi'), { type: 'submit', nonce: 'n-0000000e', blocked: false });
    s = composerReducer(s, { type: 'ack', nonce: 'n-0000000e', ok: true, submitSkipped: true });
    expect(s).toMatchObject({ phase: 'acked', draft: '', submitSkipped: true });
    expect(composerReducer(s, { type: 'edit', text: 'x' }).submitSkipped).toBe(false);
  });

  it('blocked: the button reads Insert, pre-confirms, and inserts without Enter', () => {
    let s = typed('some text');
    expect(composerLabel(s, true)).toBe('insert');
    expect(composerLabel(s, false)).toBe('send');
    s = composerReducer(s, { type: 'submit', nonce: 'n-00000005', blocked: true });
    expect(s).toMatchObject({ phase: 'confirm', confirm: 'blocked', frame: { submit: false, force: [] } });
    s = composerReducer(s, { type: 'accept' });
    expect(s).toMatchObject({ phase: 'sending', frame: { nonce: 'n-00000005', submit: false, force: ['blocked'] } });
  });

  it('a SERVER blocked confirm (roster was stale) also turns the resend into an Insert', () => {
    let s = composerReducer(typed('y'), { type: 'submit', nonce: 'n-00000006', blocked: false });
    s = composerReducer(s, { type: 'ack', nonce: 'n-00000006', ok: false, code: 'confirm', confirm: 'blocked' });
    s = composerReducer(s, { type: 'accept' });
    expect(s.frame).toMatchObject({ nonce: 'n-00000006', submit: false, force: ['blocked'] });
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

  it('an ack that lands after unmount clears the stored draft only if it is still the sent text', () => {
    const st = mem();
    saveDraft(st, 'surf-a', 'sent text');
    clearSentDraft(st, 'surf-a', 'sent text');
    expect(loadDraft(st, 'surf-a')).toBe('');
    saveDraft(st, 'surf-a', 'newer draft');
    clearSentDraft(st, 'surf-a', 'sent text');
    expect(loadDraft(st, 'surf-a')).toBe('newer draft');
    expect(() => clearSentDraft(null, 'surf-a', 'x')).not.toThrow();
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
    expect(keyNeedsArming('esc', 'working')).toBe('interrupt');
    expect(keyNeedsArming('ctrl-c', 'working')).toBe('interrupt');
    expect(keyNeedsArming('enter', 'working')).toBeNull();
    for (const k of ['enter', 'y', 'n'] as const) expect(keyNeedsArming(k, 'blocked')).toBe('blocked');
    expect(keyNeedsArming('up', 'blocked')).toBeNull();
    expect(keyNeedsArming('esc', 'idle')).toBeNull();
    expect(keyNeedsArming('esc', null)).toBeNull();
  });

  it('first tap arms, second tap inside 1.5 s sends the SAME nonce with force', () => {
    let n = 0;
    const mint = () => `nonce-${++n}-xxxx`;
    const first = tapKey(null, 'esc', 'working', 1000, mint);
    expect(first.action).toBe('arm');
    const arm = first.action === 'arm' ? first.arm : null;
    expect(isArmed(arm, 'esc', 1000 + ARM_WINDOW_MS - 1)).toBe(true);
    const second = tapKey(arm, 'esc', 'working', 1000 + ARM_WINDOW_MS - 1, mint);
    expect(second).toEqual({ action: 'send', nonce: 'nonce-1-xxxx', force: ['interrupt'], arm: null });
  });

  it('an expired arm starts over, and a different key never borrows it', () => {
    const mint = () => 'nonce-fresh-1';
    const arm = { key: 'esc' as const, nonce: 'nonce-old-01', until: 2500, force: ['interrupt' as const] };
    expect(tapKey(arm, 'esc', 'working', 2500, mint)).toMatchObject({ action: 'arm', arm: { nonce: 'nonce-fresh-1' } });
    expect(tapKey(arm, 'up', 'working', 2000, mint)).toEqual({ action: 'send', nonce: 'nonce-fresh-1', force: [], arm: null });
  });

  it('a server confirm arms the refused nonce', () => {
    const arm = armFromConfirm('ctrl-c', 'nonce-refused', 100, 'interrupt');
    expect(arm).toEqual({ key: 'ctrl-c', nonce: 'nonce-refused', until: 100 + ARM_WINDOW_MS, force: ['interrupt'] });
    expect(tapKey(arm, 'ctrl-c', 'idle', 200, () => 'never')).toMatchObject({ nonce: 'nonce-refused', force: ['interrupt'] });
  });

  it('a second server confirm for a different kind keeps the first waiver', () => {
    const arm = armFromConfirm('enter', 'nonce-refused', 100, 'blocked', ['interrupt']);
    expect(arm.force).toEqual(['interrupt', 'blocked']);
    expect(armFromConfirm('enter', 'nonce-refused', 100, 'blocked', ['blocked']).force).toEqual(['blocked']);
  });
});

describe('review fixes, round 3 (#254)', () => {
  it('a draft longer than the welcome limit fails too-long locally: no frame, the text stays', () => {
    let s = typed('x'.repeat(11));
    s = composerReducer(s, { type: 'submit', nonce: 'n-00000001', blocked: false, maxText: 10 });
    expect(s).toMatchObject({ phase: 'failed', code: 'too-long', frame: null, draft: 'x'.repeat(11) });
    s = composerReducer(typed('x'.repeat(10)), { type: 'submit', nonce: 'n-00000002', blocked: false, maxText: 10 });
    expect(s.phase).toBe('sending');
  });

  it('on a blocked agent every answering key arms, and Esc/^C arm for BOTH server questions', () => {
    for (const k of ['enter', 'y', 'n', 'tab', 'shift-tab', 'backspace'] as const) {
      expect(keyArmKinds(k, 'blocked')).toEqual(['blocked']);
    }
    expect(keyArmKinds('esc', 'blocked')).toEqual(['blocked', 'interrupt']);
    expect(keyNeedsArming('esc', 'blocked')).toBe('interrupt');
    expect(keyArmKinds('ctrl-c', 'blocked')).toEqual(['interrupt']);
    expect(keyArmKinds('up', 'blocked')).toEqual([]);
    const first = tapKey(null, 'esc', 'blocked', 0, () => 'nonce-esc-00001');
    expect(first).toMatchObject({ action: 'arm', arm: { force: ['blocked', 'interrupt'] } });
    const second = tapKey(first.action === 'arm' ? first.arm : null, 'esc', 'blocked', 100, () => 'never');
    expect(second).toEqual({ action: 'send', nonce: 'nonce-esc-00001', force: ['blocked', 'interrupt'], arm: null });
  });

  it('a blocked waiver names only the prompt the phone displays, never a newer one the server names', () => {
    expect(waivablePrompt(7, 7)).toBe(7);
    expect(waivablePrompt(undefined, 7)).toBe(7);
    expect(waivablePrompt(8, 7)).toBeNull();
    expect(waivablePrompt(8, null)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildWireRoster,
  createNotifyState,
  diffNotifications,
  DoneTracker,
  mergeRosters,
  parseRosterSource,
  rosterChangeKey,
  sameQuestion,
  sortRoster,
  toWire,
} from '../../src/main/remote-console/roster';

describe('sameQuestion (#254)', () => {
  it('compares reason, ids and labels in order', () => {
    const s = {
      surfaceId: 'surf-00000001-0000-4000-8000-000000000000', workspaceId: 'ws', workspaceTitle: 'W', label: 'l', kind: null,
      state: 'blocked' as const, stateSource: 'declared' as const, blockedReason: 'r',
      choices: [{ id: 'y', label: 'Yes', isDefault: true }], answerPending: false, dwellMs: 0,
    };
    expect(sameQuestion(s, { reason: 'r', choices: [{ id: 'y', label: 'Yes' }] })).toBe(true);
    expect(sameQuestion(s, { reason: 'x', choices: [{ id: 'y', label: 'Yes' }] })).toBe(false);
    expect(sameQuestion(s, { reason: 'r', choices: [{ id: 'y', label: 'Oui' }] })).toBe(false);
    expect(sameQuestion(s, { reason: 'r', choices: [] })).toBe(false);
  });
});
import type { RemoteRosterSource } from '../../src/shared/remote-console-config';

const sid = (n: number): string => `surf-0000000${n}-0000-4000-8000-000000000000`;

function src(n: number, over: Partial<RemoteRosterSource> = {}): RemoteRosterSource {
  return {
    surfaceId: sid(n),
    workspaceId: 'ws-1',
    workspaceTitle: 'Work',
    label: `agent ${n}`,
    kind: 'claude',
    state: 'idle',
    stateSource: 'declared',
    blockedReason: null,
    choices: [],
    answerPending: false,
    dwellMs: 0,
    ...over,
  };
}

describe('mergeRosters (#254, #143)', () => {
  it('merges windows, first answer wins per surface', () => {
    const merged = mergeRosters([[src(1, { label: 'win1' })], [src(1, { label: 'win2' }), src(2)]]);
    expect(merged.map((e) => [e.surfaceId, e.label])).toEqual([[sid(1), 'win1'], [sid(2), 'agent 2']]);
  });

  it('drops malformed entries and non-array windows without throwing', () => {
    const merged = mergeRosters([
      null,
      'x',
      [
        null,
        { ...src(1), surfaceId: 'surf-nope' },
        { ...src(2), state: 'sleeping' },
        { ...src(3), answerPending: 'yes' },
        { ...src(4), stateSource: 'guessed' },
        { ...src(5), choices: 'nope' },
        { ...src(6), kind: 7 },
        src(7),
      ],
    ]);
    expect(merged.map((e) => e.surfaceId)).toEqual([sid(7)]);
    expect(mergeRosters('garbage')).toEqual([]);
  });

  it('drops a malformed choice, keeps its entry; strips extra fields', () => {
    const raw = {
      ...src(1),
      choices: [{ id: 'y', label: 'Yes', key: '1', text: 'secret' }, { id: 3 }, { id: 'n', label: 'No', isDefault: true }],
      metadata: { cwd: 'C:\\secret' },
      dwellMs: -5,
    };
    const e = parseRosterSource(raw);
    expect(e?.choices).toEqual([{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No', isDefault: true }]);
    expect(e?.dwellMs).toBe(0);
    expect(e).not.toHaveProperty('metadata');
  });
});

describe('toWire', () => {
  it('maps surfaceId to s and carries no key, text, cwd or metadata', () => {
    const wire = toWire(src(1, {
      state: 'blocked',
      blockedReason: 'permission: Bash',
      choices: [{ id: 'y', label: 'Yes' }],
    }), false);
    expect(wire.s).toBe(sid(1));
    expect(Object.keys(wire).sort()).toEqual([
      'answerPending', 'blockedReason', 'choices', 'done', 'dwellMs', 'kind', 'label',
      'promptId', 's', 'state', 'stateSource', 'workspaceId', 'workspaceTitle',
    ]);
    const json = JSON.stringify(wire);
    for (const bad of ['"key"', '"text"', 'cwd', 'metadata', 'surfaceId']) expect(json).not.toContain(bad);
  });

  it('promptId comes from main (the side that checks answers), null by default (#254)', () => {
    const t = new DoneTracker();
    const list = [src(1, { state: 'blocked', choices: [{ id: 'y', label: 'Yes' }] }), src(2, { state: 'idle' })];
    const wire = buildWireRoster(list, t, (s) => (s === sid(1) ? 41 : null));
    expect(wire.find((e) => e.s === sid(1))!.promptId).toBe(41);
    expect(wire.find((e) => e.s === sid(2))!.promptId).toBeNull();
    expect(toWire(src(3), false).promptId).toBeNull();
  });

  it('strips bidi, caps at 200, and carries ids the wire cannot as opaque index ids', () => {
    const wire = toWire(src(1, {
      label: 'a\u202Eb' + 'x'.repeat(300),
      choices: [{ id: 'ok_1', label: 'fine' }, { id: 'bad id', label: 'no\u202E' }, { id: 'x'.repeat(33), label: 'long' }],
    }), false);
    expect(wire.label.startsWith('ab')).toBe(true);
    expect(wire.label.length).toBe(200);
    expect(wire.choices).toEqual([{ id: 'ok_1', label: 'fine' }, { id: 'c1', label: 'no' }, { id: 'c2', label: 'long' }]);
  });

  it('an opaque id never collides with a real id spelled like one', () => {
    const wire = toWire(src(1, {
      choices: [{ id: 'c1', label: 'real c1' }, { id: 'allow once', label: 'Allow once' }, { id: '_c1', label: 'real _c1' }],
    }), false);
    const ids = wire.choices.map((c) => c.id);
    expect(ids).toEqual(['c1', '__c1', '_c1']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers choices (opaque ids included) and the prompt id only while the renderer copy is main\'s question', () => {
    const choices = [{ id: 'allow once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }];
    const blocked = src(1, { state: 'blocked', blockedReason: 'permission: Bash', choices });
    const view = { reason: 'permission: Bash', choices };
    const same = toWire(blocked, false, 7, view);
    expect(same.choices.map((c) => c.id)).toEqual(['c0', 'deny']);
    expect(same.promptId).toBe(7);
    // Reordered, or main no longer blocked: neither the buttons nor the id.
    for (const lag of [{ reason: 'permission: Bash', choices: [...choices].reverse() }, null]) {
      const w = toWire(blocked, false, 7, lag);
      expect(w.choices).toEqual([]);
      expect(w.promptId).toBeNull();
    }
  });

  it('never pairs one question\'s text with the next question\'s prompt id, even with the same ids (#254)', () => {
    // The renderer still shows prompt A; main already re-blocked on B with the
    // same wire-safe ids and bumped promptId. A tap on this card's Yes would
    // otherwise pass the stale check and answer B.
    const a = src(1, {
      state: 'blocked', blockedReason: 'Run tests?',
      choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    });
    const newReason = { reason: 'Drop prod table?', choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };
    const newLabels = { reason: 'Run tests?', choices: [{ id: 'yes', label: 'Yes, drop it' }, { id: 'no', label: 'No' }] };
    for (const b of [newReason, newLabels]) {
      const w = toWire(a, false, 42, b);
      expect(w.promptId).toBeNull();
      expect(w.choices).toEqual([]);
      expect(w.blockedReason).toBe('Run tests?');
    }
    const t = new DoneTracker();
    const [w] = buildWireRoster([a], t, () => 42, () => newReason);
    expect(w.promptId).toBeNull();
    const [ok] = buildWireRoster([a], t, () => 41, () => ({ reason: 'Run tests?', choices: a.choices }));
    expect(ok.promptId).toBe(41);
    expect(ok.choices.map((c) => c.id)).toEqual(['yes', 'no']);
  });

  it('unknown parity: a silent agent is state unknown, never done, and sorts last (#235)', () => {
    const t = new DoneTracker();
    t.update([src(1, { state: 'unknown', stateSource: null })], 0);
    t.update([src(1, { state: 'unknown', stateSource: null })], 1);
    const [w] = buildWireRoster([src(1, { state: 'unknown', stateSource: null })], t);
    expect(w.state).toBe('unknown');
    expect(w.done).toBe(false);
    expect(w.stateSource).toBeNull();
  });
});

describe('DoneTracker', () => {
  it('sets Done on working → idle and clears it on seen/attach, working, disappearance', () => {
    const t = new DoneTracker();
    t.update([src(1, { state: 'working' })], 100);
    expect(t.doneAt(sid(1))).toBeNull();
    t.update([src(1, { state: 'idle' })], 200);
    expect(t.doneAt(sid(1))).toBe(200);
    expect(t.clear(sid(1))).toBe(true);
    expect(t.clear(sid(1))).toBe(false);

    t.update([src(1, { state: 'working' })], 300);
    t.update([src(1, { state: 'idle' })], 400);
    t.update([src(1, { state: 'working' })], 500);
    expect(t.doneAt(sid(1))).toBeNull();

    t.update([src(1, { state: 'idle' })], 600);
    expect(t.doneAt(sid(1))).toBe(600);
    t.update([], 700);
    expect(t.doneAt(sid(1))).toBeNull();
  });

  it('idle → idle and blocked → idle are not Done', () => {
    const t = new DoneTracker();
    t.update([src(1, { state: 'blocked' })], 1);
    t.update([src(1, { state: 'idle' })], 2);
    expect(t.doneAt(sid(1))).toBeNull();
  });
});

describe('sortRoster', () => {
  it('blocked (longest dwell first), done (newest first), working, idle, unknown', () => {
    const entries = [
      { src: src(1, { state: 'unknown' }), doneAt: null },
      { src: src(2, { state: 'idle' }), doneAt: null },
      { src: src(3, { state: 'working' }), doneAt: null },
      { src: src(4, { state: 'idle' }), doneAt: 10 },
      { src: src(5, { state: 'idle' }), doneAt: 20 },
      { src: src(6, { state: 'blocked', dwellMs: 5 }), doneAt: null },
      { src: src(7, { state: 'blocked', dwellMs: 50 }), doneAt: null },
    ];
    expect(sortRoster(entries).map((e) => e.src.surfaceId)).toEqual([7, 6, 5, 4, 3, 2, 1].map(sid));
  });
});

describe('rosterChangeKey', () => {
  it('ignores dwellMs so a growing dwell is not a change', () => {
    const a = [toWire(src(1, { state: 'blocked', dwellMs: 1000 }), false)];
    const b = [toWire(src(1, { state: 'blocked', dwellMs: 3000 }), false)];
    const c = [toWire(src(1, { state: 'idle' }), false)];
    expect(rosterChangeKey(a)).toBe(rosterChangeKey(b));
    expect(rosterChangeKey(a)).not.toBe(rosterChangeKey(c));
  });
});

describe('diffNotifications', () => {
  it('the first call only seeds: an already-blocked agent is not news', () => {
    const st = createNotifyState();
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 0)).toEqual([]);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 10_000)).toEqual([]);
  });

  it('blocked edge is debounced 5 s and re-checked', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' })], 0);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 1000)).toEqual([]);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 5999)).toEqual([]);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 6000)).toEqual([
      { kind: 'blocked', s: sid(1), label: 'agent 1', at: 6000 },
    ]);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 9000)).toEqual([]);
  });

  it('a blocked edge that is answered within the debounce is dropped', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' })], 0);
    diffNotifications(st, [src(1, { state: 'blocked' })], 1000);
    expect(diffNotifications(st, [src(1, { state: 'blocked', answerPending: true })], 7000)).toEqual([]);
    const st2 = createNotifyState();
    diffNotifications(st2, [src(1, { state: 'working' })], 0);
    diffNotifications(st2, [src(1, { state: 'blocked' })], 1000);
    expect(diffNotifications(st2, [src(1, { state: 'working' })], 7000)).toEqual([]);
  });

  it('done edge is debounced 3 s', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' })], 0);
    diffNotifications(st, [src(1, { state: 'idle' })], 1000);
    expect(diffNotifications(st, [src(1, { state: 'idle' })], 3999)).toEqual([]);
    expect(diffNotifications(st, [src(1, { state: 'idle' })], 4000)).toEqual([{ kind: 'done', s: sid(1), label: 'agent 1', at: 4000 }]);
  });

  it('at most one notification per surface per 10 s', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' })], 0);
    diffNotifications(st, [src(1, { state: 'idle' })], 1000);
    expect(diffNotifications(st, [src(1, { state: 'idle' })], 4000)).toHaveLength(1);
    diffNotifications(st, [src(1, { state: 'blocked' })], 5000);
    // Due at 10 000 but only 6 s after the last one: suppressed, and not retried.
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 10_000)).toEqual([]);
    expect(diffNotifications(st, [src(1, { state: 'blocked' })], 20_000)).toEqual([]);
  });

  it('a vanished surface never notifies; unknown never notifies', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' }), src(2, { state: 'unknown' })], 0);
    diffNotifications(st, [src(1, { state: 'blocked' }), src(2, { state: 'unknown' })], 1000);
    expect(diffNotifications(st, [src(2, { state: 'unknown' })], 7000)).toEqual([]);
  });

  it('the label is sanitised', () => {
    const st = createNotifyState();
    diffNotifications(st, [src(1, { state: 'working' })], 0);
    diffNotifications(st, [src(1, { state: 'idle', label: 'x\u202Ey' })], 1000);
    expect(diffNotifications(st, [src(1, { state: 'idle', label: 'x\u202Ey' })], 5000)[0].label).toBe('xy');
  });
});

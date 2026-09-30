import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupWaveAgents } from '../../src/renderer/components/Sidebar/orchestration-groups';
import type { OrchestrationAgent } from '../../src/shared/types';

const agent = (id: string, group?: unknown, status: OrchestrationAgent['status'] = 'running') =>
  ({ id, label: id, status, ...(group === undefined ? {} : { group }) }) as OrchestrationAgent;

const ids = (agents: OrchestrationAgent[]) => agents.map((a) => a.id);

describe('groupWaveAgents', () => {
  it('returns plain agent items when nothing is grouped', () => {
    const items = groupWaveAgents([agent('a'), agent('b')]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('returns nothing for an empty wave', () => {
    expect(groupWaveAgents([])).toEqual([]);
  });

  it('collects members of one group, keeping agents[] order', () => {
    const items = groupWaveAgents([agent('a', 'x'), agent('b'), agent('c', 'x'), agent('d', 'x')]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'group', name: 'x', total: 3 });
    expect(items[0].kind === 'group' && ids(items[0].agents)).toEqual(['a', 'c', 'd']);
    expect(items[1]).toMatchObject({ kind: 'agent', agent: { id: 'b' } });
  });

  it('orders items by first appearance with interleaved groups', () => {
    const items = groupWaveAgents([
      agent('a', 'x'),
      agent('b', 'y'),
      agent('c', 'x'),
      agent('d', 'y'),
      agent('e'),
    ]);
    expect(items.map((i) => (i.kind === 'group' ? i.name : i.agent.id))).toEqual(['x', 'y', 'e']);
  });

  it('returns a one-member group as a plain agent', () => {
    const items = groupWaveAgents([agent('a', 'solo'), agent('b')]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('counts done as exited or failed', () => {
    const [group] = groupWaveAgents([
      agent('a', 'x', 'exited'),
      agent('b', 'x', 'failed'),
      agent('c', 'x', 'running'),
      agent('d', 'x', 'pending'),
    ]);
    expect(group).toMatchObject({ kind: 'group', done: 2, total: 4 });
  });

  it('trims group names and merges padded spellings into one group', () => {
    const items = groupWaveAgents([agent('a', ' x '), agent('b', 'x'), agent('c', '\tx\n')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'group', name: 'x', total: 3 });
  });

  it('compares group names case-sensitively', () => {
    const items = groupWaveAgents([agent('a', 'X'), agent('b', 'x'), agent('c', 'X'), agent('d', 'x')]);
    expect(items.map((i) => (i.kind === 'group' ? i.name : '?'))).toEqual(['X', 'x']);
  });

  it.each([
    ['number', 5],
    ['object', { name: 'x' }],
    ['array', ['x']],
    ['null', null],
    ['empty string', ''],
    ['blank string', '   '],
    ['boolean', true],
  ])('treats a %s group as ungrouped without throwing', (_label, value) => {
    const items = groupWaveAgents([agent('a', value), agent('b', value)]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('keeps malformed-group agents apart from a real group', () => {
    const items = groupWaveAgents([agent('a', 'x'), agent('b', 5), agent('c', 'x')]);
    expect(items.map((i) => i.kind)).toEqual(['group', 'agent']);
  });

  it('does not throw on non-object entries in agents[]', () => {
    const junk = [null, undefined, 'a'] as unknown as OrchestrationAgent[];
    expect(() => groupWaveAgents(junk)).not.toThrow();
  });
});

const JSON_TOOL = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts/json-tool.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-orch-cells-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let stateSeq = 0;
function query(waves: unknown[][], name: string, wave: number): string[] {
  const file = path.join(tmpDir, `state-${stateSeq++}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: 't', status: 'running', waves: waves.map((agents, index) => ({ index, agents })) }));
  const out = execFileSync(process.execPath, [JSON_TOOL, 'query', file, name, String(wave)], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l !== '');
}

const cellsOf = (agents: unknown[]) =>
  query([agents], 'wave-cells-each', 0).map((l) => (JSON.parse(l) as { _cell: number })._cell);

describe('json-tool wave-cells-each / wave-cell-count', () => {
  it('gives every agent its own cell when nothing is grouped', () => {
    expect(cellsOf([agent('a'), agent('b'), agent('c')])).toEqual([0, 1, 2]);
  });

  it('shares a cell between members of a group, numbering by first appearance', () => {
    expect(cellsOf([agent('a', 'x'), agent('b'), agent('c', 'x'), agent('d', 'x')])).toEqual([0, 1, 0, 0]);
  });

  it('prints each agent object unchanged apart from _cell, in agents[] order', () => {
    const lines = query([[agent('a', 'x'), agent('b')]], 'wave-cells-each', 0).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { id: 'a', label: 'a', status: 'running', group: 'x', _cell: 0 },
      { id: 'b', label: 'b', status: 'running', _cell: 1 },
    ]);
  });

  it('counts distinct cells', () => {
    const agents = [agent('a', 'x'), agent('b'), agent('c', 'x'), agent('d', 'y')];
    expect(query([agents], 'wave-cell-count', 0)).toEqual(['3']);
  });

  it('counts 0 cells and prints no rows for an empty or missing wave', () => {
    expect(query([[]], 'wave-cell-count', 0)).toEqual(['0']);
    expect(query([[]], 'wave-cell-count', 5)).toEqual(['0']);
    expect(query([[]], 'wave-cells-each', 0)).toEqual([]);
    expect(query([[]], 'wave-cells-each', 5)).toEqual([]);
  });

  it('only looks at the requested wave', () => {
    const waves = [[agent('a', 'x'), agent('b', 'x')], [agent('c', 'x'), agent('d')]];
    expect(query(waves, 'wave-cell-count', 0)).toEqual(['1']);
    expect(query(waves, 'wave-cell-count', 1)).toEqual(['2']);
  });
});

// Every fixture is a wave; the table is shared by the json-tool and parity tests.
const FIXTURES: [string, unknown[]][] = [
  ['no groups', [agent('a'), agent('b'), agent('c')]],
  ['one group', [agent('a', 'x'), agent('b', 'x'), agent('c', 'x')]],
  ['interleaved groups', [agent('a', 'x'), agent('b', 'y'), agent('c', 'x'), agent('d', 'y'), agent('e')]],
  ['singleton group', [agent('a', 'solo'), agent('b'), agent('c', 'x'), agent('d', 'x')]],
  ['whitespace-padded names', [agent('a', ' x '), agent('b', 'x'), agent('c', '\tx\n'), agent('d', 'X')]],
  ['number group', [agent('a', 5), agent('b', 5), agent('c', 'x'), agent('d', 'x')]],
  ['object group', [agent('a', { name: 'x' }), agent('b', { name: 'x' }), agent('c', 'x')]],
  ['array group', [agent('a', ['x']), agent('b', ['x']), agent('c', 'x'), agent('d', 'x')]],
  ['null group', [agent('a', null), agent('b', null), agent('c', 'x'), agent('d', 'x')]],
  ['empty group', [agent('a', ''), agent('b', ''), agent('c', 'x'), agent('d', 'x')]],
  ['blank group', [agent('a', '  '), agent('b', '  '), agent('c', 'x'), agent('d', 'x')]],
  ['null entries', [agent('a', 'x'), null, agent('b', 'x'), null]],
  ['empty wave', []],
];

// Item k of groupWaveAgents is cell k; recover each input agent's cell from that.
function cellsFromHelper(agents: unknown[]): number[] {
  const items = groupWaveAgents(agents as OrchestrationAgent[]);
  const byRef = new Map<unknown, number>();
  const loose: number[] = [];
  items.forEach((item, k) => {
    for (const a of item.kind === 'group' ? item.agents : [item.agent]) {
      if (a !== null && typeof a === 'object') byRef.set(a, k);
      else loose.push(k);
    }
  });
  return agents.map((a) => (a !== null && typeof a === 'object' ? (byRef.get(a) as number) : (loose.shift() as number)));
}

describe('groupWaveAgents and json-tool agree on cells', () => {
  it.each(FIXTURES)('%s', (_label, agents) => {
    expect(cellsFromHelper(agents)).toEqual(cellsOf(agents));
  });

  it.each(FIXTURES)('%s: cell count matches the helper item count', (_label, agents) => {
    const count = Number(query([agents], 'wave-cell-count', 0)[0]);
    expect(count).toBe(groupWaveAgents(agents as OrchestrationAgent[]).length);
  });
});

function findSpawned(stdin: string, label: string, paneId: string): string {
  return execFileSync(process.execPath, [JSON_TOOL, 'find-spawned', label, paneId], { encoding: 'utf8', input: stdin }).trim();
}

const listed = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  surfaceId: `surf-${agentId}`,
  paneId: 'pane-1',
  label: 'L',
  status: 'running',
  spawnTime: 1,
  ...over,
});

describe('json-tool find-spawned', () => {
  it('prints the running agent with that label in that pane', () => {
    const out = findSpawned(JSON.stringify({ agents: [listed('x')] }, null, 2), 'L', 'pane-1');
    expect(JSON.parse(out)).toMatchObject({ agentId: 'x', surfaceId: 'surf-x' });
  });

  it('takes the newest spawnTime when several match', () => {
    const agents = [listed('old', { spawnTime: 10 }), listed('new', { spawnTime: 30 }), listed('mid', { spawnTime: 20 })];
    expect(JSON.parse(findSpawned(JSON.stringify({ agents }), 'L', 'pane-1')).agentId).toBe('new');
  });

  it('accepts a bare array as well as the CLI\'s {agents} reply', () => {
    expect(JSON.parse(findSpawned(JSON.stringify([listed('x')]), 'L', 'pane-1')).agentId).toBe('x');
  });

  it('ignores another pane, another label, and anything not running', () => {
    const agents = [
      listed('a', { paneId: 'pane-2' }),
      listed('b', { label: 'other' }),
      listed('c', { status: 'exited' }),
      listed('d', { status: 'spawning' }),
      null,
      'junk',
    ];
    expect(findSpawned(JSON.stringify({ agents }), 'L', 'pane-1')).toBe('');
  });

  it('prints nothing for input that is not an agent list', () => {
    expect(findSpawned('', 'L', 'pane-1')).toBe('');
    expect(findSpawned('not json', 'L', 'pane-1')).toBe('');
    expect(findSpawned('{"error":"wmux not running"}', 'L', 'pane-1')).toBe('');
  });
});

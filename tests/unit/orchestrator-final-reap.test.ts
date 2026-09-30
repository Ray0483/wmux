import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashExists, forBash, hasBash } from '../helpers/bash-path';
import { createWmuxStub, removeWmuxStub, type WmuxStub } from '../helpers/wmux-stub';

const SCRIPTS = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts');
const STOP = path.join(SCRIPTS, 'on-stop.sh');
const STATE_LIB = path.join(SCRIPTS, 'orchestration-state.sh');

const stopPath = forBash(STOP);
const stateLibPath = forBash(STATE_LIB);
const canRun = hasBash() && bashExists(stopPath);

let base: string;
let stub: WmuxStub;

function writeRun(name: string, state: Record<string, unknown>): string {
  const dir = path.join(base, `wmux-orch-${name}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: name, task: 't', ...state }));
  return dir;
}

function finishedRun(name: string, extra: Record<string, unknown> = {}): string {
  return writeRun(name, {
    status: 'complete',
    coordinatorPaneId: 'pane-coord',
    waves: [
      {
        status: 'complete',
        agents: [{ id: `${name}-a1`, status: 'exited', wmuxAgentId: `agent-${name}`, surfaceId: `surf-${name}`, paneId: `pane-${name}` }],
      },
    ],
    ...extra,
  });
}

const readState = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

function stop() {
  return stub.bash(`bash "${stopPath}"`, { TMPDIR: forBash(base) });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-final-reap-'));
  stub = createWmuxStub();
});

afterEach(() => {
  removeWmuxStub(stub);
  fs.rmSync(base, { recursive: true, force: true });
});

// Each hook run spawns several node processes under Git Bash, ~2-3 s on Windows.
const SLOW = 30_000;

describe.skipIf(!canRun)('on-stop.sh final reap', { timeout: SLOW }, () => {
  it('reaps a complete run once and marks it reaped', () => {
    const dir = finishedRun('one');
    stub.assertReachable();

    const first = stop();

    expect(first.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill agent-one', 'close-surface surf-one']);
    expect(readState(dir).reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(readState(dir).waves[0].agents[0].reapedAt).toBeTruthy();

    stub.clearCalls();
    const second = stop();

    expect(second.status).toBe(0);
    expect(stub.calls()).toEqual([]);
  });

  it.each(['aborted', 'failed'])('reaps a %s run too', (status) => {
    const dir = finishedRun('x', { status });
    stub.assertReachable();

    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill agent-x', 'close-surface surf-x']);
    expect(readState(dir).reapedAt).toBeTruthy();
  });

  it('skips a running run, a run without coordinatorPaneId and an already reaped run', () => {
    const running = finishedRun('run', { status: 'running' });
    const noCoord = finishedRun('nocoord', { coordinatorPaneId: undefined });
    const reaped = finishedRun('done', { reapedAt: '2026-01-01T00:00:00Z' });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(running).reapedAt).toBeUndefined();
    expect(readState(noCoord).reapedAt).toBeUndefined();
    expect(readState(reaped).reapedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('makes no wmux call when there is no run at all', () => {
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(stub.calls()).toEqual([]);
  });

  it('reaps every finished run in one hook call', () => {
    const a = finishedRun('a');
    const b = finishedRun('b');
    stub.assertReachable();

    stop();

    const calls = stub.calls();
    expect(calls).toContain('close-surface surf-a');
    expect(calls).toContain('close-surface surf-b');
    expect(readState(a).reapedAt).toBeTruthy();
    expect(readState(b).reapedAt).toBeTruthy();
  });

  it('keeps the in-progress warning and does not reap the running run', () => {
    writeRun('live', {
      status: 'running',
      coordinatorPaneId: 'pane-coord',
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'running', surfaceId: 's1', paneId: 'p1' }] }],
    });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARNING: wmux orchestration in progress with 1 active agent(s).');
    expect(stub.calls()).toEqual([]);
  });

  it('still warns about a running run while reaping a finished one', () => {
    writeRun('live', {
      status: 'running',
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'running' }] }],
    });
    const dir = finishedRun('old');
    stub.assertReachable();

    const r = stop();

    expect(r.stdout).toContain('WARNING: wmux orchestration in progress');
    expect(stub.calls()).toContain('close-surface surf-old');
    expect(readState(dir).reapedAt).toBeTruthy();
  });

  it('leaves a finished run alone when wmux is unreachable, so the next Stop retries', () => {
    const down = createWmuxStub({ pingFails: true });
    try {
      const dir = finishedRun('one');
      down.assertReachable();

      const r = down.bash(`bash "${stopPath}"`, { TMPDIR: forBash(base) });

      expect(r.status).toBe(0);
      expect(down.calls().every((c) => c === 'ping')).toBe(true);
      expect(down.calls().length).toBeGreaterThan(0);
      expect(readState(dir).reapedAt).toBeUndefined();
      expect(readState(dir).waves[0].agents[0].reapedAt).toBeUndefined();
    } finally {
      removeWmuxStub(down);
    }
  });

  it('reaps a run whose coordinator-pane agent has no reapedAt, and marks the run', () => {
    const dir = finishedRun('mixed', {
      waves: [
        {
          status: 'complete',
          agents: [
            { id: 'w1', status: 'exited', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'pane-w1' },
            { id: 'c1', status: 'exited', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'pane-coord' },
          ],
        },
      ],
    });
    stub.assertReachable();

    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(readState(dir).reapedAt).toBeTruthy();
    expect(readState(dir).waves[0].agents[1].reapedAt).toBeUndefined();

    stub.clearCalls();
    stop();
    expect(stub.calls()).toEqual([]);
  });
});

describe.skipIf(!canRun)('find_unreaped_finished_orchs', { timeout: SLOW }, () => {
  it('scans every run dir with a single node process and makes no wmux call', () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-node-shim-'));
    try {
      const realNode = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
      expect(realNode).not.toBe('');
      const log = path.join(shimDir, 'node.log');
      fs.writeFileSync(log, '');
      fs.writeFileSync(path.join(shimDir, 'node'), `#!/usr/bin/env bash\necho x >> "${forBash(log)}"\nexec "${realNode}" "$@"\n`, { mode: 0o755 });

      const a = finishedRun('a');
      const b = finishedRun('b', { status: 'failed' });
      finishedRun('c', { status: 'running' });
      finishedRun('d', { reapedAt: '2026-01-01T00:00:00Z' });
      finishedRun('e', { coordinatorPaneId: undefined });
      stub.assertReachable();

      const r = stub.bash(
        `export PATH="${forBash(shimDir)}:$PATH"; source "${stateLibPath}"; : > "${forBash(log)}"; find_unreaped_finished_orchs`,
        { TMPDIR: forBash(base) },
      );

      const dirs = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(dirs.map((d) => path.basename(d))).toEqual([path.basename(a), path.basename(b)]);
      expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(stub.calls()).toEqual([]);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

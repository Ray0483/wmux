import { describe, it, expect, vi, afterEach } from 'vitest';
import { distributeAgents, AgentManager } from '../../src/main/agent-manager';

/**
 * Minimal PtyManager stand-in. Captures the data and exit callbacks per
 * surface so a test can feed shell output / exits by hand. `consumed` is what
 * create() reports as `startupCommandsConsumed`.
 */
function fakePtyManager(consumed = false) {
  const exitCallbacks = new Map<string, (code: number) => void>();
  const dataCallbacks = new Map<string, (data: string) => void>();
  let nextId = 0;
  return {
    exitCallbacks,
    dataCallbacks,
    create: vi.fn(() => ({ id: `surf-${++nextId}`, shell: 'pwsh.exe', startupCommandsConsumed: consumed, reused: false })),
    onData: vi.fn((id: string, cb: (data: string) => void) => { dataCallbacks.set(id, cb); return () => { dataCallbacks.delete(id); }; }),
    onExit: vi.fn((id: string, cb: (code: number) => void) => { exitCallbacks.set(id, cb); }),
    getPid: vi.fn(() => 1234),
    has: vi.fn(() => true),
    write: vi.fn(),
    kill: vi.fn(),
  };
}

function spawnOne(pty: ReturnType<typeof fakePtyManager>, cmd = 'echo hi') {
  const manager = new AgentManager(pty as any);
  const onAgentExit = vi.fn();
  manager.setOnAgentExit(onAgentExit);
  const { agentId, surfaceId } = manager.spawn({
    cmd, label: 'worker-1', paneId: 'pane-1' as any, workspaceId: 'ws-1' as any,
  });
  return { manager, onAgentExit, agentId, surfaceId };
}

describe('Agent Manager', () => {
  describe('spawn: command delivery', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('hands the cmd to the shell as a startup command and never types it when the PTY consumed it', () => {
      vi.useFakeTimers();
      const pty = fakePtyManager(true);
      spawnOne(pty, 'claude -p "do the thing"');

      expect(pty.create).toHaveBeenCalledTimes(1);
      expect((pty.create.mock.calls[0] as any[])[0]).toMatchObject({ startupCommands: ['claude -p "do the thing"'] });
      // No prompt sniffing at all: the integration script runs the command
      // during init, before the first prompt, so a second delivery would run
      // it twice.
      expect(pty.onData).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(pty.write).not.toHaveBeenCalled();
    });

    it('never types the cmd itself, whatever the PTY reports — PtyManager owns delivery (#251)', () => {
      // The prompt sniff that used to live here (and its tests) moved to
      // startup-commands.ts, where PtyManager applies it for every caller. A
      // second, independent delivery from this class is how a command runs
      // twice, so even a PTY answering "not consumed" gets no keystrokes here.
      vi.useFakeTimers();
      const pty = fakePtyManager(false);
      spawnOne(pty);
      expect((pty.create.mock.calls[0] as any[])[0]).toMatchObject({ startupCommands: ['echo hi'] });
      expect(pty.onData).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(pty.write).not.toHaveBeenCalled();
    });
  });

  describe('distributeAgents', () => {
    it('distributes evenly across panes', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 1 },
        { paneId: 'pane-2', tabCount: 1 },
        { paneId: 'pane-3', tabCount: 1 },
      ];
      const result = distributeAgents(3, panes);
      expect(result).toEqual(['pane-1', 'pane-2', 'pane-3']);
    });

    it('fills least-loaded panes first', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 3 },
        { paneId: 'pane-2', tabCount: 1 },
        { paneId: 'pane-3', tabCount: 2 },
      ];
      const result = distributeAgents(3, panes);
      expect(result).toEqual(['pane-2', 'pane-3', 'pane-1']);
    });

    it('round-robins when more agents than panes', () => {
      const panes = [
        { paneId: 'pane-1', tabCount: 1 },
        { paneId: 'pane-2', tabCount: 1 },
      ];
      const result = distributeAgents(5, panes);
      expect(result.length).toBe(5);
      expect(result.filter((p) => p === 'pane-1').length).toBe(3);
      expect(result.filter((p) => p === 'pane-2').length).toBe(2);
    });

    it('handles single pane', () => {
      const panes = [{ paneId: 'pane-1', tabCount: 0 }];
      const result = distributeAgents(4, panes);
      expect(result).toEqual(['pane-1', 'pane-1', 'pane-1', 'pane-1']);
    });
  });

  describe('exit broadcast (setOnAgentExit)', () => {
    it('invokes the exit listener with type/surface info when the PTY exits', () => {
      const pty = fakePtyManager();
      const { onAgentExit, agentId, surfaceId } = spawnOne(pty);

      expect(onAgentExit).not.toHaveBeenCalled();
      pty.exitCallbacks.get(surfaceId)!(0);

      expect(onAgentExit).toHaveBeenCalledTimes(1);
      expect(onAgentExit.mock.calls[0][0]).toMatchObject({
        agentId, surfaceId, status: 'exited', exitCode: 0,
      });
    });

    it('kill() notifies once; a later PTY exit does not duplicate the broadcast', () => {
      const pty = fakePtyManager();
      const { manager, onAgentExit, agentId, surfaceId } = spawnOne(pty);

      expect(manager.kill(agentId)).toBe(true);
      expect(pty.kill).toHaveBeenCalledWith(surfaceId);
      expect(onAgentExit).toHaveBeenCalledTimes(1);
      expect(onAgentExit.mock.calls[0][0]).toMatchObject({ surfaceId, status: 'exited', exitCode: -1 });

      // The killed PTY's real exit event arrives afterwards — must be a no-op.
      pty.exitCallbacks.get(surfaceId)!(1);
      expect(onAgentExit).toHaveBeenCalledTimes(1);
    });
  });
});

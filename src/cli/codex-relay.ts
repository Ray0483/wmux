/** Per-terminal, authenticated loopback transport. No transcript is logged or saved. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { createInterface } from 'readline';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexSessionTracker } from './codex-session-tracker';

export interface CodexRelayOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onSession: (id: string) => void;
}

export interface CodexRelay {
  url: string;
  token: string;
  tracker: CodexSessionTracker;
  close(): Promise<void>;
}

export async function createCodexRelay(options: CodexRelayOptions): Promise<CodexRelay> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let connected = false;
  let closing = false;
  let backend: ChildProcessWithoutNullStreams | undefined;
  const tracker = new CodexSessionTracker(options.onSession);
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, maxPayload: 100 * 1024 * 1024,
    verifyClient: ({ req }, done) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const allowed = !connected && !closing && !req.headers.origin &&
        supplied.length === expected.length && timingSafeEqual(supplied, expected);
      done(allowed, 401);
    },
  });
  server.on('connection', socket => {
    connected = true;
    backend = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = backend;
    // Codex writes diagnostics to its own logs. Do not mix backend stderr into
    // the terminal's TUI or retain potentially sensitive protocol content here.
    child.stderr.resume();
    child.stdin.on('error', () => socket.close(1011, 'Codex input closed'));
    child.stdout.on('error', () => socket.close(1011, 'Codex output closed'));
    child.on('error', () => socket.close(1011, 'Could not start Codex app-server'));
    child.on('exit', () => socket.close());
    socket.on('message', raw => {
      const text = raw.toString();
      tracker.request(text);
      if (!child.stdin.write(text + '\n')) socket.pause();
    });
    child.stdin.on('drain', () => socket.resume());
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      tracker.response(line);
      if (socket.readyState !== WebSocket.OPEN) return;
      child.stdout.pause();
      socket.send(line, () => child.stdout.resume());
    });
    socket.on('error', () => { child.stdin.end(); });
    socket.on('close', () => { child.stdin.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No Codex relay address');
  return {
    url: `ws://127.0.0.1:${address.port}`, token, tracker,
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of server.clients) socket.terminate();
      server.close();
      if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
      const child = backend;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { child.kill(); resolve(); }, 1500);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.stdin.end();
      });
    },
  };
}

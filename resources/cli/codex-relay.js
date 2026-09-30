"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCodexRelay = createCodexRelay;
/** Per-terminal, authenticated loopback transport. No transcript is logged or saved. */
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const readline_1 = require("readline");
const ws_1 = require("ws");
const codex_session_tracker_1 = require("./codex-session-tracker");
async function createCodexRelay(options) {
    const token = (0, crypto_1.randomBytes)(32).toString('hex');
    const expected = Buffer.from(`Bearer ${token}`);
    let connected = false;
    let closing = false;
    let backend;
    const tracker = new codex_session_tracker_1.CodexSessionTracker(options.onSession);
    const server = new ws_1.WebSocketServer({
        host: '127.0.0.1', port: 0, maxPayload: 100 * 1024 * 1024,
        verifyClient: ({ req }, done) => {
            const supplied = Buffer.from(req.headers.authorization ?? '');
            const allowed = !connected && !closing && !req.headers.origin &&
                supplied.length === expected.length && (0, crypto_1.timingSafeEqual)(supplied, expected);
            done(allowed, 401);
        },
    });
    server.on('connection', socket => {
        connected = true;
        backend = (0, child_process_1.spawn)(options.executable, options.args, {
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
            if (!child.stdin.write(text + '\n'))
                socket.pause();
        });
        child.stdin.on('drain', () => socket.resume());
        const lines = (0, readline_1.createInterface)({ input: child.stdout });
        lines.on('line', line => {
            tracker.response(line);
            if (socket.readyState !== ws_1.WebSocket.OPEN)
                return;
            child.stdout.pause();
            socket.send(line, () => child.stdout.resume());
        });
        socket.on('error', () => { child.stdin.end(); });
        socket.on('close', () => { child.stdin.end(); });
    });
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('No Codex relay address');
    return {
        url: `ws://127.0.0.1:${address.port}`, token, tracker,
        async close() {
            if (closing)
                return;
            closing = true;
            for (const socket of server.clients)
                socket.terminate();
            server.close();
            if (!backend || backend.exitCode !== null || backend.signalCode !== null)
                return;
            const child = backend;
            await new Promise(resolve => {
                const timeout = setTimeout(() => { child.kill(); resolve(); }, 1500);
                child.once('exit', () => { clearTimeout(timeout); resolve(); });
                child.stdin.end();
            });
        },
    };
}

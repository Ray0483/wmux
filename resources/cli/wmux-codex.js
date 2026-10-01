#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexLaunchPlan = codexLaunchPlan;
exports.runWmuxCodex = runWmuxCodex;
/** Launched by wmux's private PATH shims using wmux's resolved Node runtime. */
const child_process_1 = require("child_process");
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
const codex_relay_1 = require("./codex-relay");
const NON_INTERACTIVE = new Set([
    'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
    'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug',
    'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive',
    'cloud', 'exec-server', 'features', 'help',
]);
const VALUE_OPTIONS = new Set([
    '-c', '--config', '--enable', '--disable', '--code-mode-host', '-m', '--model',
    '-i', '--image', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
    '-a', '--ask-for-approval', '--local-provider', '--remote', '--remote-auth-token-env',
]);
const SERVER_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--code-mode-host']);
function codexLaunchPlan(args, cwd) {
    let interactive = true;
    let positional = false;
    const serverArgs = ['app-server', '--stdio'];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--')
            break;
        const key = arg.split('=')[0];
        if (['-h', '--help', '-V', '--version', '--remote', '--remote-auth-token-env'].includes(key))
            interactive = false;
        // A remote TUI cannot apply local profile/worktree/provider bootstrapping.
        // Keep these invocations native instead of silently changing their meaning.
        if (['-p', '--profile', '--worktree', '--oss', '--local-provider'].includes(key))
            interactive = false;
        if (key === '--strict-config')
            serverArgs.push(arg);
        if (VALUE_OPTIONS.has(key)) {
            const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
            if (value === undefined) {
                interactive = false;
                break;
            }
            if (SERVER_OPTIONS.has(key))
                serverArgs.push(key, value);
            if (key === '-C' || key === '--cd')
                cwd = path_1.default.resolve(cwd, value);
            continue;
        }
        if (!arg.startsWith('-') && !positional) {
            positional = true;
            if (NON_INTERACTIVE.has(arg))
                interactive = false;
        }
    }
    return { interactive, serverArgs, cwd };
}
/** Authenticated local pipe only; never send environment variables or transcripts. */
function wmuxRequest(method, params) {
    return new Promise((resolve, reject) => {
        const pipe = process.env.WMUX_PIPE;
        const token = process.env.WMUX_PIPE_TOKEN;
        if (!pipe || !token) {
            reject(new Error('Outside wmux'));
            return;
        }
        const socket = net_1.default.connect(pipe);
        let data = '';
        const timer = setTimeout(() => finish(new Error('wmux did not respond')), 2000);
        const finish = (error, result) => {
            clearTimeout(timer);
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve(result);
        };
        socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params, token }) + '\n'));
        socket.on('data', chunk => {
            data += chunk.toString();
            if (data.length > 64 * 1024) {
                finish(new Error('Invalid wmux response'));
                return;
            }
            const line = data.split('\n')[0];
            if (!data.includes('\n'))
                return;
            try {
                const response = JSON.parse(line);
                if (response.error)
                    finish(new Error(response.error.message));
                else
                    finish(undefined, response.result);
            }
            catch {
                finish(new Error('Invalid wmux response'));
            }
        });
        socket.on('error', error => finish(error));
        socket.on('end', () => finish(new Error('wmux disconnected')));
    });
}
function supportsRemote(executable, env) {
    return new Promise(resolve => {
        (0, child_process_1.execFile)(executable, ['--help'], { env, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
            resolve(!error && stdout.includes('--remote-auth-token-env'));
        });
    });
}
function runCli(executable, args, env) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(executable, args, { env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
    });
}
async function runWmuxCodex(args = process.argv.slice(2)) {
    const executable = process.env.WMUX_CODEX_EXE;
    if (!executable || !path_1.default.isAbsolute(executable))
        throw new Error('wmux could not locate the native Codex executable');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const surfaceId = process.env.WMUX_SURFACE_ID;
    const plan = codexLaunchPlan(args, process.cwd());
    if (!plan.interactive || !surfaceId)
        return runCli(executable, args, env);
    let enabled = false;
    try {
        enabled = (await wmuxRequest('pane.codex_restore_config', { surfaceId })).enabled === true;
    }
    catch { /* An older/offline wmux leaves the CLI usable. */ }
    if (!enabled)
        return runCli(executable, args, env);
    if (!await supportsRemote(executable, env)) {
        console.error('[wmux] This Codex version cannot record sessions for automatic restore. Starting Codex normally.');
        return runCli(executable, args, env);
    }
    // Serialize reports so a delayed response cannot stamp an older thread last.
    let reports = Promise.resolve();
    const relay = await (0, codex_relay_1.createCodexRelay)({
        executable, args: plan.serverArgs, cwd: plan.cwd, env,
        onSession: sessionId => {
            reports = reports.then(async () => {
                try {
                    await wmuxRequest('pane.report_codex_session', { surfaceId, sessionId });
                }
                catch { /* A crashed wmux cannot receive a report; Codex still owns its history. */ }
            });
        },
    });
    let exitCode;
    try {
        exitCode = await runCli(executable, [
            '--remote', relay.url, '--remote-auth-token-env', 'WMUX_CODEX_RELAY_TOKEN', ...args,
        ], { ...env, WMUX_CODEX_RELAY_TOKEN: relay.token });
    }
    finally {
        await relay.close();
    }
    await reports;
    if (exitCode === 0 && relay.tracker.sessionId) {
        // Only an orderly CLI exit forgets the handle. A crash, socket failure or
        // wmux shutdown retains it. Main also guards this RPC while quitting.
        try {
            await wmuxRequest('pane.release_codex_session', { surfaceId, sessionId: relay.tracker.sessionId });
        }
        catch { /* wmux has already closed */ }
        console.log(`To resume later: codex resume ${relay.tracker.sessionId}`);
    }
    return exitCode;
}
if (require.main === module) {
    runWmuxCodex().then(code => { process.exitCode = code; }).catch(error => {
        console.error('[wmux] Could not launch Codex:', error.message);
        process.exitCode = 1;
    });
}

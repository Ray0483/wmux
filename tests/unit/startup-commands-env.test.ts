import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * WMUX_STARTUP_COMMANDS must not outlive the read that consumes it.
 *
 * The PowerShell integration runs a pane's startup commands during init
 * (quick-launch profiles, `wmux agent spawn`, restore's `claude --resume <id>`).
 * It used to clear the variable AFTER the loop, so the command it had just
 * started inherited it — found while chasing #251: a baked
 * `cmd /c echo %WMUX_STARTUP_COMMANDS%` printed the variable, which means a
 * restored Claude and every process it spawned carried the command line,
 * session id included, in their environment.
 *
 * The block is lifted out of the real script and run as-is, so this pins the
 * shipped text rather than a copy of it.
 */

const PS1 = path.join(__dirname, '..', '..', 'src', 'shell-integration', 'wmux-powershell-integration.ps1');
const psSource = fs.readFileSync(PS1, 'utf8').replace(/\r\n/g, '\n');

function startupBlock(): string {
  const start = psSource.indexOf('if ($env:WMUX_STARTUP_COMMANDS) {');
  expect(start).toBeGreaterThan(-1);
  const end = psSource.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return psSource.slice(start, end + 2);
}

// By absolute path, like win32-process.ts: a writeable PATH dir must not be
// able to shadow the interpreter a test (or wmux) runs.
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

function runBlock(commands: string): string {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', startupBlock()], {
    env: { ...process.env, WMUX_STARTUP_COMMANDS: commands },
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n');
}

describe.runIf(process.platform === 'win32')('WMUX_STARTUP_COMMANDS is consumed, not inherited', () => {
  it('a startup command does not see the variable in its own environment', () => {
    // `if defined`, not `echo %VAR%`: the leaked value would be the probe's
    // own text, so an echo-based assertion matches whether it leaked or not.
    const out = runBlock('cmd /c "if defined WMUX_STARTUP_COMMANDS (echo LEAKED) else (echo CLEAN)"');
    expect(out).toContain('CLEAN');
    expect(out).not.toContain('LEAKED');
  });

  it('still runs every command, in order, and trims a stray CR', () => {
    const out = runBlock('Write-Output first\r\nWrite-Output second\n\nWrite-Output third');
    expect(out.trim().split('\n')).toEqual(['first', 'second', 'third']);
  });

  it('a failing command does not stop the ones after it', () => {
    const out = runBlock('throw "boom"\nWrite-Output after');
    expect(out).toContain('after');
  });
});

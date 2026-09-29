/**
 * Grok Build (xAI's `grok` CLI) integration.
 *
 * Grok needs less from wmux than any agent before it, because it already reads
 * Claude Code's files: with its Claude compatibility on (every `[compat.claude]`
 * cell defaults to true) it loads ~/.claude/CLAUDE.md and runs the hooks in
 * ~/.claude/settings.json. So a machine with the Claude integration granted was
 * already teaching Grok about wmux. This module covers the two places that
 * falls short.
 *
 * ── Hooks: $GROK_HOME/hooks/wmux.json ────────────────────────────────────────
 *
 * The same entries `applyWmuxHooks` writes for Claude Code, byte for byte, plus
 * the two turn endings only Grok has. `StopCancelled` runs INSTEAD of `Stop`
 * when a turn ends without completing (Ctrl+C, a declined permission, the turn
 * limit) and `StopFailure` instead of it on an API error; without them an
 * interrupted Grok turn left the pane reading `working` until the trust window
 * aged it out. wmux-hook.js reports both as the turn ending.
 *
 * Duplicating the Claude entries is safe because Grok dedupes handlers across
 * sources on (event, command, url, matcher) — so with compat on each hook runs
 * once, and with `compat.claude.hooks = false` this file alone still carries
 * the full set. That only holds while the bytes match, which is why the command
 * strings come from claude-context.ts rather than being spelled again here.
 *
 * ── Instructions: $GROK_HOME/rules/wmux.md, only when Grok would miss them ───
 *
 * Grok loads every `*.md` in its home rules dir, so like Kiro this is a file of
 * wmux's own. But it is written only when Grok will NOT already read the wmux
 * block out of ~/.claude/CLAUDE.md — otherwise every Grok session would load the
 * same ~5 KB of instructions twice.
 *
 * Nothing is written unless Grok's home directory exists: creating ~/.grok on a
 * machine that has never run Grok would be the #132 mistake.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';
import {
  applyWmuxHooks,
  getClaudeMdPath,
  getHookScriptPath,
  wmuxEventHookCommand,
} from './claude-context';

const START_MARKER = '<!-- wmux:start';
/** Every command wmux registers runs wmux-hook.js; the ownership test for the hook file. */
const HOOK_MARKER = 'wmux-hook';

/** Grok's turn endings that Claude Code has no equivalent for. */
const GROK_ONLY_EVENTS = ['StopCancelled', 'StopFailure'] as const;

/** `$GROK_HOME`, default ~/.grok — the root of both the rules and hooks dirs. */
export function getGrokHome(): string {
  return process.env.GROK_HOME?.trim() || path.join(os.homedir(), '.grok');
}

export function getGrokRulesPath(): string {
  return path.join(getGrokHome(), 'rules', 'wmux.md');
}

export function getGrokHooksPath(): string {
  return path.join(getGrokHome(), 'hooks', 'wmux.json');
}

function readOrEmpty(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

/**
 * Pure: does this config.toml switch `compat.claude.agents` off?
 *
 * Accepts the `[compat.claude]` table, a dotted key under `[compat]`, and a
 * fully dotted key at the top level.
 * ponytail: line scan, not a TOML parser — an inline table
 * (`claude = { agents = false }`) reads as "on". The miss costs a Grok session
 * the wmux instructions, which is where things stood before; add a parser if
 * anyone writes it that way.
 */
export function claudeAgentsCompatOff(toml: string): boolean {
  let table = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) { table = '\0'; continue; } // array of tables: never ours
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { table = header[1].replace(/["'\s]/g, ''); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) continue;
    const key = [table, kv[1].replace(/["'\s]/g, '')].filter(Boolean).join('.');
    if (key === 'compat.claude.agents') return kv[2].trim() === 'false';
  }
  return false;
}

/**
 * Will Grok already see the wmux block in ~/.claude/CLAUDE.md?
 *
 * Resolved the way Grok resolves the cell — env var over config.toml over the
 * default (on). The env var read is wmux's own, which every pane inherits; one
 * exported per-shell after launch is unknowable here, and the worst case is the
 * instructions loading twice.
 */
export function grokReadsClaudeContext(): boolean {
  const env = process.env.GROK_CLAUDE_AGENTS_ENABLED?.trim();
  const compatOn = env
    ? !/^(0|false|no|off)$/i.test(env)
    : !claudeAgentsCompatOff(readOrEmpty(path.join(getGrokHome(), 'config.toml')));
  return compatOn && readOrEmpty(getClaudeMdPath()).includes(START_MARKER);
}

/** Pure: the whole hooks file, given the absolute path to wmux-hook.js. */
export function buildGrokHooks(hookScript: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = { ...applyWmuxHooks({}, hookScript).hooks };
  for (const event of GROK_ONLY_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: wmuxEventHookCommand(hookScript, event) }] }];
  }
  return { hooks };
}

/**
 * Write `content` to a file wmux owns inside Grok's home, or leave a same-named
 * file of the user's alone. No-op when Grok has never run here.
 */
function writeOwnedFile(filePath: string, content: string, isOurs: (s: string) => boolean): void {
  if (!fs.existsSync(getGrokHome())) return;
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (!isOurs(current)) {
      console.warn(`[wmux] ${filePath} exists and is not wmux-managed — leaving it alone`);
      return;
    }
    if (current === content) return; // already current; don't churn the mtime
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[wmux] Updated ${filePath}`);
}

function removeOwnedFile(filePath: string, isOurs: (s: string) => boolean): void {
  if (!fs.existsSync(filePath)) return;
  if (!isOurs(fs.readFileSync(filePath, 'utf-8'))) return;
  fs.unlinkSync(filePath);
  console.log(`[wmux] Removed ${filePath}`);
}

const isOurRules = (s: string) => s.includes(START_MARKER);
const isOurHooks = (s: string) => s.includes(HOOK_MARKER);

/**
 * Called AFTER ensureClaudeContext, so the CLAUDE.md check sees this launch's
 * write. When Grok reads that block, a rules file left by an earlier launch
 * (compat was off then) is removed rather than kept as a duplicate.
 */
export function ensureGrokContext(): void {
  try {
    if (grokReadsClaudeContext()) { removeGrokContext(); return; }
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const rendered = readRenderedInstructions();
    if (rendered === null) return;
    writeOwnedFile(getGrokRulesPath(), rendered.trimEnd() + '\n', isOurRules);
  } catch (err) {
    console.warn('[wmux] Failed to update Grok context:', err);
  }
}

export function removeGrokContext(): void {
  try {
    removeOwnedFile(getGrokRulesPath(), isOurRules);
  } catch (err) {
    console.warn('[wmux] Failed to remove Grok context:', err);
  }
}

export function ensureGrokHooks(): void {
  try {
    const content = JSON.stringify(buildGrokHooks(getHookScriptPath()), null, 2) + '\n';
    writeOwnedFile(getGrokHooksPath(), content, isOurHooks);
  } catch (err) {
    console.warn('[wmux] Failed to update Grok hooks:', err);
  }
}

export function removeGrokHooks(): void {
  try {
    removeOwnedFile(getGrokHooksPath(), isOurHooks);
  } catch (err) {
    console.warn('[wmux] Failed to remove Grok hooks:', err);
  }
}

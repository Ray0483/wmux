import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildGrokHooks,
  claudeAgentsCompatOff,
  ensureGrokContext,
  ensureGrokHooks,
  getGrokHooksPath,
  getGrokRulesPath,
  removeGrokContext,
  removeGrokHooks,
} from '../../src/main/grok-context';
import { applyWmuxHooks } from '../../src/main/claude-context';

/**
 * Grok Build reads Claude Code's files by default, so what this suite pins is
 * the part that is Grok's own: a hooks file whose entries dedupe against the
 * Claude ones byte for byte, and a rules file that exists only when Grok would
 * otherwise miss the instructions. Temp HOME, as in the Kiro and pi suites.
 */
describe('grok context', () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  const KEYS = ['USERPROFILE', 'HOME', 'GROK_HOME', 'GROK_CLAUDE_AGENTS_ENABLED'];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-grok-'));
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.GROK_HOME;
    delete process.env.GROK_CLAUDE_AGENTS_ENABLED;
    expect(os.homedir()).toBe(tmp);
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const grokHome = () => path.join(tmp, '.grok');
  const writeClaudeBlock = () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), '<!-- wmux:start -->\nx\n<!-- wmux:end -->\n');
  };

  it('writes nothing on a machine that has never run Grok', () => {
    ensureGrokHooks();
    ensureGrokContext();
    expect(fs.existsSync(grokHome())).toBe(false);
  });

  it('hook entries match the Claude ones exactly, plus the Grok-only turn endings', () => {
    const script = 'C:/wmux/resources/cli/wmux-hook.js';
    const { hooks } = buildGrokHooks(script);
    // Grok dedupes on (event, command, matcher): any drift here runs every hook twice.
    for (const [event, entries] of Object.entries(applyWmuxHooks({}, script).hooks)) {
      expect(hooks[event]).toEqual(entries);
    }
    expect(JSON.stringify(hooks.StopCancelled)).toContain(`"node \\"${script}\\" --event StopCancelled"`);
    expect(JSON.stringify(hooks.StopFailure)).toContain('--event StopFailure');
  });

  it('installs and removes the hooks file, and leaves a user file of the same name alone', () => {
    fs.mkdirSync(grokHome());
    ensureGrokHooks();
    const written = JSON.parse(fs.readFileSync(getGrokHooksPath(), 'utf-8'));
    expect(Object.keys(written.hooks)).toContain('StopCancelled');
    removeGrokHooks();
    expect(fs.existsSync(getGrokHooksPath())).toBe(false);

    fs.mkdirSync(path.dirname(getGrokHooksPath()), { recursive: true });
    fs.writeFileSync(getGrokHooksPath(), '{"hooks":{}}');
    ensureGrokHooks();
    removeGrokHooks();
    expect(fs.readFileSync(getGrokHooksPath(), 'utf-8')).toBe('{"hooks":{}}');
  });

  it('honours GROK_HOME', () => {
    const custom = path.join(tmp, 'elsewhere');
    fs.mkdirSync(custom);
    process.env.GROK_HOME = custom;
    ensureGrokHooks();
    expect(fs.existsSync(path.join(custom, 'hooks', 'wmux.json'))).toBe(true);
  });

  it('skips the rules file while Grok reads the CLAUDE.md block, and removes a stale one', () => {
    fs.mkdirSync(grokHome());
    ensureGrokContext(); // no CLAUDE.md block yet: Grok would miss the instructions
    expect(fs.readFileSync(getGrokRulesPath(), 'utf-8')).toContain('<!-- wmux:start');

    writeClaudeBlock();
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);
  });

  it('writes the rules file when Claude compat is switched off', () => {
    fs.mkdirSync(grokHome());
    writeClaudeBlock();
    fs.writeFileSync(path.join(grokHome(), 'config.toml'), '[compat.claude]\nagents = false\n');
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(true);

    // env beats config.toml, as it does in Grok
    process.env.GROK_CLAUDE_AGENTS_ENABLED = 'true';
    ensureGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);

    process.env.GROK_CLAUDE_AGENTS_ENABLED = '0';
    ensureGrokContext();
    removeGrokContext();
    expect(fs.existsSync(getGrokRulesPath())).toBe(false);
  });

  it('reads compat.claude.agents in each TOML spelling', () => {
    expect(claudeAgentsCompatOff('[compat.claude]\nagents = false')).toBe(true);
    expect(claudeAgentsCompatOff('[compat]\nclaude.agents = false # off')).toBe(true);
    expect(claudeAgentsCompatOff('compat.claude.agents = false\n[model]\nx = 1')).toBe(true);
    expect(claudeAgentsCompatOff('[ "compat" . "claude" ]\n"agents" = false')).toBe(true);
    expect(claudeAgentsCompatOff('[compat.claude]\nagents = true')).toBe(false);
    expect(claudeAgentsCompatOff('[compat.claude]\nhooks = false')).toBe(false);
    expect(claudeAgentsCompatOff('[compat.cursor]\nagents = false')).toBe(false);
    expect(claudeAgentsCompatOff('# [compat.claude]\n# agents = false')).toBe(false);
    expect(claudeAgentsCompatOff('')).toBe(false);
  });
});

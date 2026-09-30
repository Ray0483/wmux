/**
 * Claude Code namespaces a plugin's commands and skills the same way
 * (`<plugin>:<name>`), so `commands/orchestrate.md` and `skills/orchestrate/`
 * both answered to `wmux-orchestrator:orchestrate`. The command told the model to
 * invoke the skill, the Skill tool resolved the name to the command again, and
 * the run stalled before Phase 0.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '../../resources/wmux-orchestrator');

function commandNames(): string[] {
  const dir = path.join(PLUGIN, 'commands');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
}

function skillNames(): string[] {
  const dir = path.join(PLUGIN, 'skills');
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')));
}

describe('wmux-orchestrator plugin names', () => {
  it('ships the orchestrate skill', () => {
    expect(skillNames()).toContain('orchestrate');
  });

  it('has no command that shares a name with a skill', () => {
    const skills = new Set(skillNames());
    expect(commandNames().filter((c) => skills.has(c))).toEqual([]);
  });
});

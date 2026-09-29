import { describe, it, expect } from 'vitest';
import { parseFlagArgs } from '../../src/cli/wmux';

// Issue #247. `agent spawn` walked argv pairwise, so one stray token (Windows
// PowerShell 5.1 splitting a --cmd value at its embedded quotes) misaligned
// every later flag and nothing complained. These pin the scanning parser that
// replaced it for agent spawn, agent spawn-batch and layout grid.

const SPAWN = {
  value: ['--cmd', '--label', '--cwd', '--pane', '--workspace'],
  bool: ['--replace-tab'],
};

describe('parseFlagArgs (#247)', () => {
  it('keeps a --cmd value with spaces and quotes as ONE token', () => {
    const cmd = 'powershell -NoProfile -Command "Start-Sleep 30"';
    const { values } = parseFlagArgs(['--cmd', cmd, '--label', 'C', '--workspace', 'ws-x'], SPAWN);
    expect(values).toEqual({ '--cmd': cmd, '--label': 'C', '--workspace': 'ws-x' });
  });

  it('reads flags in any order, bool flags included', () => {
    const { values, bools } = parseFlagArgs(
      ['--workspace', 'ws-x', '--replace-tab', '--label', 'L', '--cmd', 'claude'],
      SPAWN,
    );
    expect(values).toEqual({ '--workspace': 'ws-x', '--label': 'L', '--cmd': 'claude' });
    expect([...bools]).toEqual(['--replace-tab']);
  });

  it('refuses the #247 mangled argv and names the stray token', () => {
    // What PowerShell 5.1 actually hands node for the report's command line.
    const mangled = [
      '--cmd', 'powershell -NoProfile -Command Start-Sleep', '30',
      '--label', 'C', '--workspace', 'X',
    ];
    expect(() => parseFlagArgs(mangled, SPAWN)).toThrow(/Unexpected argument '30'/);
  });

  it('refuses a bare stray word anywhere', () => {
    expect(() => parseFlagArgs(['stray', '--cmd', 'x'], SPAWN)).toThrow(/'stray'/);
    expect(() => parseFlagArgs(['--cmd', 'x', 'stray'], SPAWN)).toThrow(/'stray'/);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseFlagArgs(['--cmd', 'x', '--nope', 'y'], SPAWN)).toThrow(/'--nope'/);
  });

  it('refuses a trailing value flag with no value', () => {
    expect(() => parseFlagArgs(['--cmd', 'x', '--label'], SPAWN)).toThrow(/'--label' needs a value/);
  });

  it('refuses a value flag followed by another of our flags', () => {
    // Taking `--workspace` as the label would silently drop the workspace.
    expect(() => parseFlagArgs(['--label', '--workspace', 'ws-x'], SPAWN)).toThrow(
      /'--label' needs a value/,
    );
  });

  it('accepts a value that merely looks like a flag but is not one of ours', () => {
    const { values } = parseFlagArgs(['--cmd', '--version'], SPAWN);
    expect(values['--cmd']).toBe('--version');
  });

  it('refuses a flag given twice', () => {
    expect(() => parseFlagArgs(['--cmd', 'a', '--cmd', 'b'], SPAWN)).toThrow(/more than once/);
  });

  it('an empty argv parses to nothing', () => {
    const { values, bools } = parseFlagArgs([], SPAWN);
    expect(values).toEqual({});
    expect(bools.size).toBe(0);
  });
});

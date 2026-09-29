import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bashAlias,
  gitBashCandidates,
  gitRootFromGitExe,
  isGitBashLauncher,
  isWslBashLauncher,
  GIT_BASH_LOGIN_ARGS,
} from '../../src/main/git-bash';
import {
  extraArgsForSpec,
  gitBashProbe,
  parseShellSpec,
  resetShellPathCache,
  resolveExistingShellPath,
  shellProbe,
} from '../../src/main/pty-manager';

/**
 * Issue #252: Settings → Workspace → Default shell → "Git Bash" stores the bare
 * name `bash.exe`, which was resolved with `where` against wmux's OWN PATH.
 * Git for Windows only puts `<Git>\cmd` there, so the lookup either missed
 * (silent fallback to pwsh — "the setting has no effect") or found the WSL
 * launcher in System32.
 */

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const WSL_LAUNCHER = 'C:\\Windows\\System32\\bash.exe';

describe('bashAlias', () => {
  it('recognises the bare spellings the Settings selector and users write', () => {
    expect(bashAlias('bash.exe')).toBe('bash');
    expect(bashAlias('BASH')).toBe('bash');
    expect(bashAlias('git-bash.exe')).toBe('git-bash');
  });

  it('leaves anything with a path alone — the user wrote it out', () => {
    expect(bashAlias('C:\\msys64\\usr\\bin\\bash.exe')).toBeNull();
    expect(bashAlias('.\\bash.exe')).toBeNull();
    expect(bashAlias('pwsh.exe')).toBeNull();
    expect(bashAlias('')).toBeNull();
  });
});

describe('isWslBashLauncher', () => {
  it('flags System32\\bash.exe and the WindowsApps alias, case-insensitively', () => {
    expect(isWslBashLauncher(WSL_LAUNCHER)).toBe(true);
    expect(isWslBashLauncher('c:\\windows\\system32\\BASH.EXE')).toBe(true);
    expect(isWslBashLauncher('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe')).toBe(true);
    expect(isWslBashLauncher('D:\\Win\\System32\\bash.exe', 'D:\\Win')).toBe(true);
  });

  it('does not flag a real bash', () => {
    expect(isWslBashLauncher(GIT_BASH)).toBe(false);
    expect(isWslBashLauncher('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe(false);
  });
});

describe('gitRootFromGitExe', () => {
  it('walks up from each place Git for Windows ships git.exe', () => {
    expect(gitRootFromGitExe('C:\\Program Files\\Git\\cmd\\git.exe')).toBe('C:\\Program Files\\Git');
    expect(gitRootFromGitExe('C:\\Program Files\\Git\\bin\\git.exe')).toBe('C:\\Program Files\\Git');
    expect(gitRootFromGitExe('D:\\Tools\\Git\\mingw64\\bin\\git.exe')).toBe('D:\\Tools\\Git');
  });

  it('answers nothing for a layout it does not know', () => {
    expect(gitRootFromGitExe('C:\\Somewhere\\git.exe')).toBeUndefined();
  });
});

describe('gitBashCandidates', () => {
  it('puts the install behind the git on PATH first, then the default locations, de-duplicated', () => {
    const env = { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    expect(gitBashCandidates(env, 'D:\\Tools\\Git\\cmd\\git.exe')).toEqual([
      'D:\\Tools\\Git\\bin\\bash.exe',
      GIT_BASH,
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    ]);
  });
});

describe('resolveExistingShellPath for a bare bash (#252)', () => {
  beforeEach(() => resetShellPathCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetShellPathCache();
  });

  function onPath(map: Record<string, string | undefined>) {
    vi.spyOn(shellProbe, 'onPath').mockImplementation((name: string) => map[name]);
  }

  it('the reporter\'s machine: no bash on wmux\'s PATH → Git Bash, not a silent pwsh fallback', () => {
    if (process.platform !== 'win32') return;
    onPath({});
    vi.spyOn(gitBashProbe, 'find').mockReturnValue(GIT_BASH);
    expect(resolveExistingShellPath('bash.exe')).toBe(GIT_BASH);
  });

  it('WSL installed: the System32 launcher does not win over Git Bash', () => {
    if (process.platform !== 'win32') return;
    onPath({ 'bash.exe': WSL_LAUNCHER });
    vi.spyOn(gitBashProbe, 'find').mockReturnValue(GIT_BASH);
    expect(resolveExistingShellPath('bash.exe')).toBe(GIT_BASH);
  });

  it('an honest PATH bash (MSYS2, Cygwin) is still what `bash` means', () => {
    if (process.platform !== 'win32') return;
    onPath({ 'bash.exe': 'C:\\msys64\\usr\\bin\\bash.exe' });
    const find = vi.spyOn(gitBashProbe, 'find').mockReturnValue(GIT_BASH);
    expect(resolveExistingShellPath('bash.exe')).toBe('C:\\msys64\\usr\\bin\\bash.exe');
    expect(find).not.toHaveBeenCalled();
  });

  it('no Git installed: the WSL launcher is still better than no bash at all', () => {
    if (process.platform !== 'win32') return;
    onPath({ 'bash.exe': WSL_LAUNCHER });
    vi.spyOn(gitBashProbe, 'find').mockReturnValue(undefined);
    expect(resolveExistingShellPath('bash.exe')).toBe(WSL_LAUNCHER);
  });

  it('git-bash.exe (a mintty WINDOW) resolves to the bash that can live in a pane', () => {
    if (process.platform !== 'win32') return;
    onPath({ 'git-bash.exe': 'C:\\Program Files\\Git\\git-bash.exe' });
    vi.spyOn(gitBashProbe, 'find').mockReturnValue(GIT_BASH);
    expect(resolveExistingShellPath('git-bash.exe')).toBe(GIT_BASH);
  });

  it('gitBashProbe finds a real install through the git on PATH', () => {
    if (process.platform !== 'win32') return;
    // A portable Git somewhere no default location would look.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-252-'));
    try {
      fs.mkdirSync(path.join(root, 'Git', 'cmd'), { recursive: true });
      fs.mkdirSync(path.join(root, 'Git', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Git', 'cmd', 'git.exe'), '');
      fs.writeFileSync(path.join(root, 'Git', 'bin', 'bash.exe'), '');
      onPath({ 'git.exe': path.join(root, 'Git', 'cmd', 'git.exe') });
      expect(gitBashProbe.find()).toBe(path.join(root, 'Git', 'bin', 'bash.exe'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extraArgsForSpec', () => {
  it('gives a bare Git Bash alias the login flags every other Git Bash entry point uses', () => {
    expect(extraArgsForSpec(parseShellSpec('bash.exe'), GIT_BASH)).toEqual([...GIT_BASH_LOGIN_ARGS]);
  });

  it('never adds flags to a path the user wrote, or to a raw usr\\bin bash', () => {
    expect(extraArgsForSpec({ command: GIT_BASH, args: [] }, GIT_BASH)).toEqual([]);
    expect(extraArgsForSpec(parseShellSpec('bash.exe'), 'C:\\msys64\\usr\\bin\\bash.exe')).toEqual([]);
    expect(extraArgsForSpec(parseShellSpec('bash.exe'), WSL_LAUNCHER)).toEqual([]);
  });

  it('keeps a spec\'s own args, and drops them when the spec fell back (#78)', () => {
    expect(extraArgsForSpec({ command: 'ssh', args: ['user@host'] }, 'C:\\ssh.exe')).toEqual(['user@host']);
    expect(extraArgsForSpec({ command: 'ssh', args: ['user@host'] }, undefined)).toEqual([]);
  });

  it('isGitBashLauncher distinguishes bin\\ from usr\\bin\\', () => {
    expect(isGitBashLauncher(GIT_BASH)).toBe(true);
    expect(isGitBashLauncher('C:/Program Files/Git/bin/bash.exe')).toBe(true);
    expect(isGitBashLauncher('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe(false);
  });
});

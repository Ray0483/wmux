import fs from 'fs';
import path from 'path';
import { stripMarkOfTheWeb } from './powershell-shim';

/** Private shims affect only wmux's native Windows shells, never the global PATH. */
export function codexShimDirs(options: {
  shellType: string;
  executable: string | undefined;
  cliBinDir: string;
  psVerified: boolean;
  env: Record<string, string>;
  runtime: string;
  launcher: string;
}): string[] {
  if (process.platform !== 'win32' || !['powershell', 'cmd'].includes(options.shellType) || !options.executable) return [];
  const root = path.dirname(options.cliBinDir);
  const cmd = path.join(root, 'codex-bin');
  if (!fs.existsSync(path.join(cmd, 'codex.cmd')) || !fs.existsSync(options.launcher)) return [];
  let dirs: string[] = [cmd];
  if (options.shellType === 'powershell') {
    // PowerShell must get the .ps1 or nothing. Handing it codex.cmd puts
    // cmd.exe's parser back between the user and codex — `codex "a > b"`
    // redirects to a file named b — which is the #154 trap the wmux shim
    // already refuses to fall into. Unverified, codex simply runs unwrapped.
    const ps = path.join(root, 'codex-bin-ps');
    const script = path.join(ps, 'codex.ps1');
    dirs = [];
    if (options.psVerified && fs.existsSync(script)) {
      stripMarkOfTheWeb(script);
      if (!fs.existsSync(script + ':Zone.Identifier')) dirs = [ps, cmd];
    }
  }
  if (dirs.length > 0) {
    Object.assign(options.env, {
      WMUX_CODEX_EXE: options.executable,
      WMUX_CODEX_RUNTIME: options.runtime,
      WMUX_CODEX_LAUNCHER: options.launcher,
    });
  }
  return dirs;
}

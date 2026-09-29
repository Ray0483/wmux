/**
 * The BUILT phone console (#254). Skipped when dist/renderer is absent (a
 * fresh clone that only ran `npm test`); run after `npx vite build`.
 *
 * What it pins is what the server relies on and cannot check at request time:
 * the manifest is a plain file at the dist root (a `.vite/` dot directory is
 * not guaranteed to survive packaging), it has the entry key the static
 * loader walks from, the page loads its code from `../assets/` so it resolves
 * from `/` to `/assets/`, and there is nothing inline for the CSP
 * (`script-src 'self'`) to refuse.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REMOTE_ENTRY_KEY, REMOTE_MANIFEST_FILE } from '../../src/shared/remote-console-config';

const DIST = path.resolve(__dirname, '../../dist/renderer');
const PAGE = path.join(DIST, 'remote/index.html');
const MANIFEST = path.join(DIST, REMOTE_MANIFEST_FILE);
const built = fs.existsSync(PAGE) && fs.existsSync(MANIFEST);

interface Chunk { file: string; imports?: string[]; css?: string[]; assets?: string[]; isEntry?: boolean }

describe.skipIf(!built)('remote UI build output', () => {
  const html = built ? fs.readFileSync(PAGE, 'utf8') : '';
  const manifest: Record<string, Chunk> = built ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};

  it('emits the manifest at the dist root with the remote entry key', () => {
    expect(REMOTE_MANIFEST_FILE).toBe('remote-manifest.json');
    expect(manifest[REMOTE_ENTRY_KEY]?.isEntry).toBe(true);
    expect(fs.existsSync(path.join(DIST, '.vite/manifest.json'))).toBe(false);
  });

  it('has no inline script and no inline event handler', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\ssrc="/);
      expect(m[2].trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('references its code as ../assets/…, which resolves from / to /assets/', () => {
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r).toMatch(/^\.\.\/assets\//);
  });

  it('every file in the entry closure exists, and the desktop entry is not in it', () => {
    const seen = new Set<string>();
    const visit = (key: string) => {
      const c = manifest[key];
      if (!c || seen.has(c.file)) return;
      seen.add(c.file);
      for (const f of [...(c.css ?? []), ...(c.assets ?? [])]) seen.add(f);
      for (const i of c.imports ?? []) visit(i);
    };
    visit(REMOTE_ENTRY_KEY);
    for (const f of seen) expect(fs.existsSync(path.join(DIST, f)), f).toBe(true);
    const desktop = manifest['index.html'];
    if (desktop) expect(seen.has(desktop.file)).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { allowedAssets, contentTypeOf, loadAllowedAssets } from '../../src/main/remote-console/static-assets';
import { REMOTE_ENTRY_KEY, REMOTE_MANIFEST_FILE } from '../../src/shared/remote-console-config';

const ROOT = path.join(os.tmpdir(), 'wmux-rc-root');

/** A trimmed-down real Vite manifest: two HTML entries sharing a chunk. */
const MANIFEST = {
  'index.html': {
    file: 'assets/index-DESK.js',
    src: 'index.html',
    isEntry: true,
    imports: ['_shared-S1.js', '_desktop-only-D1.js'],
    css: ['assets/index-DESK.css'],
  },
  'remote/index.html': {
    file: 'assets/remote-PHONE.js',
    src: 'remote/index.html',
    isEntry: true,
    imports: ['_shared-S1.js'],
    dynamicImports: ['_lazy-L1.js'],
    css: ['assets/remote-PHONE.css'],
    assets: ['assets/font-F1.woff2'],
  },
  '_shared-S1.js': { file: 'assets/shared-S1.js', imports: ['_remote-dep-R1.js'] },
  '_remote-dep-R1.js': { file: 'assets/remote-dep-R1.js', imports: ['_shared-S1.js'] },
  '_lazy-L1.js': { file: 'assets/lazy-L1.js' },
  '_desktop-only-D1.js': { file: 'assets/desktop-only-D1.js' },
  '_evil.js': { file: '../../secret.txt' },
};

describe('allowedAssets (#254)', () => {
  it('walks the phone entry closure (file/imports/dynamicImports/css/assets), cycles included', () => {
    const map = allowedAssets(JSON.stringify(MANIFEST), REMOTE_ENTRY_KEY, ROOT);
    expect(map).not.toBeNull();
    expect([...(map as Map<string, unknown>).keys()].sort()).toEqual([
      '/',
      '/assets/font-F1.woff2',
      '/assets/lazy-L1.js',
      '/assets/remote-PHONE.css',
      '/assets/remote-PHONE.js',
      '/assets/remote-dep-R1.js',
      '/assets/shared-S1.js',
    ]);
  });

  it('excludes the desktop entry and everything only it reaches', () => {
    const map = allowedAssets(MANIFEST, REMOTE_ENTRY_KEY, ROOT) as Map<string, unknown>;
    for (const k of map.keys()) {
      expect(k).not.toContain('DESK');
      expect(k).not.toContain('desktop-only');
    }
    expect(map.has('/index.html')).toBe(false);
  });

  it('/ is remote/index.html under the root, with an html type', () => {
    const map = allowedAssets(MANIFEST, REMOTE_ENTRY_KEY, ROOT) as Map<string, { absPath: string; type: string }>;
    expect(map.get('/')).toEqual({ absPath: path.join(ROOT, 'remote', 'index.html'), type: 'text/html; charset=utf-8' });
    expect(map.get('/assets/remote-PHONE.js')?.type).toBe('text/javascript; charset=utf-8');
  });

  it('never admits a path that escapes the root', () => {
    const evil = { ...MANIFEST, 'remote/index.html': { ...MANIFEST['remote/index.html'], imports: ['_evil.js'], css: ['/abs.css', 'C:/x.css', 'a\\b.css'] } };
    const map = allowedAssets(evil, REMOTE_ENTRY_KEY, ROOT) as Map<string, { absPath: string }>;
    for (const [k, v] of map) {
      expect(k).not.toContain('..');
      expect(path.relative(ROOT, v.absPath).startsWith('..')).toBe(false);
    }
  });

  it('null when the manifest is garbage or lacks the entry', () => {
    expect(allowedAssets('{not json', REMOTE_ENTRY_KEY, ROOT)).toBeNull();
    expect(allowedAssets('[]', REMOTE_ENTRY_KEY, ROOT)).toBeNull();
    expect(allowedAssets({ 'index.html': { file: 'a.js' } }, REMOTE_ENTRY_KEY, ROOT)).toBeNull();
  });

  it('content types by extension', () => {
    expect(contentTypeOf('a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeOf('a.SVG')).toBe('image/svg+xml');
    expect(contentTypeOf('a.woff2')).toBe('font/woff2');
    expect(contentTypeOf('a.bin')).toBe('application/octet-stream');
  });
});

describe('loadAllowedAssets', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rc-assets-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('null when remote-manifest.json is absent (ui-not-built)', () => {
    expect(loadAllowedAssets(dir)).toBeNull();
  });

  it('reads <root>/remote-manifest.json', () => {
    fs.writeFileSync(path.join(dir, REMOTE_MANIFEST_FILE), JSON.stringify(MANIFEST));
    expect(loadAllowedAssets(dir)?.get('/')?.absPath).toBe(path.join(dir, 'remote', 'index.html'));
  });
});

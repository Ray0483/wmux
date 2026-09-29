/**
 * The phone console's import graph (#254, spec §11 "Isolation").
 *
 * The page is served to a phone over the network, so what it bundles is what
 * it exposes. It may import React, @xterm/xterm, src/shared, the two pure
 * touch recognisers and its own folder — and nothing else: no desktop store
 * (which would drag the whole renderer and its `window.wmux` calls in), no
 * desktop i18n (whose `useT` reads that store), no hooks/, no components/.
 * Checked on source text, so a violation fails here before a bundler
 * silently makes it work.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const REMOTE = path.join(ROOT, 'src/renderer/remote');
const SHARED = path.join(ROOT, 'src/shared');
const ALLOWED_UTILS = new Set([
  path.join(ROOT, 'src/renderer/utils/touch-pan'),
  path.join(ROOT, 'src/renderer/utils/touch-fling'),
]);
const ALLOWED_PACKAGES = [/^react$/, /^react\/jsx-runtime$/, /^react-dom\/client$/, /^@xterm\/xterm$/, /^@xterm\/xterm\/css\/xterm\.css$/];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(d.name) ? [p] : [];
  });
}

/** Three simple shapes rather than one clever regex: `… from 'x'`, bare `import 'x'`, and `import('x')`/`require('x')`. */
const SPEC_PATTERNS = [
  /\bfrom ['"]([^'"\n]+)['"]/g,
  /^import ['"]([^'"\n]+)['"]/gm,
  /\b(?:import|require)\(['"]([^'"\n]+)['"]/g,
];

function specifiers(src: string): string[] {
  return SPEC_PATTERNS.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));
}

const files = walk(REMOTE).filter((f) => !f.endsWith('.css'));

function isAllowed(spec: string, from: string): boolean {
  if (!spec.startsWith('.')) return ALLOWED_PACKAGES.some((re) => re.test(spec));
  const abs = path.resolve(path.dirname(from), spec).replace(/\.(tsx?|css)$/, '');
  if (abs === REMOTE || abs.startsWith(REMOTE + path.sep)) return true;
  if (abs.startsWith(SHARED + path.sep)) return !abs.endsWith(`${path.sep}instance`);
  return ALLOWED_UTILS.has(abs);
}

describe('remote UI isolation', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    it(`${rel} imports only what the phone may bundle`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const bad = specifiers(src).filter((s) => !isAllowed(s, file));
      expect(bad).toEqual([]);
    });
  }

  it('the allowed utils are themselves pure (touch-fling imports only touch-pan)', () => {
    for (const u of ALLOWED_UTILS) {
      const src = fs.readFileSync(`${u}.ts`, 'utf8');
      for (const s of specifiers(src)) expect(s).toBe('./touch-pan');
    }
  });

  it('never renders HTML from a string', () => {
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    }
  });

  it('has no inline script or handler in the page', () => {
    const html = fs.readFileSync(path.join(REMOTE, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toMatch(/type="module"/);
    expect(scripts[0][1]).toMatch(/src="\.\/main\.tsx"/);
    expect(scripts[0][2].trim()).toBe('');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).toMatch(/viewport-fit=cover/);
  });

  it('strips the pairing fragment as the first statement of the entry', () => {
    const src = fs.readFileSync(path.join(REMOTE, 'main.tsx'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    expect(code[0]).toMatch(/location\.hash/);
    expect(code[1]).toMatch(/history\.replaceState\(null, '', globalThis\.location\.pathname\)/);
  });
});

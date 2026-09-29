/**
 * Which files the Remote Console serves (#254, spec §7 "Static files").
 *
 * `dist/renderer` also holds the DESKTOP app — the whole renderer bundle, with
 * every string, route and feature flag in it. The phone must be able to load
 * its own page and nothing else, so the served set is not "files under a
 * directory" but the closure of ONE manifest entry: `remote/index.html`, then
 * transitively every `file`, `imports`, `dynamicImports`, `css` and `assets`
 * it reaches. A request is looked up in that map by exact URL path; request
 * data is never joined onto a filesystem path, so there is nothing to
 * traverse even if guards.ts's `routeOf` were bypassed.
 *
 * The manifest is Vite's, emitted as `remote-manifest.json` at the renderer
 * root rather than `.vite/manifest.json` (a dot directory is not guaranteed to
 * survive packaging — see REMOTE_MANIFEST_FILE). `dynamicImports` is walked in
 * addition to the brief's four keys: a lazily-loaded chunk of the phone page
 * is still the phone page, and leaving it out would 404 on first use.
 */
import fs from 'fs';
import path from 'path';
import { REMOTE_ENTRY_KEY, REMOTE_MANIFEST_FILE } from '../../shared/remote-console-config';

export interface AssetEntry {
  absPath: string;
  type: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** A manifest path we are willing to serve: relative, forward slashes, no `..`, no drive, no scheme. */
function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * URL path → file for the closure of `entryKey`. `/` maps to the entry's own
 * HTML (`remote/index.html` under root). Returns null when the manifest is not
 * an object or does not contain the entry — i.e. the phone UI was not built.
 */
export function allowedAssets(manifestJson: string | unknown, entryKey: string, root: string): Map<string, AssetEntry> | null {
  let manifest: unknown = manifestJson;
  if (typeof manifestJson === 'string') {
    try {
      manifest = JSON.parse(manifestJson);
    } catch {
      return null;
    }
  }
  if (!isRecord(manifest) || !isRecord(manifest[entryKey]) || !isSafeRelPath(entryKey)) return null;

  const out = new Map<string, AssetEntry>();
  const add = (rel: string): void => {
    if (!isSafeRelPath(rel)) return;
    out.set('/' + rel, { absPath: path.join(root, ...rel.split('/')), type: contentTypeOf(rel) });
  };
  out.set('/', { absPath: path.join(root, ...entryKey.split('/')), type: contentTypeOf(entryKey) });

  const visited = new Set<string>();
  const stack = [entryKey];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const chunk = manifest[key];
    if (!isRecord(chunk)) continue;
    if (typeof chunk.file === 'string') add(chunk.file);
    for (const f of [...strings(chunk.css), ...strings(chunk.assets)]) add(f);
    for (const imp of [...strings(chunk.imports), ...strings(chunk.dynamicImports)]) stack.push(imp);
  }
  return out;
}

/** Read `<root>/remote-manifest.json` and build the map; null when absent or unusable ("ui-not-built"). */
export function loadAllowedAssets(root: string): Map<string, AssetEntry> | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, REMOTE_MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
  return allowedAssets(text, REMOTE_ENTRY_KEY, root);
}

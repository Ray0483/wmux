/**
 * The page key (#254): the second half of this browser's credential, beside
 * the HttpOnly cookie. The cookie is host-scoped — on plain http every other
 * server on the same host is sent it — so the desktop also asks for this key,
 * which lives in localStorage and is therefore scoped to the exact origin,
 * port included. `/api/pair` hands it over once; `/api/session` and the
 * WebSocket upgrade want it back (see devices.ts in main).
 *
 * Every access in try/catch: private mode and blocked site data make Storage
 * throw. A key that cannot be kept means the next load reads as "Not paired",
 * which is the truth for that browser.
 */

export const DEVICE_KEY_ITEM = 'wmux-remote-key';

/** base64url, what the desktop mints; anything else is not ours to send. */
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function local(): KeyStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadDeviceKey(storage: KeyStorage | null = local()): string | null {
  if (!storage) return null;
  try {
    const v = storage.getItem(DEVICE_KEY_ITEM);
    return v !== null && KEY_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** False when the key could not be kept (it is then of no use past this page load). */
export function saveDeviceKey(key: unknown, storage: KeyStorage | null = local()): boolean {
  if (!storage || typeof key !== 'string' || !KEY_RE.test(key)) return false;
  try {
    storage.setItem(DEVICE_KEY_ITEM, key);
    return true;
  } catch {
    return false;
  }
}

export function forgetDeviceKey(storage: KeyStorage | null = local()): void {
  if (!storage) return;
  try { storage.removeItem(DEVICE_KEY_ITEM); } catch { /* nothing more to do */ }
}

/**
 * What this browser keeps about the desktop, and forgetting it (#254).
 *
 * Composer drafts are whatever was typed toward a desktop terminal — on a
 * sudo or ssh prompt, a password — and fit modes are keyed by surface id. On
 * a shared or borrowed phone, "Forget this device" that leaves them readable
 * in the browser's storage forgets nothing that matters. So every exit from
 * being paired (forget, revoked, unpaired, incompatible) sweeps both prefixes
 * from BOTH storages: drafts live in sessionStorage now, but a build before
 * that put them in localStorage.
 *
 * Every access in try/catch: private mode and blocked site data make Storage
 * throw, and a sweep that throws must not take the notice screen with it.
 */

import { DRAFT_PREFIX } from './composer-state';
import { FIT_PREFIX } from './fit';

export interface ListableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

const DEVICE_PREFIXES = [DRAFT_PREFIX, FIT_PREFIX] as const;

export function forgetDeviceStorage(storages: readonly (ListableStorage | null)[]): void {
  for (const storage of storages) {
    if (!storage) continue;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && DEVICE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
      }
      for (const k of doomed) storage.removeItem(k);
    } catch { /* nothing more this browser lets us do */ }
  }
}

export function browserStorages(): (Storage | null)[] {
  const pick = (get: () => Storage): Storage | null => {
    try { return get() ?? null; } catch { return null; }
  };
  return [pick(() => globalThis.localStorage), pick(() => globalThis.sessionStorage)];
}

/**
 * Did `POST /api/logout` leave this browser unpaired? 200 revoked it; 401 means
 * it already was. Anything else — above all no answer at all — means the
 * device record and its cookie are still live on the desktop, and saying
 * "Not paired" would be a lie a reload exposes.
 */
export function logoutUnpaired(status: number | null): boolean {
  return status === 200 || status === 401;
}

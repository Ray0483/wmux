/**
 * The pairing secret's trip through the address bar (#254, I5).
 *
 * The secret rides in the FRAGMENT so it never reaches a server log or a
 * Referer, but it is still in the URL bar and the history entry, so every
 * fragment is scrubbed the moment the page sees it. That has to happen on
 * EVERY entry, not only the first: pasting a fresh `#pair=` link into a
 * console tab that is already open is a same-document navigation — no reload,
 * main.tsx does not run again — and a startup-only scrub left a live secret
 * sitting in the address bar until the user thought to reload.
 *
 * DOM-free (the location, history and event target are injected) so the
 * tests need no browser.
 */

/** base64url, the alphabet `devices.ts` mints the 32-byte secret in. Anything else is dropped, never POSTed. */
export const PAIR_RE = /^#pair=([A-Za-z0-9_-]{16,128})$/;

export interface FragmentLocation {
  readonly hash: string;
  readonly pathname: string;
}

export interface FragmentHistory {
  replaceState(data: unknown, unused: string, url: string): void;
}

export interface HashChangeTarget {
  addEventListener(type: 'hashchange', cb: () => void): void;
  removeEventListener(type: 'hashchange', cb: () => void): void;
}

/** Scrub whatever fragment is in the address bar; the pairing secret it carried, if it was one. */
export function takePairFragment(loc: FragmentLocation, hist: FragmentHistory): string | null {
  const hash = loc.hash;
  if (!hash) return null;
  hist.replaceState(null, '', loc.pathname);
  return PAIR_RE.exec(hash)?.[1] ?? null;
}

export interface PairSecretSource {
  /** Called with each secret that arrives after startup. A secret that came before anyone listened is delivered on subscribe. */
  subscribe(cb: (secret: string) => void): () => void;
}

/**
 * Watches for fragments that arrive after startup. Registered at module load
 * rather than from a React effect, so a `hashchange` in the gap before the
 * first render is still scrubbed at once and its secret held for the app.
 */
export function watchPairFragment(target: HashChangeTarget, loc: FragmentLocation, hist: FragmentHistory): PairSecretSource {
  const listeners = new Set<(secret: string) => void>();
  let pending: string | null = null;
  target.addEventListener('hashchange', () => {
    const secret = takePairFragment(loc, hist);
    if (!secret) return;
    if (listeners.size === 0) {
      pending = secret;
      return;
    }
    for (const cb of listeners) cb(secret);
  });
  return {
    subscribe(cb) {
      listeners.add(cb);
      if (pending) {
        const secret = pending;
        pending = null;
        cb(secret);
      }
      return () => { listeners.delete(cb); };
    },
  };
}

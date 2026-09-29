/**
 * Phone console entry (#254).
 *
 * The FIRST statement of this module lifts the pairing secret out of the
 * fragment and erases it from the address bar (I5). The secret rides in the
 * fragment precisely so it never reaches a server log or a Referer — but it is
 * still in the URL bar, the history entry, and anything that screenshots or
 * syncs tabs. `replaceState` before React (or anything else of ours) runs
 * shortens that window to the time it took to parse this file.
 *
 * (Imports are hoisted and evaluate first, but none of them read the location:
 * React, xterm and our own modules only define things.)
 */
const initialHash = globalThis.location.hash;
if (initialHash) globalThis.history.replaceState(null, '', globalThis.location.pathname);

import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import '@xterm/xterm/css/xterm.css';
import './remote.css';
import { RemoteApp } from './RemoteApp';

/**
 * base64url, the alphabet `devices.ts` mints the 32-byte secret in. Anything
 * else is not ours, and is dropped rather than POSTed.
 */
const PAIR_RE = /^#pair=([A-Za-z0-9_-]{16,128})$/;
const pairSecret = PAIR_RE.exec(initialHash)?.[1] ?? null;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RemoteApp pairSecret={pairSecret} />
    </StrictMode>,
  );
}

/**
 * The visual viewport's box (#254). iOS Safari PANS the layout viewport when
 * the keyboard opens instead of shrinking it, so anything positioned against
 * the layout viewport — the attach screen, the toast stack — has to follow
 * `visualViewport` instead, or it lands under the keyboard or off-screen.
 */

import { useEffect, useState } from 'react';

export interface ViewportBox {
  height: number;
  top: number;
}

function read(): ViewportBox | null {
  const vv = globalThis.visualViewport;
  return vv ? { height: Math.round(vv.height), top: Math.round(vv.offsetTop) } : null;
}

/** The visual viewport's box, or null where the API does not exist. */
export function useVisualViewport(): ViewportBox | null {
  const [box, setBox] = useState(read);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const update = () => setBox(read());
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

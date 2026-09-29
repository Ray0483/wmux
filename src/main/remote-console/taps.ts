/**
 * Hooks the PTY forwarders call for the Remote Console (#254).
 *
 * They sit on the hottest path in main — once per PTY batch, in BOTH batchers
 * (ipc-handlers.ts's PTY_CREATE forwarder and setupAgentPtyForwarding) — so
 * the defaults are no-ops and the console being off costs one indirect call
 * per batch and nothing else. No store write, no allocation (#141).
 *
 * Callers must call through the object (`remoteTaps.deliver(...)`), never keep
 * a destructured reference: installing replaces the properties in place.
 *
 * Every installed function is wrapped in try/catch. A console bug must never
 * reach the forwarder: a throw there would drop the pane's own output on the
 * floor, which is a much worse failure than a phone that stops updating.
 */
import type { WebContents } from 'electron';

export interface RemoteTaps {
  /** Last-wins: the webContents this surface's PTY_DATA is sent to. */
  bindSurface(id: string, wc: WebContents): void;
  unbindSurface(id: string): void;
  /** Right after `webContents.send(PTY_DATA)`, with the same data. */
  deliver(id: string, data: string): void;
  exit(id: string, code: number): void;
  noteResize(id: string): void;
  noteDesktopInput(id: string): void;
}

type TapName = keyof RemoteTaps;
const TAP_NAMES: readonly TapName[] = ['bindSurface', 'unbindSurface', 'deliver', 'exit', 'noteResize', 'noteDesktopInput'];

const noop = (): void => undefined;

function defaults(): RemoteTaps {
  return {
    bindSurface: noop,
    unbindSurface: noop,
    deliver: noop,
    exit: noop,
    noteResize: noop,
    noteDesktopInput: noop,
  };
}

export const remoteTaps: RemoteTaps = defaults();

function guard<K extends TapName>(name: K, fn: RemoteTaps[K], onError?: (name: TapName, err: unknown) => void): RemoteTaps[K] {
  const wrapped = (...args: unknown[]): void => {
    try {
      (fn as (...a: unknown[]) => void)(...args);
    } catch (err) {
      try {
        onError?.(name, err);
      } catch {
        // The reporter is not allowed to break the forwarder either.
      }
    }
  };
  return wrapped as RemoteTaps[K];
}

export function installRemoteTaps(partial: Partial<RemoteTaps>, onError?: (name: TapName, err: unknown) => void): void {
  for (const name of TAP_NAMES) {
    const fn = partial[name];
    if (typeof fn === 'function') {
      (remoteTaps as unknown as Record<TapName, unknown>)[name] = guard(name, fn, onError);
    }
  }
}

export function resetRemoteTaps(): void {
  Object.assign(remoteTaps, defaults());
}

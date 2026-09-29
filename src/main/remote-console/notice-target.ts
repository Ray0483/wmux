/**
 * Which window raises a Remote Console desktop bell (#254).
 *
 * A notice ("a phone paired", "a phone connected") is about the app, not about
 * a pane, so it has no window affinity. Broadcasting it made every window add
 * it to its own bell list AND call `notification.fire`, which main answers with
 * its own toast, taskbar flash and sound: N windows, N toasts for one event.
 * So exactly one window gets it: the focused one, else the first still alive.
 *
 * Pure (windows are passed in) so the choice is testable without Electron.
 */
export interface NoticeWindow {
  isDestroyed(): boolean;
}

export function pickNoticeTarget<W extends NoticeWindow>(all: readonly W[], focused: W | null): W | null {
  if (focused && !focused.isDestroyed()) return focused;
  return all.find((w) => !w.isDestroyed()) ?? null;
}

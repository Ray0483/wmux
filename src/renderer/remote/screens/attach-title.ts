import type { RemoteT } from '../i18n';

/**
 * The attached terminal's header (#254). The roster drops a closed pane's
 * entry, and the header used to fall back to the raw `surf-<uuid>`; it keeps
 * the last label it saw instead, and says "Closed terminal" if it never saw one.
 */
export function attachTitle(label: string | undefined, lastLabel: string | null, t: RemoteT): string {
  return label ?? lastLabel ?? t.t('attach.closedTerminal');
}

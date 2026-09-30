import type { SplitNode, PaneId } from '../../shared/types';
import { findLeaf, getAllPaneIds } from './split-utils';

export const FALLBACK_LAYOUT_SIZE = { width: 1600, height: 900 } as const;

interface Size { width: number; height: number }

const usable = (s: Size | null): s is Size =>
  !!s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0;

/**
 * No "first pane" fallback, unlike `layout grid`: guessing here would carve the
 * agent grid out of a pane the caller never named. An explicit pane that is not
 * in the tree is a miss, not a cue to try the surface.
 */
export function resolveAnchorPane(
  tree: SplitNode,
  p: { anchorPaneId?: string; anchorSurfaceId?: string },
): PaneId | null {
  if (p.anchorPaneId) {
    return findLeaf(tree, p.anchorPaneId as PaneId) ? (p.anchorPaneId as PaneId) : null;
  }
  if (p.anchorSurfaceId) {
    for (const paneId of getAllPaneIds(tree)) {
      if (findLeaf(tree, paneId)?.surfaces.some((s) => s.id === p.anchorSurfaceId)) return paneId;
    }
  }
  return null;
}

/**
 * Returns the anchor pane's FULL size. `buildAgentLayout` takes the coordinator
 * share off itself, so subtracting it here would count it twice.
 * Never `window.innerWidth`: it includes the sidebar and titlebar.
 */
export function resolveLayoutSize(input: {
  paneRect: Size | null;
  workspaceRect: Size | null;
  fraction: { w: number; h: number } | null;
}): Size {
  if (usable(input.paneRect)) return { width: input.paneRect.width, height: input.paneRect.height };
  const { workspaceRect, fraction } = input;
  if (usable(workspaceRect) && fraction && Number.isFinite(fraction.w) && Number.isFinite(fraction.h) && fraction.w > 0 && fraction.h > 0) {
    return { width: workspaceRect.width * fraction.w, height: workspaceRect.height * fraction.h };
  }
  return { ...FALLBACK_LAYOUT_SIZE };
}

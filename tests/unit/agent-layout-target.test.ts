import { describe, it, expect } from 'vitest';
import { createLeaf, splitNode } from '../../src/renderer/store/split-utils';
import {
  resolveAnchorPane,
  resolveLayoutSize,
  FALLBACK_LAYOUT_SIZE,
} from '../../src/renderer/store/agent-layout-target';
import type { SplitNode, PaneId, SurfaceId } from '../../src/shared/types';

const A = 'pane-a' as PaneId;
const B = 'pane-b' as PaneId;

function twoPanes(): SplitNode {
  return splitNode(createLeaf(A), A, B, 'terminal', 'horizontal');
}

describe('resolveAnchorPane', () => {
  it('returns an explicit pane that is in the tree', () => {
    expect(resolveAnchorPane(twoPanes(), { anchorPaneId: B })).toBe(B);
  });

  it('returns null for an explicit pane that is not in the tree', () => {
    expect(resolveAnchorPane(twoPanes(), { anchorPaneId: 'pane-nope' })).toBeNull();
  });

  it('does not fall back to the surface when the explicit pane is unknown', () => {
    const tree = twoPanes();
    const surfaceInA = (tree as SplitNode & { type: 'branch' }).children[0] as SplitNode & { type: 'leaf' };
    expect(
      resolveAnchorPane(tree, { anchorPaneId: 'pane-nope', anchorSurfaceId: surfaceInA.surfaces[0].id }),
    ).toBeNull();
  });

  it('resolves a surface to the pane that holds it', () => {
    const tree = twoPanes();
    const leafB = (tree as SplitNode & { type: 'branch' }).children[1] as SplitNode & { type: 'leaf' };
    expect(resolveAnchorPane(tree, { anchorSurfaceId: leafB.surfaces[0].id })).toBe(B);
  });

  it('returns null for a surface in no pane', () => {
    expect(resolveAnchorPane(twoPanes(), { anchorSurfaceId: 'surf-nope' as SurfaceId })).toBeNull();
  });

  it('returns null, not the first pane, when nothing is given', () => {
    expect(resolveAnchorPane(twoPanes(), {})).toBeNull();
  });
});

describe('resolveLayoutSize', () => {
  const pane = { width: 1000, height: 700 };
  const workspace = { width: 2000, height: 1000 };

  it('returns the pane rect untouched, with no coordinator share taken off', () => {
    expect(resolveLayoutSize({ paneRect: pane, workspaceRect: workspace, fraction: { w: 0.5, h: 1 } })).toEqual(pane);
  });

  it('scales the workspace rect by the leaf fraction when there is no pane rect', () => {
    expect(resolveLayoutSize({ paneRect: null, workspaceRect: workspace, fraction: { w: 0.5, h: 0.25 } }))
      .toEqual({ width: 1000, height: 250 });
  });

  it.each([
    ['zero width', { width: 0, height: 700 }],
    ['zero height', { width: 1000, height: 0 }],
    ['NaN', { width: NaN, height: 700 }],
    ['Infinity', { width: Infinity, height: 700 }],
    ['negative', { width: -5, height: 700 }],
  ])('skips a pane rect with %s', (_label, bad) => {
    expect(resolveLayoutSize({ paneRect: bad, workspaceRect: workspace, fraction: { w: 0.5, h: 0.5 } }))
      .toEqual({ width: 1000, height: 500 });
  });

  it('falls to 16:9 when the workspace rect is unusable', () => {
    expect(resolveLayoutSize({ paneRect: null, workspaceRect: { width: 0, height: 0 }, fraction: { w: 1, h: 1 } }))
      .toEqual(FALLBACK_LAYOUT_SIZE);
  });

  it.each([
    ['zero width', { w: 0, h: 0.5 }],
    ['zero height', { w: 0.5, h: 0 }],
    ['NaN width', { w: NaN, h: 0.5 }],
    ['NaN height', { w: 0.5, h: NaN }],
  ])('falls to 16:9 when the fraction has a %s', (_label, fraction) => {
    expect(resolveLayoutSize({ paneRect: null, workspaceRect: workspace, fraction }))
      .toEqual(FALLBACK_LAYOUT_SIZE);
  });

  it('falls to 16:9 when there is no fraction', () => {
    expect(resolveLayoutSize({ paneRect: null, workspaceRect: workspace, fraction: null }))
      .toEqual(FALLBACK_LAYOUT_SIZE);
  });

  it('falls to 16:9 when everything is missing', () => {
    const size = resolveLayoutSize({ paneRect: null, workspaceRect: null, fraction: null });
    expect(size.width / size.height).toBeCloseTo(16 / 9, 5);
  });
});

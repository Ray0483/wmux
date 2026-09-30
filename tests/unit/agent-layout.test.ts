import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  splitNode,
  getAllPaneIds,
  findLeaf,
  chooseGridShape,
  buildAgentLayout,
  leafFraction,
  MAX_AGENT_CELLS,
} from '../../src/renderer/store/split-utils';
import type { SplitNode, PaneId, SurfaceId } from '../../src/shared/types';

const id = (s: string) => s as PaneId;
const A = id('pane-a');
const VIDEO = { width: 1920, height: 1080 };

function leafOf(tree: SplitNode, paneId: PaneId) {
  const leaf = findLeaf(tree, paneId);
  if (!leaf) throw new Error(`no leaf ${paneId}`);
  return leaf;
}

describe('chooseGridShape', () => {
  it.each([
    // [n, worker width, worker height, cols]
    [2, 1920 * 0.6, 1080, 1],
    [2, 5120 * 0.6, 1440, 2],
    [4, 1080 * 0.6, 1920, 1],
    [1, 1152, 1080, 1],
  ])('n=%i in %ip x %ip -> %i cols', (n, w, h, cols) => {
    const shape = chooseGridShape(n, w, h);
    expect(shape.cols).toBe(cols);
    expect(shape.rows).toBe(Math.ceil(n / cols));
  });

  it('covers every cell: cols * rows >= n and no empty row', () => {
    for (let n = 1; n <= MAX_AGENT_CELLS; n++) {
      const { cols, rows } = chooseGridShape(n, 1600, 900);
      expect(cols).toBeGreaterThanOrEqual(1);
      expect(cols).toBeLessThanOrEqual(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect((rows - 1) * cols).toBeLessThan(n);
    }
  });

  it('goes wider on a wider area', () => {
    const narrow = chooseGridShape(8, 900, 1200).cols;
    const wide = chooseGridShape(8, 3000, 700).cols;
    expect(wide).toBeGreaterThan(narrow);
  });

  it('breaks an exact tie towards fewer columns', () => {
    // 1x1.6 area: stacked cells are 3.2:1, side by side 0.8:1 — both exactly a factor 2 from 1.6
    const shape = chooseGridShape(2, 1.6, 1);
    expect(shape.cols).toBe(1);
  });

  it.each([
    ['zero width', 0, 1080],
    ['zero height', 1920, 0],
    ['NaN width', NaN, 1080],
    ['Infinity height', 1920, Infinity],
    ['negative', -5, -5],
  ])('falls back to 16:9 for %s', (_label, w, h) => {
    expect(chooseGridShape(4, w, h)).toEqual(chooseGridShape(4, 1920, 1080));
  });

  it('treats a non-positive or NaN count as 1', () => {
    expect(chooseGridShape(0, 1920, 1080)).toEqual({ cols: 1, rows: 1 });
    expect(chooseGridShape(NaN, 1920, 1080)).toEqual({ cols: 1, rows: 1 });
  });
});

describe('buildAgentLayout', () => {
  it('replaces only the anchor leaf with [anchor | grid] at the coordinator ratio', () => {
    const tree = createLeaf(A);
    const result = buildAgentLayout(tree, A, 2, VIDEO)!;

    expect(result.tree.type).toBe('branch');
    if (result.tree.type !== 'branch') return;
    expect(result.tree.direction).toBe('horizontal');
    expect(result.tree.ratio).toBe(0.4);
    expect(result.tree.children[0]).toBe(tree);
    expect(getAllPaneIds(result.tree)).toEqual([A, ...result.newPaneIds]);
    expect(result.newPaneIds).toHaveLength(2);
  });

  it('yields n new panes plus the anchor, in row-major order', () => {
    for (const n of [1, 3, 5, MAX_AGENT_CELLS]) {
      const result = buildAgentLayout(createLeaf(A), A, n, VIDEO)!;
      expect(result.newPaneIds).toHaveLength(n);
      expect(new Set(result.newPaneIds).size).toBe(n);
      expect(getAllPaneIds(result.tree)).toEqual([A, ...result.newPaneIds]);
    }
  });

  it('stacks two workers on 16:9 and puts them side by side on 32:9', () => {
    const stacked = buildAgentLayout(createLeaf(A), A, 2, { width: 1920, height: 1080 })!;
    expect(stacked.cols).toBe(1);
    expect(stacked.rows).toBe(2);
    const grid = (stacked.tree as Extract<SplitNode, { type: 'branch' }>).children[1];
    expect(grid.type === 'branch' && grid.direction).toBe('vertical');

    const wide = buildAgentLayout(createLeaf(A), A, 2, { width: 5120, height: 1440 })!;
    expect(wide.cols).toBe(2);
    expect(wide.rows).toBe(1);
    const row = (wide.tree as Extract<SplitNode, { type: 'branch' }>).children[1];
    expect(row.type === 'branch' && row.direction).toBe('horizontal');
  });

  it('shapes the grid from the width left after the coordinator column', () => {
    // 2 cells go side by side once the area is wider than 1.6:1. At 2.4:1 the
    // full width qualifies, the 60% left by a 0.4 coordinator does not (1.44:1).
    const size = { width: 2592, height: 1080 };
    expect(chooseGridShape(2, size.width, size.height).cols).toBe(2);
    expect(buildAgentLayout(createLeaf(A), A, 2, size, 0.4)!.cols).toBe(1);
    expect(buildAgentLayout(createLeaf(A), A, 2, size, 0.2)!.cols).toBe(2);
  });

  it('lays a short last row out with wider cells, not empty ones', () => {
    const result = buildAgentLayout(createLeaf(A), A, 5, { width: 6000, height: 1200 })!;
    expect(result.cols * result.rows).toBeGreaterThanOrEqual(5);
    expect(getAllPaneIds(result.tree)).toHaveLength(6);
  });

  it('leaves every other leaf, its surfaces and ratios, exactly as they were', () => {
    let tree: SplitNode = createLeaf(A);
    tree = splitNode(tree, A, id('pane-user'), 'terminal', 'horizontal');
    tree = splitNode(tree, id('pane-user'), id('pane-user2'), 'browser', 'vertical');
    if (tree.type !== 'branch') throw new Error('expected a branch');
    const userSubtree = tree.children[1];
    const before = JSON.stringify(userSubtree);

    const result = buildAgentLayout(tree, A, 3, VIDEO)!;
    if (result.tree.type !== 'branch') throw new Error('expected a branch');

    expect(result.tree.ratio).toBe(tree.ratio);
    expect(result.tree.children[1]).toBe(userSubtree);
    expect(JSON.stringify(userSubtree)).toBe(before);
    expect(getAllPaneIds(result.tree)).toHaveLength(3 + 3);
  });

  it('works on an anchor nested deep in the tree, leaving the sibling identical', () => {
    let tree: SplitNode = createLeaf(id('pane-left'));
    tree = splitNode(tree, id('pane-left'), A, 'terminal', 'horizontal');
    tree = splitNode(tree, A, id('pane-below'), 'terminal', 'vertical');
    if (tree.type !== 'branch') throw new Error('expected a branch');
    const left = tree.children[0];

    const result = buildAgentLayout(tree, A, 2, VIDEO)!;
    if (result.tree.type !== 'branch') throw new Error('expected a branch');
    expect(result.tree.children[0]).toBe(left);
    expect(getAllPaneIds(result.tree)).toContain(A);
    expect(getAllPaneIds(result.tree)).toContain(id('pane-below'));
  });

  it('keeps the anchor surfaces, their order and the active index', () => {
    const anchor = createLeaf(A);
    const surfaces = [
      { ...anchor.surfaces[0] },
      { id: 'surf-extra1' as SurfaceId, type: 'browser' as const },
      { id: 'surf-extra2' as SurfaceId, type: 'terminal' as const },
    ];
    const tree: SplitNode = { ...anchor, surfaces, activeSurfaceIndex: 2 };

    const result = buildAgentLayout(tree, A, 2, VIDEO)!;
    const kept = leafOf(result.tree, A);
    expect(kept).toBe(tree);
    expect(kept.surfaces.map((s) => s.id)).toEqual(surfaces.map((s) => s.id));
    expect(kept.activeSurfaceIndex).toBe(2);
  });

  it('gives every new cell one fresh surface of the requested type', () => {
    const result = buildAgentLayout(createLeaf(A), A, 2, VIDEO, 0.4, 'browser')!;
    for (const paneId of result.newPaneIds) {
      const leaf = leafOf(result.tree, paneId);
      expect(leaf.surfaces).toHaveLength(1);
      expect(leaf.surfaces[0].type).toBe('browser');
    }
  });

  it.each([
    [0.05, 0.2],
    [0.2, 0.2],
    [0.55, 0.55],
    [0.8, 0.8],
    [0.95, 0.8],
    [-3, 0.2],
  ])('clamps ratio %f to %f', (given, expected) => {
    const result = buildAgentLayout(createLeaf(A), A, 2, VIDEO, given)!;
    expect(result.tree.type === 'branch' && result.tree.ratio).toBe(expected);
  });

  it('uses the default ratio when the ratio is not a number', () => {
    const result = buildAgentLayout(createLeaf(A), A, 2, VIDEO, NaN)!;
    expect(result.tree.type === 'branch' && result.tree.ratio).toBe(0.4);
  });

  it('returns null for an unknown anchor, and never touches the tree', () => {
    const tree = createLeaf(A);
    const snapshot = JSON.stringify(tree);
    expect(buildAgentLayout(tree, id('pane-nope'), 2, VIDEO)).toBeNull();
    expect(JSON.stringify(tree)).toBe(snapshot);
  });

  it.each([0, -1, 1.5, NaN, MAX_AGENT_CELLS + 1])('returns null for count %s', (count) => {
    expect(buildAgentLayout(createLeaf(A), A, count, VIDEO)).toBeNull();
  });

  it('falls back to 16:9 when the size is unusable', () => {
    const fallback = buildAgentLayout(createLeaf(A), A, 4, { width: 0, height: NaN })!;
    const explicit = buildAgentLayout(createLeaf(A), A, 4, VIDEO)!;
    expect([fallback.cols, fallback.rows]).toEqual([explicit.cols, explicit.rows]);
  });
});

describe('leafFraction', () => {
  it('is the whole area for a lone leaf', () => {
    expect(leafFraction(createLeaf(A), A)).toEqual({ w: 1, h: 1 });
  });

  it('multiplies ratios along the path, per direction', () => {
    let tree: SplitNode = createLeaf(A);
    tree = splitNode(tree, A, id('pane-b'), 'terminal', 'horizontal');
    tree = splitNode(tree, id('pane-b'), id('pane-c'), 'terminal', 'vertical');
    expect(leafFraction(tree, A)).toEqual({ w: 0.5, h: 1 });
    expect(leafFraction(tree, id('pane-b'))).toEqual({ w: 0.5, h: 0.5 });
    expect(leafFraction(tree, id('pane-c'))).toEqual({ w: 0.5, h: 0.5 });
  });

  it('uses 1 - ratio for the second child', () => {
    const result = buildAgentLayout(createLeaf(A), A, 1, VIDEO, 0.4)!;
    const fraction = leafFraction(result.tree, result.newPaneIds[0])!;
    expect(fraction.w).toBeCloseTo(0.6);
    expect(fraction.h).toBe(1);
    expect(leafFraction(result.tree, A)).toEqual({ w: 0.4, h: 1 });
  });

  it('returns null for a pane that is not in the tree', () => {
    expect(leafFraction(createLeaf(A), id('pane-nope'))).toBeNull();
  });
});

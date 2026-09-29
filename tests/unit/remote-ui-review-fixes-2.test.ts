/**
 * Phone console fixes from the #254 integration review, round 2.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string | null {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  return m ? m[2] : null;
}

describe('phone terminal: no xterm 6 black slab below the grid (#254)', () => {
  const css = read('src/renderer/remote/remote.css');

  it('the viewport is transparent and has no native scrollbar', () => {
    const body = ruleBody(css, '.rc-term__host .xterm-viewport');
    expect(body).not.toBeNull();
    expect(body).toMatch(/background-color:\s*transparent\s*!important/);
    expect(body).toMatch(/overflow-y:\s*hidden/);
  });

  it('the scrollable element is transparent, and the theme colour is painted once on .rc-term', () => {
    expect(ruleBody(css, '.rc-term__host .xterm-scrollable-element')).toMatch(/background-color:\s*transparent\s*!important/);
    expect(ruleBody(css, '.rc-term')).toMatch(/background:\s*var\(--term-bg\)/);
  });
});

/**
 * Phone console fixes from the #254 integration review, round 2.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { altHintKey } from '../../src/renderer/remote/components/TermView';
import { armedLabelKey } from '../../src/renderer/remote/components/KeyBar';
import { emptyListKey } from '../../src/renderer/remote/screens/ConsoleScreen';
import { pairFailureKey } from '../../src/renderer/remote/screens/PairScreen';
import { createT } from '../../src/renderer/remote/i18n';
import { en as desktopEn } from '../../src/renderer/i18n/locales/en';

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

describe('phone wording fixes (#254)', () => {
  const t = createT('en');

  it('the full-screen hint names PgUp / PgDn under ⋯ for an operator, and no keys for a viewer', () => {
    expect(altHintKey(true)).toBe('attach.altHint');
    expect(t.t(altHintKey(true))).toContain('⋯');
    expect(altHintKey(false)).toBe('attach.altHintViewer');
    expect(t.t(altHintKey(false))).not.toMatch(/PgUp|PgDn/);
  });

  it('an armed key names what the second tap does', () => {
    expect(armedLabelKey('interrupt')).toBe('keys.armedInterrupt');
    expect(armedLabelKey('blocked')).toBe('keys.armedAnswer');
    expect(armedLabelKey(null)).toBe('keys.armed');
  });

  it('"no agents" only once a roster arrived on a live socket; before that, waiting', () => {
    expect(emptyListKey(false, 'ready')).toBe('console.waiting');
    expect(emptyListKey(false, 'waiting')).toBe('console.waiting');
    expect(emptyListKey(true, 'waiting')).toBe('console.waiting');
    expect(emptyListKey(true, 'ready')).toBe('console.empty');
  });

  it('a pairing refusal says what will actually fix it', () => {
    expect(pairFailureKey(429, { error: 'rate' })).toBe('pair.rate');
    expect(pairFailureKey(429, null)).toBe('pair.rate');
    expect(pairFailureKey(400, { error: 'device-cap' })).toBe('pair.deviceCap');
    expect(pairFailureKey(400, { error: 'bad-request' })).toBe('pair.failed');
    expect(pairFailureKey(403, null)).toBe('pair.failed');
    expect(pairFailureKey(null, null)).toBe('pair.failed');
  });

  it('the alerts limitation says a locked phone or a background tab may get nothing', () => {
    expect(t.t('prefs.limits')).toMatch(/on screen/);
    expect(t.t('prefs.limits')).toMatch(/background/);
  });

  it('English "revoke all" reads right with one device', () => {
    const text = desktopEn['settings.remote.revokeAllConfirm'].replace('{count}', '1');
    expect(text).not.toMatch(/\b1 devices\b/);
  });
});

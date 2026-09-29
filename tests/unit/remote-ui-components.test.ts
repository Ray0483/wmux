// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRosterEntry } from '../../src/shared/remote-console-protocol';
import { createT } from '../../src/renderer/remote/i18n';
import { PairScreen } from '../../src/renderer/remote/screens/PairScreen';
import { AgentCard } from '../../src/renderer/remote/components/AgentCard';
import { KeyBar } from '../../src/renderer/remote/components/KeyBar';
import { Toasts } from '../../src/renderer/remote/components/Toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createT('en');
const fr = createT('fr');
let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(el); });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const entry = (over: Partial<RemoteRosterEntry> = {}): RemoteRosterEntry => ({
  s: 'surf-00000000-0000-4000-8000-000000000001',
  workspaceId: 'ws-1',
  workspaceTitle: 'Main',
  label: 'claude',
  kind: 'claude',
  state: 'blocked',
  stateSource: 'declared',
  done: false,
  blockedReason: 'permission: Bash',
  choices: [{ id: 'y', label: 'Yes' }],
  answerPending: false,
  dwellMs: 0,
  ...over,
});

describe('PairScreen (#254)', () => {
  it('starts with an EMPTY name so the name typed on the desktop wins, and pairs with it empty', () => {
    const onPair = vi.fn();
    const el = render(createElement(PairScreen, { t, busy: false, failed: false, onPair }));
    const input = el.querySelector('input')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(t.t('pair.namePlaceholder'));
    expect(input.maxLength).toBe(64);
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    act(() => { button.click(); });
    expect(onPair).toHaveBeenCalledWith('');
  });
});

describe('AgentCard (#254)', () => {
  it('a view-only device is told to answer on the computer, not to open the card', () => {
    const el = render(createElement(AgentCard, { entry: entry(), sinceRoster: 0, operator: false, t, onOpen: vi.fn(), onAnswer: vi.fn() }));
    expect(el.textContent).toContain(t.t('card.answerOnComputer'));
    expect(el.textContent).not.toContain(t.t('card.openToAnswer'));
  });

  it('an operator with no declared choices is still told to open it', () => {
    const el = render(createElement(AgentCard, { entry: entry({ choices: [] }), sinceRoster: 0, operator: true, t, onOpen: vi.fn(), onAnswer: vi.fn() }));
    expect(el.textContent).toContain(t.t('card.openToAnswer'));
  });
});

describe('KeyBar (#254)', () => {
  it('an armed key says so in visible text, not only in colour', () => {
    const idle = render(createElement(KeyBar, { armed: null, t, onKey: vi.fn() }));
    expect(idle.querySelector('.rc-keybar__armed')).toBeNull();
    act(() => root!.render(createElement(KeyBar, { armed: 'enter', t, onKey: vi.fn() })));
    const pill = idle.querySelector('.rc-keybar__armed');
    expect(pill?.textContent).toContain(t.t('keys.armed'));
    expect(pill?.textContent).toContain(t.t('keys.enter'));
  });

  it('names keys in the page language', () => {
    const el = render(createElement(KeyBar, { armed: null, t: fr, onKey: vi.fn() }));
    const labels = [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toContain(fr.t('keys.up'));
    expect(labels).toContain(fr.t('keys.enter'));
    expect(labels).not.toContain('Up');
  });
});

describe('Toasts (#254)', () => {
  it('the × is announced as Dismiss, not Cancel', () => {
    const el = render(createElement(Toasts, {
      toasts: [{ id: 1, kind: 'error', text: 'x' }], roster: [], operator: true, t, onOpen: vi.fn(), onAnswer: vi.fn(), onDismiss: vi.fn(),
    }));
    const close = el.querySelector('.rc-toast__close');
    expect(close?.getAttribute('aria-label')).toBe(t.t('common.dismiss'));
  });
});

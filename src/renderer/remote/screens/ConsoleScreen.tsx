/**
 * The agent list (#254): what needs you first, then what finished, then the rest.
 *
 * The SERVER sorts (blocked by longest dwell, done by newest, then working,
 * idle, unknown) and owns Done, which it tracks per device; this screen only
 * buckets that order into sections so "Needs you" is never below the fold
 * behind twelve idle shells. Buckets are exclusive and checked in section
 * order, so a card appears exactly once.
 */

import { useEffect, useState } from 'react';
import type { RemoteRosterEntry, RemoteScope } from '../../../shared/remote-console-protocol';
import type { RemoteMessageKey, RemoteT } from '../i18n';
import { AgentCard } from '../components/AgentCard';
import type { WsStatus } from '../ws-client';

type SectionId = 'needsYou' | 'done' | 'working' | 'idle' | 'other';

const SECTIONS: readonly { id: SectionId; key: RemoteMessageKey }[] = [
  { id: 'needsYou', key: 'console.needsYou' },
  { id: 'done', key: 'console.done' },
  { id: 'working', key: 'console.working' },
  { id: 'idle', key: 'console.idle' },
  { id: 'other', key: 'console.other' },
];

export function sectionOf(e: RemoteRosterEntry): SectionId {
  if (e.state === 'blocked') return 'needsYou';
  if (e.done) return 'done';
  if (e.state === 'working') return 'working';
  if (e.state === 'idle') return 'idle';
  return 'other';
}

/**
 * The accessible name of a section, or undefined for the visible heading.
 * Needs-you is the section that matters from across the room, so a screen
 * reader hears it as "2 agents need you" rather than a heading and a bare
 * number beside it.
 */
export function sectionLabel(t: RemoteT, id: SectionId, n: number): string | undefined {
  return id === 'needsYou' ? t.tn('console.needsYouCount', n) : undefined;
}

export function connKey(status: WsStatus): RemoteMessageKey {
  if (status === 'ready') return 'conn.ready';
  if (status === 'waiting') return 'conn.waiting';
  if (status === 'stopped') return 'conn.offline';
  return 'conn.connecting';
}

/**
 * What an EMPTY list says. "No agents are running" is an answer, and it is
 * only one once this socket has actually delivered a roster: before the first
 * `agents` frame, or while the socket is down, the list is empty because the
 * data is missing, and saying "none" there reads as the computer's answer.
 */
export function emptyListKey(rosterReceived: boolean, status: WsStatus): RemoteMessageKey {
  return rosterReceived && status === 'ready' ? 'console.empty' : 'console.waiting';
}

/**
 * Why this device cannot type, or null when it can. A device paired with
 * Control that a plain-HTTP LAN bind demotes to view-only is told THAT, not
 * the generic line: otherwise it looks broken, and the fix (Tailscale, or the
 * desktop's "allow control over plain HTTP") is nowhere in sight.
 *
 * On a SECURE page the LAN bind is not what demoted it — a LAN bind is plain
 * http on a LAN address, never a secure context. There the reason is that
 * this device's pairing once crossed a plain-HTTP LAN (server.ts
 * effectiveScopeFor), and the fix is to pair it again from here.
 */
export function viewerNoticeKey(pairedScope: RemoteScope, effectiveScope: RemoteScope, secureContext = false): RemoteMessageKey | null {
  if (effectiveScope === 'operator') return null;
  if (pairedScope !== 'operator') return 'console.viewerNotice';
  return secureContext ? 'console.repairForControl' : 'console.controlLimited';
}

interface Props {
  t: RemoteT;
  roster: readonly RemoteRosterEntry[];
  /** Whether an `agents` frame has arrived on this page yet. */
  rosterReceived: boolean;
  rosterAt: number;
  status: WsStatus;
  host: string;
  operator: boolean;
  /** The scope this device was PAIRED with, which the bind may have narrowed. */
  pairedScope: RemoteScope;
  onOpen(s: string): void;
  onAnswer(s: string, choiceId: string, prompt: number | null): void;
  onSeen(s: string): void;
  onPrefs(): void;
}

export function ConsoleScreen({ t, roster, rosterReceived, rosterAt, status, host, operator, pairedScope, onOpen, onAnswer, onSeen, onPrefs }: Readonly<Props>) {
  const notice = viewerNoticeKey(pairedScope, operator ? 'operator' : 'viewer', globalThis.isSecureContext === true);
  // Ages tick without a new roster frame; 15 s is finer than any age shows.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = globalThis.setInterval(() => setNow(Date.now()), 15_000);
    return () => globalThis.clearInterval(id);
  }, []);
  const since = Math.max(0, now - rosterAt);

  const buckets = new Map<SectionId, RemoteRosterEntry[]>();
  for (const e of roster) {
    const id = sectionOf(e);
    const list = buckets.get(id) ?? [];
    list.push(e);
    buckets.set(id, list);
  }

  return (
    <main className="rc-screen rc-console">
      <header className="rc-bar">
        <h1 className="rc-bar__title">wmux<span className="rc-bar__host">{host}</span></h1>
        <span className={`rc-chip rc-chip--${status}`}>{t.t(connKey(status))}</span>
        <button type="button" className="rc-bar__btn" onClick={onPrefs} aria-label={t.t('common.settings')}>⚙</button>
      </header>

      {notice && <p className="rc-banner">{t.t(notice)}</p>}

      <div className="rc-console__list">
        {roster.length === 0 && <p className="rc-empty">{t.t(emptyListKey(rosterReceived, status))}</p>}
        {SECTIONS.map(({ id, key }) => {
          const list = buckets.get(id);
          if (!list || list.length === 0) return null;
          return (
            <section key={id} className={`rc-section rc-section--${id}`} aria-label={sectionLabel(t, id, list.length)}>
              <h2 className="rc-section__title">
                <span>{t.t(key)}</span>
                <span className="rc-section__count">{list.length}</span>
                {id === 'done' && (
                  <button type="button" className="rc-section__action" onClick={() => list.forEach((e) => onSeen(e.s))}>
                    {t.t('console.markAllSeen')}
                  </button>
                )}
              </h2>
              {list.map((e) => (
                <AgentCard
                  key={e.s}
                  entry={e}
                  sinceRoster={since}
                  operator={operator}
                  t={t}
                  onOpen={onOpen}
                  onAnswer={onAnswer}
                />
              ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}

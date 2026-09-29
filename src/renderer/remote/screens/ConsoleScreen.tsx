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
import type { RemoteRosterEntry } from '../../../shared/remote-console-protocol';
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

export function connKey(status: WsStatus): RemoteMessageKey {
  if (status === 'ready') return 'conn.ready';
  if (status === 'waiting') return 'conn.waiting';
  if (status === 'stopped') return 'conn.offline';
  return 'conn.connecting';
}

interface Props {
  t: RemoteT;
  roster: readonly RemoteRosterEntry[];
  rosterAt: number;
  status: WsStatus;
  host: string;
  operator: boolean;
  onOpen(s: string): void;
  onAnswer(s: string, choiceId: string): void;
  onSeen(s: string): void;
  onPrefs(): void;
}

export function ConsoleScreen({ t, roster, rosterAt, status, host, operator, onOpen, onAnswer, onSeen, onPrefs }: Readonly<Props>) {
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

      {!operator && <p className="rc-banner">{t.t('console.viewerNotice')}</p>}

      <div className="rc-console__list">
        {roster.length === 0 && <p className="rc-empty">{t.t('console.empty')}</p>}
        {SECTIONS.map(({ id, key }) => {
          const list = buckets.get(id);
          if (!list || list.length === 0) return null;
          return (
            <section key={id} className={`rc-section rc-section--${id}`}>
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

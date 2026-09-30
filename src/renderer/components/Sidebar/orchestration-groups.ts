import type { OrchestrationAgent } from '../../../shared/types';

export type WaveItem =
  | { kind: 'agent'; agent: OrchestrationAgent }
  | { kind: 'group'; name: string; agents: OrchestrationAgent[]; done: number; total: number };

// state.json is untrusted: anything that is not a non-blank string means "no group".
function groupName(agent: OrchestrationAgent): string | null {
  const raw: unknown = agent?.group;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name === '' ? null : name;
}

const isDone = (a: OrchestrationAgent) => a?.status === 'exited' || a?.status === 'failed';

/**
 * Item order is cell order: item k is the k-th cell `json-tool.js wave-cells-each`
 * assigns (first appearance). A parity test keeps the two from drifting.
 */
export function groupWaveAgents(agents: OrchestrationAgent[]): WaveItem[] {
  const buckets: { name: string | null; agents: OrchestrationAgent[] }[] = [];
  const byName = new Map<string, number>();

  for (const agent of agents) {
    const name = groupName(agent);
    const at = name === null ? undefined : byName.get(name);
    if (at !== undefined) {
      buckets[at].agents.push(agent);
      continue;
    }
    if (name !== null) byName.set(name, buckets.length);
    buckets.push({ name, agents: [agent] });
  }

  return buckets.map((b): WaveItem =>
    b.name === null || b.agents.length === 1
      ? { kind: 'agent', agent: b.agents[0] }
      : {
          kind: 'group',
          name: b.name,
          agents: b.agents,
          done: b.agents.filter(isDone).length,
          total: b.agents.length,
        },
  );
}

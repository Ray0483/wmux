import { getAgentState, wasAgentReleased } from './agent-state';
import { stampClaudeSessionIds } from './claude-resume';
import { stampCodexSessionIds } from './codex-resume';

export function stampAgentSessionIds<T>(tree: T): T {
  const claude = stampClaudeSessionIds(tree, id => {
    const agent = getAgentState(id);
    return agent?.sessionProvider === 'codex' ? null : agent?.sessionId;
  });
  return stampCodexSessionIds(claude, id => {
    const agent = getAgentState(id);
    if (agent?.sessionProvider === 'codex') return agent.sessionId;
    if (agent?.sessionId || wasAgentReleased(id)) return null;
    // A restored Codex has not reported yet. Keep its recovery handle.
    return undefined;
  });
}

/**
 * What a Claude Code `Notification` hook is actually about (issue #253).
 *
 * One hook event, several unrelated situations. Claude Code fires `Notification`
 * for a permission prompt, for an MCP elicitation dialog, for a completed auth
 * flow, and for the idle reminder — "Claude is waiting for your input" — that it
 * arms after the main loop has been quiet for ~60s. Only the first two are a
 * question on screen. The idle reminder is the pane being idle, which is the
 * opposite of "Needs you".
 *
 * wmux used to treat every one of them as a question, and #151 papered over
 * the common case by reading the pane's run depth instead ("a prompt can only
 * occur inside a live turn, so depth 0 means nudge"). #253 is where that
 * inference breaks: a BACKGROUND subagent keeps firing PreToolUse/PostToolUse
 * on the parent's WMUX_SURFACE_ID after the parent's `Stop` has zeroed the
 * depth, so by the time it finishes the depth reads 1 again and the idle
 * reminder that follows was read as a permission prompt — "Needs you" plus a
 * bell notification, on a pane with nothing to answer.
 *
 * Claude Code states which one it is in `notification_type`, so that is the
 * primary signal and the depth heuristic is only a fallback for payloads that
 * do not carry it (older Claude Code, or an older wmux-hook.js that does not
 * forward it).
 *
 * Shared by main (declared agent state) and the renderer (the bell/desktop
 * notification) on purpose: the two consumers must agree about whether a
 * notification is a question, or the pane says "idle" while the bell rings.
 */

/**
 * - `attention` — something is on screen for the user to answer.
 * - `idle`      — the idle reminder; the pane is simply waiting for a new prompt.
 * - `info`      — informational (e.g. auth succeeded); nothing to answer.
 * - `unknown`   — the payload does not say; the caller falls back to its own
 *                 heuristic, which is how every Notification was handled before.
 */
export type ClaudeNotificationKind = 'attention' | 'idle' | 'info' | 'unknown';

/**
 * The idle reminder's text, verbatim. Used ONLY when `notification_type` is
 * absent, and only as an exact match: if Claude Code ever rewords it, the
 * message stops matching and falls to `unknown` — the pre-#253 behaviour — so a
 * rewording can make wmux too eager again but can never make it swallow a real
 * permission prompt. Prefix or substring matching would not have that property.
 */
export const CLAUDE_IDLE_MESSAGE = 'Claude is waiting for your input';

/** `notification_type` values, as Claude Code documents them for hook matchers. */
const KIND_BY_TYPE: Record<string, ClaudeNotificationKind> = {
  permission_prompt: 'attention',
  elicitation_dialog: 'attention',
  idle_prompt: 'idle',
  auth_success: 'info',
};

export function classifyClaudeNotification(
  notificationType: unknown,
  message: unknown,
): ClaudeNotificationKind {
  const type = typeof notificationType === 'string' ? notificationType.trim() : '';
  if (type) {
    // A type we do not recognise is treated as a question, not ignored: a new
    // kind of prompt added upstream should park the pane rather than go silent.
    return KIND_BY_TYPE[type] ?? 'attention';
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (text === CLAUDE_IDLE_MESSAGE) return 'idle';
  return 'unknown';
}

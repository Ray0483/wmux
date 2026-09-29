import { describe, it, expect } from 'vitest';
import { classifyClaudeNotification, CLAUDE_IDLE_MESSAGE } from '../../src/shared/claude-notification';

/**
 * The one answer main (declared state) and the renderer (the bell) share about
 * whether a Claude Code Notification is a question (issue #253).
 */
describe('classifyClaudeNotification', () => {
  it('reads notification_type first', () => {
    expect(classifyClaudeNotification('idle_prompt', 'anything')).toBe('idle');
    expect(classifyClaudeNotification('auth_success', 'anything')).toBe('info');
    expect(classifyClaudeNotification('permission_prompt', CLAUDE_IDLE_MESSAGE)).toBe('attention');
    expect(classifyClaudeNotification('elicitation_dialog', '')).toBe('attention');
  });

  it('treats an unrecognised type as a question, never as silence', () => {
    expect(classifyClaudeNotification('brand_new_prompt', '')).toBe('attention');
  });

  it('falls back to the exact idle text when no type is sent', () => {
    expect(classifyClaudeNotification(undefined, 'Claude is waiting for your input')).toBe('idle');
    expect(classifyClaudeNotification('', '  Claude is waiting for your input\n')).toBe('idle');
  });

  it('does not guess from anything but the exact idle text', () => {
    // A reworded or partial message falls to `unknown` — the caller's pre-#253
    // behaviour — rather than being read as idle and swallowing a real prompt.
    expect(classifyClaudeNotification(undefined, 'Claude needs your permission to use Bash')).toBe('unknown');
    expect(classifyClaudeNotification(undefined, 'Claude is waiting for your input to approve rm -rf')).toBe('unknown');
    expect(classifyClaudeNotification(null, null)).toBe('unknown');
    expect(classifyClaudeNotification(42, {})).toBe('unknown');
  });
});

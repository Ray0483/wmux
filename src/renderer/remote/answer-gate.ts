/**
 * One answer per question from this page (#254).
 *
 * A choice button stays on screen until a roster frame with `answerPending`
 * arrives, and the server coalesces those. A second tap in that gap is
 * refused by `answerAgent` — the first answer consumed the choices — as
 * `no-choices` (or `not-blocked` once the agent confirmed), and showing that
 * as an error toast right after a successful answer reads as "my answer
 * failed". So: a tap while an answer for the same surface is in flight is
 * dropped, and those two refusals shortly after our own success are benign.
 */

import type { AckCode } from '../../shared/remote-console-protocol';

/** How long after a successful answer a "nothing to answer" refusal is still ours. */
export const ANSWER_ECHO_MS = 10_000;

const BENIGN_AFTER_SUCCESS: ReadonlySet<AckCode> = new Set<AckCode>(['no-choices', 'not-blocked']);

export class AnswerGate {
  private readonly inFlight = new Set<string>();
  private readonly answeredAt = new Map<string, number>();

  /** False when an answer for this surface is already on its way: drop the tap. */
  begin(s: string): boolean {
    if (this.inFlight.has(s)) return false;
    this.inFlight.add(s);
    return true;
  }

  /** The ack (or the failure) arrived. */
  settle(s: string, ok: boolean, now: number): void {
    this.inFlight.delete(s);
    if (ok) this.answeredAt.set(s, now);
  }

  /** Should this refusal be shown? Not when it only echoes our own answer. */
  shouldReport(s: string, code: AckCode | undefined, now: number): boolean {
    const at = this.answeredAt.get(s);
    if (at === undefined || code === undefined || !BENIGN_AFTER_SUCCESS.has(code)) return true;
    return now - at > ANSWER_ECHO_MS;
  }
}

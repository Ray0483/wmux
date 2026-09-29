/**
 * What a phone's composer text may become on its way into a PTY (#254).
 *
 * Pure and node-free: the server applies it, and the phone UI applies the
 * same function to preview what will actually be sent.
 *
 * The threat is the composer being used to type TERMINAL CONTROL rather than
 * text. `ESC[201~` inside a bracketed paste ends the paste early and lets the
 * rest run as keystrokes; OSC 52 asks the terminal to write the clipboard; an
 * 8-bit C1 CSI (U+009B) is a whole escape introducer in one character; bidi
 * overrides make what the agent reads differ from what the human saw. The
 * composer is for text, so every control except TAB and LF goes, and line
 * endings collapse to LF so `buildComposerWrites` alone decides what Enter is.
 * Stripping the introducer is enough: what is left of `ESC[201~` is the
 * printable `[201~`, which is inert.
 */

const BIDI_RANGES: readonly (readonly [number, number])[] = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isBidiControl(cp: number): boolean {
  return BIDI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** C0 minus TAB/LF, DEL, C1. Written as a predicate rather than a control-char regex. */
function isStrippedControl(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a) return false;
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

function filterCodePoints(text: string, drop: (cp: number) => boolean): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!drop(cp)) out += ch;
  }
  return out;
}

/** Remove bidi embedding/override/isolate controls (the set `normalizeOscTitle` strips, #221). */
export function stripBidi(text: string): string {
  return filterCodePoints(text, isBidiControl);
}

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
export function capText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function sanitizeComposerText(text: string): string {
  const unified = text.split('\r\n').join('\n').split('\r').join('\n');
  return filterCodePoints(unified, (cp) => isStrippedControl(cp) || isBidiControl(cp));
}

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * The PTY writes for one composer send, in order. `bracketed` is the DESKTOP
 * terminal's mode as main queried it, never the phone's opinion.
 *
 * Submit is a separate trailing `\r` — the session sleeps 40 ms before it —
 * because an agent TUI that sees paste-then-Enter in one read treats the
 * Enter as part of the paste and inserts a newline instead of submitting.
 * Without bracketed paste, LF becomes CR: that is what a key press sends —
 * which is exactly why an Insert (`submit: false`) of several lines into a
 * non-bracketed terminal is refused here rather than built: every CR would be
 * an Enter, and Insert is the one send that promises not to press it. The
 * session answers that case with `multiline-insert` before it gets here.
 */
export function buildComposerWrites(clean: string, opts: { bracketed: boolean; submit: boolean }): string[] {
  if (!opts.submit && !opts.bracketed && clean.includes('\n')) {
    throw new RangeError('multiline insert needs bracketed paste');
  }
  const writes: string[] = [];
  if (clean !== '') {
    writes.push(opts.bracketed ? PASTE_START + clean + PASTE_END : clean.split('\n').join('\r'));
  }
  if (opts.submit) writes.push('\r');
  return writes;
}

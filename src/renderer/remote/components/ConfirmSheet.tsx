/**
 * A bottom sheet that asks one question (#254).
 *
 * Built into the page rather than `confirm()`: a native dialog on a phone
 * blocks the socket's event loop for as long as it is up (acks, pings and the
 * terminal stream all stall behind it), and embedded browsers are free to
 * suppress it entirely — which would read as "Cancel" and silently drop the
 * action. Everything is rendered as text; nothing here takes HTML.
 */

import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  body?: string;
  /** Shown verbatim in a monospace block (a URL about to be opened). */
  detail?: string;
  okLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onOk(): void;
  onCancel(): void;
}

export function ConfirmSheet({ title, body, detail, okLabel, cancelLabel, danger, onOk, onCancel }: Readonly<Props>) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Through a ref, so a parent passing an inline arrow does not re-run the
  // mount effect (and steal focus back) on every one of its renders.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    // Focus the SAFE answer, so a stray Enter on a hardware keyboard cancels.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancelRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="rc-sheet" role="presentation">
      <button type="button" className="rc-sheet__scrim" aria-label={cancelLabel} onClick={onCancel} />
      <div className="rc-sheet__panel" role="alertdialog" aria-modal="true" aria-labelledby="rc-sheet-title">
        <h2 id="rc-sheet-title" className="rc-sheet__title">{title}</h2>
        {body && <p className="rc-sheet__body">{body}</p>}
        {detail && <pre className="rc-sheet__detail">{detail}</pre>}
        <div className="rc-sheet__actions">
          <button ref={cancelRef} type="button" className="rc-btn rc-btn--ghost" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? 'rc-btn rc-btn--danger' : 'rc-btn rc-btn--primary'} onClick={onOk}>{okLabel}</button>
        </div>
      </div>
    </div>
  );
}

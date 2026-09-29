/**
 * The phone's text box into an agent (#254). All decisions live in the pure
 * `composerReducer` (composer-state.ts); this is the wiring: the textarea, the
 * draft's persistence, the socket request, and the confirm sheet.
 *
 * A reducer transition and the request it implies are computed TOGETHER from
 * a ref to the current state, not by an effect watching `phase`: an effect
 * would re-send whenever React re-ran it (StrictMode does, on purpose), and a
 * duplicate frame is exactly what the nonce exists to make harmless — but not
 * what this component should lean on it for.
 */

import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { ClientMessage } from '../../../shared/remote-console-protocol';
import {
  canSubmit,
  composerLabel,
  composerReducer,
  initialComposer,
  loadDraft,
  saveDraft,
  type ComposerAction,
  type ComposerFrame,
  type ComposerState,
} from '../composer-state';
import { ackMessageKey, type RemoteT } from '../i18n';
import { newNonce, type WsClient } from '../ws-client';
import { ConfirmSheet } from './ConfirmSheet';

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

interface Props {
  client: WsClient;
  s: string;
  blocked: boolean;
  maxText: number;
  t: RemoteT;
}

export function Composer({ client, s, blocked, maxText, t }: Readonly<Props>) {
  const [state, dispatch] = useReducer(composerReducer, s, (id: string) => initialComposer(loadDraft(safeStorage(), id)));
  const stateRef = useRef<ComposerState>(state);
  stateRef.current = state;
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { saveDraft(safeStorage(), s, state.draft); }, [s, state.draft]);

  // Auto-grow; the 40vh cap is the CSS max-height, past which it scrolls.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [state.draft]);

  const transmit = useCallback((frame: ComposerFrame) => {
    const msg: Extract<ClientMessage, { t: 'send' }> = { t: 'send', s, nonce: frame.nonce, text: frame.text, submit: frame.submit };
    // Exactly the listed fields: the validator rejects an unknown one, and an
    // explicit `force:false` is noise.
    if (frame.force) msg.force = true;
    client.request(msg).then(
      (ack) => dispatch({ type: 'ack', nonce: ack.nonce, ok: ack.ok, code: ack.code, confirm: ack.confirm }),
      () => dispatch({ type: 'error' }),
    );
  }, [client, s]);

  const act = useCallback((action: ComposerAction) => {
    const next = composerReducer(stateRef.current, action);
    const willSend = next.phase === 'sending' && next.frame !== null && next !== stateRef.current;
    // Advance the ref now, not on the next render: two taps in one tick must
    // see each other, or both would pass the send-once check.
    stateRef.current = next;
    dispatch(action);
    if (willSend && next.frame) transmit(next.frame);
  }, [transmit]);

  const submit = () => act({ type: 'submit', nonce: newNonce(), blocked });

  const label = composerLabel(state, blocked);
  const labelText = {
    send: t.t('composer.send'),
    insert: t.t('composer.insert'),
    sending: t.t('composer.sending'),
  }[label];

  const failure = state.phase === 'failed' ? t.t(ackMessageKey(state.code ?? undefined), { max: maxText }) : null;

  let sheet: ReactNode = null;
  if (state.phase === 'confirm' && state.confirm) {
    const kind = state.confirm;
    sheet = (
      <ConfirmSheet
        title={t.t(`confirm.${kind}.title`)}
        body={t.t(`confirm.${kind}.body`)}
        okLabel={t.t(`confirm.${kind}.ok`)}
        cancelLabel={t.t('common.cancel')}
        danger={kind === 'interrupt'}
        onOk={() => act({ type: 'accept' })}
        onCancel={() => act({ type: 'cancel' })}
      />
    );
  }

  return (
    <div className="rc-composer">
      {failure && <p className="rc-composer__error" role="alert">{failure}</p>}
      <div className="rc-composer__row">
        <textarea
          ref={boxRef}
          className="rc-composer__box"
          rows={1}
          value={state.draft}
          placeholder={t.t('composer.placeholder')}
          aria-label={t.t('composer.placeholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="enter"
          onChange={(e) => act({ type: 'edit', text: e.target.value })}
          onKeyDown={(e) => {
            // A phone's Enter is a newline; a hardware keyboard gets Ctrl/⌘+Enter to send.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className={blocked ? 'rc-btn rc-btn--warn rc-composer__send' : 'rc-btn rc-btn--primary rc-composer__send'}
          disabled={!canSubmit(state, blocked)}
          onClick={submit}
        >
          {labelText}
        </button>
      </div>
      {sheet}
    </div>
  );
}

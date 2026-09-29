import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteBridgeError, RemoteConsoleBridge, RemoteConsoleStatus } from '../../../shared/remote-console-config';
import type { RemoteScope } from '../../../shared/remote-console-protocol';
import { useT, type TranslationKey, type Translator } from '../../i18n';
import { qrDataUri } from './remote-qr';

/**
 * "Pair a device" (#254, spec §8 desktop flow). The one moment a Remote
 * Console credential exists outside main: `pairStart` hands back a URL whose
 * FRAGMENT carries a one-use secret, and this dialog shows it as a QR and as
 * selectable text for its 120 s lifetime and not a moment longer — on expiry,
 * on Cancel, on success and on unmount the offer is dropped from state, so the
 * secret is not left sitting in a component nobody is looking at.
 *
 * Success is observed, not reported: the phone POSTs the secret straight to
 * main, and the only thing the renderer sees is the device list growing. So
 * the device ids present at offer time are remembered, and the first status
 * push carrying a device outside that set, created after the offer, is the
 * pairing. Main also voids an offer on its own (five wrong guesses, a newer
 * offer from another window); that shows up as `status.pairing` going back to
 * null, which only counts once this dialog has seen it non-null — the push
 * announcing the offer is throttled and may arrive after `pairStart` resolves.
 */

// ── Bridge helpers ──────────────────────────────────────────────────────
// Shared with RemoteConsoleSettings, which imports this module and never the
// reverse, so the two components do not import each other.
//
// `window.wmux` is typed `any`, so the bridge is cast to its contract here,
// once. The runtime is loaded lazily in main and may be absent from a build:
// every answer is checked for `{error}` before use, because a Settings tab
// that throws takes the whole settings window with it.

export function remoteBridge(): RemoteConsoleBridge | undefined {
  return window.wmux?.remoteConsole as RemoteConsoleBridge | undefined;
}

export function isBridgeError(value: unknown): value is RemoteBridgeError {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

const CONFIG_ERROR_KEYS: Record<string, TranslationKey> = {
  'bad-port': 'settings.remote.configError.badPort',
  'bad-public-url': 'settings.remote.configError.badPublicUrl',
  'bad-lan-host': 'settings.remote.configError.badLanHost',
  unavailable: 'settings.remote.unavailable',
};

/** A `setConfig` or device-action error as a sentence; unknown codes still say which. */
export function remoteErrorText(t: Translator, code: string): string {
  const key = CONFIG_ERROR_KEYS[code];
  return key ? t(key) : t('settings.remote.actionFailed').replace('{error}', code);
}

// ── Dialog ──────────────────────────────────────────────────────────────

interface LiveOffer {
  url: string;
  expiresAt: number;
  scope: RemoteScope;
  offeredAt: number;
  knownIds: ReadonlySet<string>;
}

type Ended = 'expired' | 'voided' | null;

const CLOSE_AFTER_PAIRED_MS = 1500;

interface PairDeviceDialogProps {
  status: RemoteConsoleStatus;
  onClose: () => void;
}

export default function PairDeviceDialog({ status, onClose }: PairDeviceDialogProps) {
  const t = useT();
  const { config } = status;
  // Operator over plain-HTTP LAN is refused by main anyway (spec I3); greying it
  // out here, with the reason, beats a pairing that silently comes out viewer.
  const operatorAllowed = config.bind !== 'lan' || config.allowInsecureControl;
  const [name, setName] = useState(() => t('settings.remote.pair.defaultName'));
  const [scope, setScope] = useState<RemoteScope>('viewer');
  const effectiveScope: RemoteScope = operatorAllowed ? scope : 'viewer';
  const [offer, setOffer] = useState<LiveOffer | null>(null);
  const [ended, setEnded] = useState<Ended>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sawLive = useRef(false);
  const offerRef = useRef<LiveOffer | null>(null);
  offerRef.current = offer;

  // Countdown. A 1 s tick is all a seconds display needs.
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offer]);

  useEffect(() => {
    if (offer && now >= offer.expiresAt) {
      setOffer(null);
      setEnded('expired');
    }
  }, [offer, now]);

  // Watch the pushed status for the device this offer produced.
  useEffect(() => {
    if (!offer) return;
    const fresh = status.devices.find((d) => !offer.knownIds.has(d.id) && d.createdAt >= offer.offeredAt);
    if (fresh) {
      setOffer(null);
      setPairedName(fresh.name);
      return;
    }
    if (status.pairing) sawLive.current = true;
    else if (sawLive.current) {
      setOffer(null);
      setEnded('voided');
    }
  }, [status, offer]);

  useEffect(() => {
    if (pairedName === null) return;
    const timer = setTimeout(onClose, CLOSE_AFTER_PAIRED_MS);
    return () => clearTimeout(timer);
  }, [pairedName, onClose]);

  // Leaving with a live offer cancels it in main too, whichever way the dialog
  // went away — an offer outliving its dialog is a working QR nobody watches.
  useEffect(() => () => {
    if (offerRef.current) remoteBridge()?.pairCancel().catch(() => undefined);
  }, []);

  const generate = async () => {
    const bridge = remoteBridge();
    if (!bridge) { setError('unavailable'); return; }
    setBusy(true);
    setError(null);
    setEnded(null);
    sawLive.current = false;
    const knownIds = new Set(status.devices.map((d) => d.id));
    const offeredAt = Date.now();
    try {
      const r = await bridge.pairStart({ name: name.trim() || t('settings.remote.pair.defaultName'), scope: effectiveScope });
      if (isBridgeError(r)) setError(r.error);
      else {
        setNow(Date.now());
        setOffer({ url: r.url, expiresAt: r.expiresAt, scope: r.scope, offeredAt, knownIds });
      }
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (offerRef.current) {
      offerRef.current = null;
      setOffer(null);
      remoteBridge()?.pairCancel().catch(() => undefined);
    }
    onClose();
  };

  // Escape cancels wherever focus is. Generating a code unmounts the focused
  // name input, so a handler on the overlay alone would stop hearing Escape at
  // exactly the moment a live QR is on screen. Capture phase, stopped there,
  // so the settings window behind does not close on the same keystroke.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const secondsLeft = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : 0;
  const unreachable = config.bind === 'loopback' && config.publicUrl === '';

  return createPortal(
    <div className="remote-settings__modal-overlay">
      <div className="remote-settings__modal" role="dialog" aria-modal="true" aria-labelledby="remote-pair-title">
        <h3 id="remote-pair-title" className="settings-section-title">{t('settings.remote.pair.title')}</h3>

        {pairedName !== null && (
          <div className="remote-settings__paired" role="status">
            {t('settings.remote.pair.paired').replace('{name}', pairedName)}
          </div>
        )}

        {pairedName === null && !offer && (
          <PairForm
            name={name}
            setName={setName}
            scope={effectiveScope}
            setScope={setScope}
            operatorAllowed={operatorAllowed}
          />
        )}

        {offer && (
          <div className="remote-settings__offer">
            <img className="remote-settings__qr" src={qrDataUri(offer.url)} alt={t('settings.remote.pair.qrAlt')} />
            <p className="settings-hint">{t('settings.remote.pair.scan')}</p>
            <div className="remote-settings__inline">
              <input
                className="settings-input remote-settings__url"
                readOnly
                value={offer.url}
                spellCheck={false}
                onFocus={(e) => e.target.select()}
              />
              <CopyButton text={offer.url} />
            </div>
            <p className="remote-settings__countdown">
              {t('settings.remote.pair.expiresIn').replace('{seconds}', String(secondsLeft))}
              {' · '}
              {offer.scope === 'operator' ? t('settings.remote.scope.operator') : t('settings.remote.scope.viewer')}
            </p>
            <p className="settings-hint">{t('settings.remote.pair.oneUse')}</p>
          </div>
        )}

        {ended && !offer && pairedName === null && (
          <p className="remote-settings__status remote-settings__status--error">
            {ended === 'expired' ? t('settings.remote.pair.expired') : t('settings.remote.pair.voided')}
          </p>
        )}

        {unreachable && pairedName === null && (
          <div className="remote-settings__card remote-settings__card--warn">
            <p>{t('settings.remote.pair.loopbackWarn')}</p>
            <RemoteRecipes port={config.port} />
          </div>
        )}

        {error && <div className="remote-settings__error" role="alert">{remoteErrorText(t, error)}</div>}

        <div className="remote-settings__actions remote-settings__actions--end">
          {pairedName === null && !offer && (
            <button className="settings-button" disabled={busy} onClick={generate}>
              {ended ? t('settings.remote.pair.again') : t('settings.remote.pair.generate')}
            </button>
          )}
          <button className="settings-button" onClick={cancel}>
            {pairedName === null ? t('settings.remote.cancel') : t('settings.remote.pair.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface PairFormProps {
  name: string;
  setName: (name: string) => void;
  scope: RemoteScope;
  setScope: (scope: RemoteScope) => void;
  operatorAllowed: boolean;
}

function PairForm({ name, setName, scope, setScope, operatorAllowed }: PairFormProps) {
  const t = useT();
  return (
    <>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-pair-name">{t('settings.remote.pair.name')}</label>
        <input
          id="remote-pair-name"
          className="settings-input"
          value={name}
          maxLength={40}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="settings-row settings-row--column remote-settings__radios" role="radiogroup" aria-label={t('settings.remote.pair.scope')}>
        <span className="settings-label">{t('settings.remote.pair.scope')}</span>
        <label className="remote-settings__radio">
          <input type="radio" name="remote-pair-scope" checked={scope === 'viewer'} onChange={() => setScope('viewer')} />
          <span>{t('settings.remote.pair.scopeViewer')}</span>
        </label>
        <label className={`remote-settings__radio ${operatorAllowed ? '' : 'remote-settings__radio--disabled'}`}>
          <input
            type="radio"
            name="remote-pair-scope"
            checked={scope === 'operator'}
            disabled={!operatorAllowed}
            onChange={() => setScope('operator')}
          />
          <span>
            {t('settings.remote.pair.scopeOperator')}
            {!operatorAllowed && <span className="settings-hint remote-settings__sub">{t('settings.remote.pair.operatorDisabled')}</span>}
          </span>
        </label>
      </div>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="settings-button"
      onClick={() => {
        const write = window.wmux?.clipboard?.writeText as ((s: string) => Promise<unknown>) | undefined;
        write?.(text).then(() => setCopied(true), () => undefined);
      }}
    >
      {copied ? t('settings.remote.copied') : t('settings.remote.copy')}
    </button>
  );
}

const RECIPES: { key: TranslationKey; command: (port: number) => string }[] = [
  { key: 'settings.remote.recipeTailscale', command: (port) => `tailscale serve --bg --https=443 http://127.0.0.1:${port}` },
  { key: 'settings.remote.recipeSsh', command: (port) => `ssh -L ${port}:127.0.0.1:${port} <host>` },
];

/**
 * The two supported ways to reach a loopback-bound console from a phone. wmux
 * speaks plain HTTP and never terminates TLS itself; both recipes put the
 * encryption in a tool that already does it well. Funnel is named as
 * unsupported because it is the obvious next thing a Tailscale user tries, and
 * it would publish the console to the whole internet.
 */
export function RemoteRecipes({ port }: { port: number }) {
  const t = useT();
  return (
    <div className="remote-settings__recipes">
      {RECIPES.map((r) => {
        const command = r.command(port);
        return (
          <div className="remote-settings__recipe" key={r.key}>
            <span className="settings-hint">{t(r.key)}</span>
            <div className="remote-settings__inline">
              <code className="remote-settings__code">{command}</code>
              <CopyButton text={command} />
            </div>
          </div>
        );
      })}
      <p className="settings-hint">{t('settings.remote.funnelUnsupported')}</p>
    </div>
  );
}

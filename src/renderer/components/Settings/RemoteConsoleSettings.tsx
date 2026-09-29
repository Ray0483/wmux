import { useCallback, useEffect, useState } from 'react';
import type {
  RemoteConsoleBridge,
  RemoteConsoleConfig,
  RemoteConsoleStatus,
  RemoteDeviceView,
} from '../../../shared/remote-console-config';
import { useT, type Translator } from '../../i18n';
import { normalizePublicUrl } from '../../../shared/remote-console-config';
import PairDeviceDialog, { RemoteRecipes, fillTemplate, isBridgeError, remoteBridge, remoteErrorText } from './PairDeviceDialog';
import '../../styles/remote-settings.css';

/**
 * Settings → Remote (#254): the only place a Remote Console credential can be
 * minted, and the only place the listener can be turned on or rebound. There is
 * deliberately no pipe method for any of it (spec I2) — an agent in a pane holds
 * the pipe token, and "pair a device" must stay a human click.
 *
 * Everything here goes through `window.wmux.remoteConsole` and nothing else.
 * `window.wmux` is typed `any`, so the bridge is cast to its contract once, in
 * `remoteBridge()`, and every answer is checked for `{error}` before use: the
 * runtime is loaded lazily in main and may be absent from a build, and a
 * Settings tab that throws takes the whole settings window with it. An absent
 * bridge, a rejection and an `{error}` all render the same "unavailable" card.
 *
 * What this tab never shows: a device token, a token hash or a pairing secret.
 * The status type carries none of them. The one credential that reaches the
 * renderer is the pairing URL, and only PairDeviceDialog holds it, only for the
 * 120 s it is valid.
 */

/** Enough of a shape check that a malformed push cannot crash the render. */
function isStatus(value: unknown): value is RemoteConsoleStatus {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<RemoteConsoleStatus>;
  return typeof s.config === 'object' && s.config !== null
    && Array.isArray(s.devices) && Array.isArray(s.connected) && Array.isArray(s.lanAddresses);
}

function lastErrorText(t: Translator, status: RemoteConsoleStatus): string | null {
  const { config } = status;
  switch (status.lastError) {
    case 'port-busy': return fillTemplate(t('settings.remote.error.portBusy'), { port: config.port });
    case 'bind-failed': return t('settings.remote.error.bindFailed');
    case 'ui-not-built': return t('settings.remote.error.uiNotBuilt');
    case 'lan-address-gone': return fillTemplate(t('settings.remote.error.lanAddressGone'), { host: config.lanHost ?? '' });
    default: return null;
  }
}

type Apply = (patch: Partial<RemoteConsoleConfig>) => Promise<boolean>;

export default function RemoteConsoleSettings() {
  const t = useT();
  const [status, setStatus] = useState<RemoteConsoleStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    const bridge = remoteBridge();
    if (typeof bridge?.getState !== 'function') { setUnavailable(true); return; }
    let live = true;
    bridge.getState().then(
      (r) => {
        if (!live) return;
        if (isStatus(r)) setStatus(r);
        else setUnavailable(true);
      },
      () => { if (live) setUnavailable(true); },
    );
    let off: (() => void) | undefined;
    try {
      off = bridge.onState((s) => {
        if (!live || !isStatus(s)) return;
        setStatus(s);
        setUnavailable(false);
      });
    } catch {
      // No push channel: the tab still renders from getState, it just goes
      // stale until reopened. Not worth the "unavailable" card.
    }
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const apply = useCallback<Apply>(async (patch) => {
    const bridge = remoteBridge();
    if (!bridge || !status) return false;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await bridge.setConfig({ ...status.config, ...patch });
      if (isBridgeError(r)) { setSaveError(r.error); return false; }
      // The push will follow, but it is throttled; reading back now keeps the
      // control the user just touched from snapping back for a quarter second.
      const fresh = await bridge.getState();
      if (isStatus(fresh)) setStatus(fresh);
      return true;
    } catch {
      setSaveError('unavailable');
      return false;
    } finally {
      setBusy(false);
    }
  }, [status]);

  if (unavailable && !status) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t('settings.remote.title')}</h3>
        <div className="remote-settings__card remote-settings__card--muted">{t('settings.remote.unavailable')}</div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t('settings.remote.title')}</h3>
        <p className="settings-hint">{t('settings.remote.loading')}</p>
      </div>
    );
  }

  const { config } = status;
  return (
    <div className="settings-section remote-settings">
      <h3 className="settings-section-title">{t('settings.remote.title')}</h3>
      <p className="settings-hint settings-hint--lead">{t('settings.remote.hint')}</p>

      <EnableRow t={t} status={status} busy={busy} apply={apply} />
      <StatusLine t={t} status={status} busy={busy} apply={apply} />
      {saveError && <div className="remote-settings__error" role="alert">{remoteErrorText(t, saveError)}</div>}

      <div className="settings-divider" />
      <Reachability t={t} status={status} busy={busy} apply={apply} />
      <PortRow t={t} port={config.port} busy={busy} apply={apply} />
      <PublicUrlRow t={t} publicUrl={config.publicUrl} busy={busy} apply={apply} />
      <RemoteRecipes port={config.port} />

      <div className="settings-divider" />
      <div className="remote-settings__actions">
        <button className="settings-button" disabled={!status.running} onClick={() => setPairOpen(true)}>
          {t('settings.remote.pair')}
        </button>
      </div>
      {!status.running && <p className="settings-hint">{t('settings.remote.pairNeedsRunning')}</p>}

      <DevicesTable t={t} status={status} />

      {pairOpen && <PairDeviceDialog status={status} onClose={() => setPairOpen(false)} />}
    </div>
  );
}

interface RowProps {
  t: Translator;
  status: RemoteConsoleStatus;
  busy: boolean;
  apply: Apply;
}

/**
 * Off → on asks first; on → off does not. Turning the console on opens a
 * listener that paired devices can reach, which is worth one explicit "Turn
 * on"; turning it off only ever reduces what is exposed.
 */
function EnableRow({ t, status, busy, apply }: RowProps) {
  const [asking, setAsking] = useState(false);
  const enabled = status.config.enabled;
  return (
    <>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-settings-enable">{t('settings.remote.enable')}</label>
        <input
          id="remote-settings-enable"
          type="checkbox"
          className="settings-toggle"
          checked={enabled || asking}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) setAsking(true);
            else { setAsking(false); apply({ enabled: false }); }
          }}
        />
      </div>
      {asking && !enabled && (
        <div className="remote-settings__card remote-settings__card--warn">
          <strong>{t('settings.remote.enableWarnTitle')}</strong>
          <p>{t('settings.remote.enableWarnBody')}</p>
          <div className="remote-settings__actions">
            <button
              className="settings-button"
              disabled={busy}
              onClick={() => { apply({ enabled: true }).then(() => setAsking(false)); }}
            >
              {t('settings.remote.turnOn')}
            </button>
            <button className="settings-button" onClick={() => setAsking(false)}>{t('settings.remote.cancel')}</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The refused origin worth offering as the Public URL, or null. It is whatever
 * Origin header reached the listener, and on a loopback bind ANY web page open
 * in this computer's own browser can send one just by trying a WebSocket to
 * 127.0.0.1 — so it is attacker-chosen text sitting beside a one-click "trust
 * this" button. It is offered only when it is already a bare http(s) origin
 * (the same `normalizePublicUrl` main validates with, so the click cannot come
 * back as bad-public-url) and differs from what is set, and the card says in
 * words to accept it only when the user recognises it.
 */
export function suggestedPublicUrl(status: Pick<RemoteConsoleStatus, 'lastRejectedOrigin' | 'config'>): string | null {
  const raw = status.lastRejectedOrigin;
  if (!raw) return null;
  const origin = normalizePublicUrl(raw);
  if (!origin || origin !== raw) return null;
  return origin === status.config.publicUrl ? null : origin;
}

function StatusLine({ t, status, busy, apply }: RowProps) {
  const { config } = status;
  const error = config.enabled ? lastErrorText(t, status) : null;
  const connected = status.connected.reduce((n, c) => n + c.count, 0);
  let line: string;
  if (!config.enabled) line = t('settings.remote.statusOff');
  else if (error) line = error;
  else if (status.listening) {
    line = fillTemplate(t('settings.remote.statusListening'), {
      host: status.listening.host,
      port: status.listening.port,
      count: connected,
    });
  } else line = t('settings.remote.statusStarting');

  const rejected = suggestedPublicUrl(status);
  return (
    <>
      <div className={`remote-settings__status ${error ? 'remote-settings__status--error' : ''}`} role="status">
        {line}
      </div>
      {/* The most likely reason a phone gets refused is a proxy address wmux
          was never told about — `tailscale serve` hands out an https origin
          the user may not have pasted anywhere. Offer the refused origin as
          the fix rather than making them find and retype it. */}
      {rejected && (
        <div className="remote-settings__card remote-settings__card--warn">
          <p>{fillTemplate(t('settings.remote.rejectedOrigin'), { origin: rejected })}</p>
          <p className="settings-hint">{t('settings.remote.rejectedOriginCaution')}</p>
          <button className="settings-button" disabled={busy} onClick={() => { apply({ publicUrl: rejected }); }}>
            {t('settings.remote.useAsPublicUrl')}
          </button>
          <button className="settings-button" onClick={() => { remoteBridge()?.dismissRejectedOrigin().catch(() => undefined); }}>
            {t('settings.remote.dismiss')}
          </button>
        </div>
      )}
    </>
  );
}

function Reachability({ t, status, busy, apply }: RowProps) {
  const { config, lanAddresses } = status;
  const lanHost = config.lanHost;
  // A saved interface that has since gone (Wi-Fi off, VPN down) stays in the
  // list, marked, rather than vanishing: a dropdown silently showing another
  // address would read as though wmux had rebound on its own.
  const options = lanHost && !lanAddresses.includes(lanHost) ? [...lanAddresses, lanHost] : lanAddresses;
  const firstLan = lanHost ?? lanAddresses[0] ?? null;

  return (
    <>
      <div className="settings-row settings-row--column remote-settings__radios" role="radiogroup" aria-label={t('settings.remote.reachability')}>
        <span className="settings-label">{t('settings.remote.reachability')}</span>
        <label className="remote-settings__radio">
          <input
            type="radio"
            name="remote-settings-bind"
            checked={config.bind === 'loopback'}
            disabled={busy}
            onChange={() => { apply({ bind: 'loopback', lanHost: null, allowInsecureControl: false }); }}
          />
          <span>
            {t('settings.remote.bindLoopback')}
            <span className="settings-hint remote-settings__sub">{t('settings.remote.bindLoopbackHint')}</span>
          </span>
        </label>
        <label className="remote-settings__radio">
          <input
            type="radio"
            name="remote-settings-bind"
            checked={config.bind === 'lan'}
            disabled={busy || firstLan === null}
            onChange={() => { if (firstLan) apply({ bind: 'lan', lanHost: firstLan }); }}
          />
          <span>
            {t('settings.remote.bindLan')}
            {firstLan === null && <span className="settings-hint remote-settings__sub">{t('settings.remote.noLanAddress')}</span>}
          </span>
        </label>
      </div>

      {config.bind === 'lan' && (
        <>
          <div className="settings-row">
            <label className="settings-label" htmlFor="remote-settings-lan">{t('settings.remote.interface')}</label>
            <select
              id="remote-settings-lan"
              className="settings-select"
              value={lanHost ?? ''}
              disabled={busy}
              onChange={(e) => { apply({ lanHost: e.target.value }); }}
            >
              {options.map((addr) => (
                <option key={addr} value={addr}>
                  {lanAddresses.includes(addr) ? addr : fillTemplate(t('settings.remote.addressGone'), { host: addr })}
                </option>
              ))}
            </select>
          </div>
          <div className="remote-settings__card remote-settings__card--danger">{t('settings.remote.lanNotice')}</div>
          <InsecureControl t={t} status={status} busy={busy} apply={apply} />
        </>
      )}
    </>
  );
}

/**
 * Operator scope over plain HTTP (spec I3). Two deliberate steps, both inline
 * — `confirm()` is a native modal that blocks main's event loop for every
 * window and cannot be themed or translated. Turning it OFF is one click: that
 * direction only ever takes access away.
 */
function InsecureControl({ t, status, busy, apply }: RowProps) {
  const [step, setStep] = useState<'idle' | 'ack' | 'confirm'>('idle');
  const [acknowledged, setAcknowledged] = useState(false);
  const on = status.config.allowInsecureControl;
  const reset = () => { setStep('idle'); setAcknowledged(false); };

  return (
    <>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-settings-insecure">{t('settings.remote.allowControl')}</label>
        <input
          id="remote-settings-insecure"
          type="checkbox"
          className="settings-toggle"
          checked={on || step !== 'idle'}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) setStep('ack');
            else { reset(); apply({ allowInsecureControl: false }); }
          }}
        />
      </div>
      {!on && step === 'ack' && (
        <div className="remote-settings__card remote-settings__card--danger">
          <label className="remote-settings__radio">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{t('settings.remote.allowControlAck')}</span>
          </label>
          <div className="remote-settings__actions">
            <button className="settings-button" disabled={!acknowledged} onClick={() => setStep('confirm')}>
              {t('settings.remote.allowControlContinue')}
            </button>
            <button className="settings-button" onClick={reset}>{t('settings.remote.cancel')}</button>
          </div>
        </div>
      )}
      {!on && step === 'confirm' && (
        <div className="remote-settings__card remote-settings__card--danger">
          <strong>{t('settings.remote.allowControlConfirm')}</strong>
          <div className="remote-settings__actions">
            <button
              className="settings-button settings-button--danger"
              disabled={busy}
              onClick={() => { apply({ allowInsecureControl: true }).then(reset); }}
            >
              {t('settings.remote.allowControlYes')}
            </button>
            <button className="settings-button" onClick={reset}>{t('settings.remote.cancel')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function PortRow({ t, port, busy, apply }: { t: Translator; port: number; busy: boolean; apply: Apply }) {
  const [draft, setDraft] = useState(String(port));
  useEffect(() => { setDraft(String(port)); }, [port]);
  const dirty = draft.trim() !== String(port);
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor="remote-settings-port">{t('settings.remote.port')}</label>
      <div className="remote-settings__inline">
        <input
          id="remote-settings-port"
          className="settings-input settings-input--narrow"
          type="number"
          min={1024}
          max={65535}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {/* Sent as typed: a non-integer reaches main as NaN or a fraction and
            comes back as bad-port, so there is one validator, not two. */}
        <button className="settings-button" disabled={busy || !dirty} onClick={() => { apply({ port: Number(draft.trim()) }); }}>
          {t('settings.remote.apply')}
        </button>
      </div>
    </div>
  );
}

function PublicUrlRow({ t, publicUrl, busy, apply }: { t: Translator; publicUrl: string; busy: boolean; apply: Apply }) {
  const [draft, setDraft] = useState(publicUrl);
  useEffect(() => { setDraft(publicUrl); }, [publicUrl]);
  return (
    <>
      <div className="settings-row">
        <label className="settings-label" htmlFor="remote-settings-public">{t('settings.remote.publicUrl')}</label>
        <div className="remote-settings__inline">
          <input
            id="remote-settings-public"
            className="settings-input"
            type="url"
            spellCheck={false}
            placeholder={t('settings.remote.publicUrlPlaceholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="settings-button" disabled={busy || draft.trim() === publicUrl} onClick={() => { apply({ publicUrl: draft.trim() }); }}>
            {t('settings.remote.save')}
          </button>
        </div>
      </div>
      <p className="settings-hint">{t('settings.remote.publicUrlHint')}</p>
    </>
  );
}

function formatDate(ms: number, withTime: boolean): string {
  if (!ms) return '';
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '';
  return withTime ? at.toLocaleString() : at.toLocaleDateString();
}

function DevicesTable({ t, status }: { t: Translator; status: RemoteConsoleStatus }) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = status.devices;

  const run = async (action: (b: RemoteConsoleBridge) => Promise<unknown>) => {
    const bridge = remoteBridge();
    if (!bridge) { setError('unavailable'); return false; }
    setError(null);
    try {
      const r = await action(bridge);
      if (isBridgeError(r)) { setError(r.error); return false; }
      return true;
    } catch {
      setError('unavailable');
      return false;
    }
  };

  const saveName = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (name === '') return;
    if (await run((b) => b.rename(editing.id, name))) setEditing(null);
  };

  const connectedOf = (d: RemoteDeviceView) => status.connected.find((c) => c.deviceId === d.id)?.count ?? 0;

  return (
    <>
      <h4 className="remote-settings__subtitle">{t('settings.remote.devices')}</h4>
      {devices.length === 0 && <p className="settings-hint">{t('settings.remote.noDevices')}</p>}
      {devices.length > 0 && (
        <div className="remote-settings__table-wrap">
          <table className="remote-settings__table">
            <thead>
              <tr>
                <th>{t('settings.remote.col.name')}</th>
                <th>{t('settings.remote.col.scope')}</th>
                <th>{t('settings.remote.col.paired')}</th>
                <th>{t('settings.remote.col.lastSeen')}</th>
                <th>{t('settings.remote.col.connected')}</th>
                <th aria-label={t('settings.remote.col.actions')} />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    {editing?.id === d.id ? (
                      <input
                        className="settings-input remote-settings__name-input"
                        value={editing.name}
                        maxLength={40}
                        autoFocus
                        onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveName();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : d.name}
                  </td>
                  <td>{d.scope === 'operator' ? t('settings.remote.scope.operator') : t('settings.remote.scope.viewer')}</td>
                  <td>{formatDate(d.createdAt, false)}</td>
                  <td>{formatDate(d.lastSeenAt, true) || t('settings.remote.never')}</td>
                  <td>{connectedOf(d) || '—'}</td>
                  <td className="remote-settings__row-actions">
                    {editing?.id === d.id ? (
                      <>
                        <button className="settings-button" onClick={() => { saveName(); }}>{t('settings.remote.save')}</button>
                        <button className="settings-button" onClick={() => setEditing(null)}>{t('settings.remote.cancel')}</button>
                      </>
                    ) : (
                      <>
                        <button className="settings-button" onClick={() => setEditing({ id: d.id, name: d.name })}>{t('settings.remote.rename')}</button>
                        <button className="settings-button settings-button--danger" onClick={() => { run((b) => b.revoke(d.id)); }}>
                          {t('settings.remote.revoke')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {devices.length > 0 && !confirmAll && (
        <div className="remote-settings__actions">
          <button className="settings-button settings-button--danger" onClick={() => setConfirmAll(true)}>
            {t('settings.remote.revokeAll')}
          </button>
        </div>
      )}
      {devices.length > 0 && confirmAll && (
        <div className="remote-settings__card remote-settings__card--danger">
          <p>{fillTemplate(t('settings.remote.revokeAllConfirm'), { count: devices.length })}</p>
          <div className="remote-settings__actions">
            <button
              className="settings-button settings-button--danger"
              onClick={() => { run((b) => b.revokeAll()).then(() => setConfirmAll(false)); }}
            >
              {t('settings.remote.revokeAllYes')}
            </button>
            <button className="settings-button" onClick={() => setConfirmAll(false)}>{t('settings.remote.cancel')}</button>
          </div>
        </div>
      )}
      {error && <div className="remote-settings__error" role="alert">{remoteErrorText(t, error)}</div>}
    </>
  );
}

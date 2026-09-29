/**
 * Phone console strings — English, the SOURCE dictionary (#254).
 *
 * Every other file in this folder must have exactly these keys (the parity
 * test enforces it). Plural keys end in a CLDR category (`_one`, `_other`, …):
 * English needs `_one` and `_other`, and each language carries exactly the
 * categories `Intl.PluralRules` selects for it — Russian has four, Japanese one.
 *
 * `{name}` placeholders are filled by `format()`; everything is rendered as
 * TEXT, never as HTML.
 */
export const en = {
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.reload': 'Reload',
  'common.retry': 'Retry',
  'common.settings': 'Settings',

  'loading': 'Connecting…',

  'pair.title': 'Pair this device',
  'pair.body': 'Your computer offered to pair this browser with its wmux Remote Console. Only continue if you just scanned this code yourself.',
  'pair.nameLabel': 'Device name',
  'pair.defaultName': 'Phone',
  'pair.confirm': 'Pair',
  'pair.pairing': 'Pairing…',
  'pair.failed': 'Pairing failed. Make a new code on your computer and try again.',

  'expired.title': 'Code expired',
  'expired.body': 'This code expired — make a new one on your computer.',
  'unpaired.title': 'Not paired',
  'unpaired.body': 'This browser is not paired with wmux. On your computer, open Settings → Remote → Pair a device, then scan the code.',
  'revoked.title': 'Access removed',
  'revoked.body': 'This device was removed from wmux on your computer. Pair it again to reconnect.',
  'incompatible.title': 'Update needed',
  'incompatible.body': 'This page is out of date for the wmux on your computer. Reload to get the current version.',
  'unreachable.title': 'Can’t reach wmux',
  'unreachable.body': 'The Remote Console did not answer. Check that wmux is running and the console is turned on.',

  'conn.ready': 'Connected',
  'conn.connecting': 'Connecting…',
  'conn.waiting': 'Reconnecting…',
  'conn.offline': 'Offline',

  'console.needsYou': 'Needs you',
  'console.done': 'Done',
  'console.working': 'Working',
  'console.idle': 'Idle',
  'console.other': 'Other',
  'console.markAllSeen': 'Mark all seen',
  'console.empty': 'No agents are running right now.',
  'console.viewerNotice': 'View only — this connection cannot type or answer.',
  'console.needsYouCount_one': '{n} agent needs you',
  'console.needsYouCount_other': '{n} agents need you',

  'card.openToAnswer': 'Needs you — open to answer',
  'card.answerPending': 'Sent — waiting for the agent',

  'attach.fit': 'Fit width',
  'attach.pan': 'Readable',
  'attach.jumpBottom': 'Jump to bottom',
  'attach.altHint': 'Full-screen app: use PgUp / PgDn to scroll it.',
  'attach.loading': 'Loading screen…',
  'attach.exited': 'Process exited ({code})',
  'attach.lag': 'Catching up…',
  'attach.errNoTerminal': 'This terminal is not open in a wmux window.',
  'attach.errTimeout': 'The computer did not answer in time.',
  'attach.errGone': 'This terminal has closed.',

  'keys.more': 'More keys',
  'keys.armed': 'Tap again to send',

  'composer.placeholder': 'Message the agent…',
  'composer.send': 'Send ↵',
  'composer.insert': 'Insert',
  'composer.sending': 'Sending…',

  'confirm.blocked.title': 'The agent is waiting for an answer',
  'confirm.blocked.body': 'Your text will be typed without pressing Enter, so it cannot answer the question by accident.',
  'confirm.blocked.ok': 'Insert',
  'confirm.multiline.title': 'Send several lines?',
  'confirm.multiline.body': 'This terminal is not in paste mode, so each line may be submitted on its own.',
  'confirm.multiline.ok': 'Send anyway',
  'confirm.interrupt.title': 'Interrupt the agent?',
  'confirm.interrupt.body': 'This stops what the agent is doing.',
  'confirm.interrupt.ok': 'Interrupt',
  'link.title': 'Open this link?',
  'link.ok': 'Open',

  'ack.forbidden': 'Not allowed from this device.',
  'ack.rate': 'Too fast — wait a moment.',
  'ack.gone': 'The terminal has closed.',
  'ack.notBlocked': 'The question was already answered.',
  'ack.noChoices': 'There is nothing to answer.',
  'ack.unknownChoice': 'That choice is no longer offered.',
  'ack.tooLong': 'Too long to send ({max} characters at most).',
  'ack.badKey': 'That key is not supported.',
  'ack.writeFailed': 'Could not send.',
  'ack.unconfirmed': 'Not confirmed. Check the terminal before sending again.',

  'toast.blocked': '{label} needs you',
  'toast.done': '{label} is done',

  'prefs.connectedTo': 'Connected to {host}',
  'prefs.device': 'This device: {name}',
  'prefs.scopeOperator': 'Can type and answer',
  'prefs.scopeViewer': 'View only',
  'prefs.language': 'Language',
  'prefs.languageAuto': 'Automatic',
  'prefs.theme': 'Theme',
  'prefs.themeSystem': 'System',
  'prefs.themeLight': 'Light',
  'prefs.themeDark': 'Dark',
  'prefs.fontScale': 'Text size',
  'prefs.alerts': 'Alerts',
  'prefs.enableAlerts': 'Enable alerts',
  'prefs.alertsOn': 'Alerts are on.',
  'prefs.alertsDenied': 'Alerts are blocked in this browser’s settings.',
  'prefs.alertsUnavailable': 'System alerts need an HTTPS address. In-page alerts still work.',
  'prefs.forget': 'Forget this device',
  'prefs.forgetTitle': 'Forget this device?',
  'prefs.forgetBody': 'You will need a new code from your computer to reconnect.',
  'prefs.limits': 'With this page closed nothing arrives, and iOS cannot vibrate.',
} as const;

export type RemoteMessageKey = keyof typeof en;

/**
 * The page a phone gets for an address wmux does not recognise (#254) — most
 * often a Tailscale URL not yet saved as the Public URL, so it is the FIRST
 * thing a new user's phone shows. It names desktop menus, so it names them the
 * way the desktop does in that language: a French user told to open
 * "Settings → Remote" is looking for menus that say "Paramètres → Distant".
 *
 * Static on purpose: the language is CHOSEN from Accept-Language against this
 * closed table and nothing from the request is ever echoed into the page.
 * Menu names are the desktop's own `settings.title`, `settings.tab.remote` and
 * `settings.remote.useAsPublicUrl` strings (src/renderer/i18n/locales).
 */

export const REFUSED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  en: 'wmux refused this address. On your computer, open Settings → Remote and choose “Use as Public URL” if you recognise it.',
  fr: 'wmux a refusé cette adresse. Sur votre ordinateur, ouvrez Paramètres → Distant et choisissez « Utiliser comme URL publique » si vous la reconnaissez.',
  de: 'wmux hat diese Adresse abgelehnt. Öffnen Sie auf Ihrem Computer Einstellungen → Fernzugriff und wählen Sie „Als öffentliche URL verwenden“, wenn Sie die Adresse kennen.',
  es: 'wmux rechazó esta dirección. En tu ordenador, abre Ajustes → Remoto y elige «Usar como URL pública» si la reconoces.',
  it: 'wmux ha rifiutato questo indirizzo. Sul computer, apri Impostazioni → Remoto e scegli «Usa come URL pubblico» se lo riconosci.',
  pt: 'O wmux recusou este endereço. No seu computador, abra Configurações → Remoto e escolha “Usar como URL pública” se reconhecer o endereço.',
  nl: 'wmux heeft dit adres geweigerd. Open op je computer Instellingen → Op afstand en kies ‘Gebruiken als openbare URL’ als je het herkent.',
  sv: 'wmux nekade den här adressen. Öppna Inställningar → Fjärr på datorn och välj ”Använd som offentlig URL” om du känner igen den.',
  pl: 'wmux odrzucił ten adres. Na komputerze otwórz Ustawienia → Zdalnie i wybierz „Użyj jako publicznego URL”, jeśli go rozpoznajesz.',
  cs: 'wmux tuto adresu odmítl. V počítači otevřete Nastavení → Vzdálený přístup, a pokud adresu poznáváte, zvolte „Použít jako veřejnou URL“.',
  ru: 'wmux отклонил этот адрес. На компьютере откройте Настройки → Удалённо и выберите «Использовать как публичный URL», если узнаёте его.',
  uk: 'wmux відхилив цю адресу. На комп’ютері відкрийте Параметри → Віддалено й виберіть «Використати як публічний URL», якщо впізнаєте її.',
  tr: 'wmux bu adresi reddetti. Bilgisayarınızda Ayarlar → Uzaktan bölümünü açın ve adresi tanıyorsanız “Genel URL olarak kullan” seçeneğini seçin.',
  hi: 'wmux ने यह पता अस्वीकार कर दिया। अपने कंप्यूटर पर सेटिंग्स → रिमोट खोलें और अगर आप इसे पहचानते हैं तो “सार्वजनिक URL के रूप में उपयोग करें” चुनें।',
  ja: 'wmux はこのアドレスを拒否しました。心当たりがある場合は、コンピューターで 設定 → リモート を開き、「公開 URL として使う」を選んでください。',
  ko: 'wmux가 이 주소를 거부했습니다. 알고 있는 주소라면 컴퓨터에서 설정 → 원격을 열고 ‘공개 URL로 사용’을 선택하세요.',
  zh: 'wmux 拒绝了此地址。如果你认识它，请在电脑上打开 设置 → 远程，然后选择“用作公开 URL”。',
  'zh-TW': 'wmux 拒絕了此位址。如果你認得它，請在電腦上開啟 設定 → 遠端，然後選擇「用作公開 URL」。',
});

/** One Accept-Language tag → a table key, or null. */
function tableKey(tag: string): string | null {
  const lower = tag.trim().toLowerCase();
  if (lower === '') return null;
  // Traditional Chinese by region or by script.
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW';
  const primary = lower.split('-')[0];
  return primary in REFUSED_TEXT ? primary : null;
}

/** The best table language for an Accept-Language header, by q-value; English when none matches. */
export function refusedPageLang(acceptLanguage: string | undefined): string {
  if (!acceptLanguage) return 'en';
  const ranked = acceptLanguage.split(',').slice(0, 20).map((part, i) => {
    const [tag, ...params] = part.split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { tag, weight: Number.isFinite(weight) ? weight : 0, i };
  }).filter((e) => e.weight > 0).sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const e of ranked) {
    const key = tableKey(e.tag);
    if (key) return key;
  }
  return 'en';
}

export function refusedPage(acceptLanguage: string | undefined): string {
  const lang = refusedPageLang(acceptLanguage);
  return '<!doctype html><html lang="' + lang + '"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>wmux</title><p style="font:16px system-ui,sans-serif;margin:24px">'
    + REFUSED_TEXT[lang] + '</p></html>';
}

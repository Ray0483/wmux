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
 * `settings.remote.useAsPublicUrl` and `settings.remote.publicUrl` strings
 * (src/renderer/i18n/locales).
 *
 * The advice is conditional on purpose. The one-click card exists only for an
 * https `*.ts.net` name reached through a loopback proxy (guards.ts
 * offersAsPublicUrl), and a LAN bind hides the Public URL row altogether — so
 * a page promising that button sent everyone else looking for one that was
 * never there. The last sentence is the way out that always works: the
 * address the pairing QR code itself points at.
 */

export const REFUSED_TEXT: Readonly<Record<string, string>> = Object.freeze({
  en: 'wmux refused this address. If you recognise it, open Settings → Remote on your computer and choose “Use as Public URL” if it is offered for this address, or type it into Public URL. Otherwise, open the exact address the pairing QR code leads to.',
  fr: 'wmux a refusé cette adresse. Si vous la reconnaissez, ouvrez Paramètres → Distant sur votre ordinateur et choisissez « Utiliser comme URL publique » si c’est proposé pour cette adresse, ou saisissez-la dans URL publique. Sinon, ouvrez l’adresse exacte vers laquelle mène le QR code d’association.',
  de: 'wmux hat diese Adresse abgelehnt. Wenn Sie sie kennen, öffnen Sie auf Ihrem Computer Einstellungen → Fernzugriff und wählen Sie „Als öffentliche URL verwenden“, falls es für diese Adresse angeboten wird, oder tragen Sie sie unter Öffentliche URL ein. Andernfalls öffnen Sie genau die Adresse, zu der der Kopplungs-QR-Code führt.',
  es: 'wmux rechazó esta dirección. Si la reconoces, abre Ajustes → Remoto en tu ordenador y elige «Usar como URL pública» si se ofrece para esta dirección, o escríbela en URL pública. Si no, abre exactamente la dirección a la que lleva el código QR de vinculación.',
  it: 'wmux ha rifiutato questo indirizzo. Se lo riconosci, sul computer apri Impostazioni → Remoto e scegli «Usa come URL pubblico» se viene proposto per questo indirizzo, oppure inseriscilo in URL pubblico. Altrimenti apri esattamente l’indirizzo a cui porta il codice QR di associazione.',
  pt: 'O wmux recusou este endereço. Se você o reconhece, abra Configurações → Remoto no computador e escolha “Usar como URL pública” se essa opção aparecer para este endereço, ou digite-o em URL pública. Caso contrário, abra exatamente o endereço para o qual o código QR de pareamento leva.',
  nl: 'wmux heeft dit adres geweigerd. Herken je het, open dan op je computer Instellingen → Op afstand en kies ‘Gebruiken als openbare URL’ als dat voor dit adres wordt aangeboden, of vul het in bij Openbare URL. Open anders precies het adres waar de koppel-QR-code naartoe leidt.',
  sv: 'wmux nekade den här adressen. Om du känner igen den, öppna Inställningar → Fjärr på datorn och välj ”Använd som offentlig URL” om det erbjuds för adressen, eller skriv in den under Offentlig URL. Öppna annars exakt den adress som QR-koden för parkoppling leder till.',
  pl: 'wmux odrzucił ten adres. Jeśli go rozpoznajesz, otwórz na komputerze Ustawienia → Zdalnie i wybierz „Użyj jako publicznego URL”, jeśli jest dostępne dla tego adresu, albo wpisz go w polu Publiczny URL. W przeciwnym razie otwórz dokładnie adres, do którego prowadzi kod QR parowania.',
  cs: 'wmux tuto adresu odmítl. Pokud ji poznáváte, otevřete v počítači Nastavení → Vzdálený přístup a zvolte „Použít jako veřejnou URL“, pokud je pro tuto adresu nabídnuto, nebo ji zadejte do pole Veřejná URL. Jinak otevřete přesně tu adresu, na kterou vede párovací QR kód.',
  ru: 'wmux отклонил этот адрес. Если вы его узнаёте, откройте на компьютере Настройки → Удалённо и выберите «Использовать как публичный URL», если это предложено для этого адреса, или введите его в поле Публичный URL. Иначе откройте именно тот адрес, на который ведёт QR-код сопряжения.',
  uk: 'wmux відхилив цю адресу. Якщо ви її впізнаєте, відкрийте на комп’ютері Параметри → Віддалено й виберіть «Використати як публічний URL», якщо це запропоновано для цієї адреси, або введіть її в поле Публічний URL. Інакше відкрийте саме ту адресу, на яку веде QR-код спарювання.',
  tr: 'wmux bu adresi reddetti. Adresi tanıyorsanız bilgisayarınızda Ayarlar → Uzaktan bölümünü açın ve bu adres için sunuluyorsa “Genel URL olarak kullan” seçeneğini seçin ya da adresi Genel URL alanına yazın. Aksi halde eşleştirme QR kodunun götürdüğü adresin tam olarak aynısını açın.',
  hi: 'wmux ने यह पता अस्वीकार कर दिया। अगर आप इसे पहचानते हैं, तो अपने कंप्यूटर पर सेटिंग्स → रिमोट खोलें और अगर इस पते के लिए “सार्वजनिक URL के रूप में उपयोग करें” दिखे तो उसे चुनें, या इसे सार्वजनिक URL में लिखें। नहीं तो ठीक वही पता खोलें जिस पर पेयरिंग QR कोड ले जाता है।',
  ja: 'wmux はこのアドレスを拒否しました。心当たりがある場合は、コンピューターで 設定 → リモート を開き、このアドレスに「公開 URL として使う」が表示されていればそれを選ぶか、公開 URL に入力してください。それ以外の場合は、ペアリング用 QR コードが示すアドレスをそのまま開いてください。',
  ko: 'wmux가 이 주소를 거부했습니다. 알고 있는 주소라면 컴퓨터에서 설정 → 원격을 열고, 이 주소에 ‘공개 URL로 사용’이 표시되면 선택하거나 공개 URL에 직접 입력하세요. 그렇지 않으면 페어링 QR 코드가 안내하는 주소를 그대로 여세요.',
  zh: 'wmux 拒绝了此地址。如果你认识它，请在电脑上打开 设置 → 远程：如果其中为此地址提供了“用作公开 URL”，请选择它，或将地址填入 公开 URL。否则，请打开配对二维码指向的那个确切地址。',
  'zh-TW': 'wmux 拒絕了此位址。如果你認得它，請在電腦上開啟 設定 → 遠端：如果其中為此位址提供了「用作公開 URL」，請選擇它，或將位址填入 公開 URL。否則，請開啟配對 QR 碼指向的那個確切位址。',
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

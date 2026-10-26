// РџСЂРѕРІРµСЂРєР° РїСЂРёРєСЂРµРїР»РµРЅРёСЏ С„Р°Р№Р»РѕРІ РІ РєРѕРјРїРѕР·РµСЂРµ: В«РЎС„РѕС‚РѕРіСЂР°С„РёСЂРѕРІР°С‚СЊВ», В«Р¤РѕС‚Рѕ РёР·
// РіР°Р»РµСЂРµРёВ» Рё В«Р¤Р°Р№Р»В» вЂ” С‚СЂРё РѕС‚РґРµР»СЊРЅС‹Рµ РєРЅРѕРїРєРё РІ РЅРёР¶РЅРµРј СЂСЏРґСѓ, С‚Р°Рј Р¶Рµ, РіРґРµ
// РѕСЂС„РѕРіСЂР°С„РёСЏ, РјРёРєСЂРѕС„РѕРЅ Рё РѕС‚РїСЂР°РІРєР°. РњРµРЅСЋ В«пј‹В» Р±РѕР»СЊС€Рµ РЅРµС‚, РєР°Р¶РґР°СЏ РєРЅРѕРїРєР° СЃСЂР°Р·Сѓ
// РѕС‚РєСЂС‹РІР°РµС‚ СЃРІРѕР№ РІС‹Р±РѕСЂ С„Р°Р№Р»Р°.
//
// Р—Р°РїСѓСЃРє (РЅСѓР¶РµРЅ СѓР¶Рµ СЂР°Р±РѕС‚Р°СЋС‰РёР№ СЃРµСЂРІРµСЂ СЃ Р°РґРјРёРЅРѕРј РёР· DSHOW_ADMIN_PASSWORD):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/ui-attach.mjs
import { chromium } from 'playwright';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' вЂ” ' + detail : ''}`);
  if (!pass) failed++;
};

const describe = (input) => ({
  accept: input.getAttribute('accept') || '',
  capture: input.getAttribute('capture') || '',
  multiple: input.multiple,
});

/* РџР°СЂР°РјРµС‚СЂС‹ РІС‹Р±РѕСЂР° С‡РёС‚Р°РµРј РІ СЃР°РјРѕР№ СЃС‚СЂР°РЅРёС†Рµ: Сѓ <input type=file> РѕРЅРё Р¶РёРІСѓС‚ РІ
   Р°С‚СЂРёР±СѓС‚Р°С…, Р° РЅРµ РІ РѕР±СЉРµРєС‚Рµ, РєРѕС‚РѕСЂС‹Р№ РІРµСЂРЅС‘С‚ РІС‹Р±РѕСЂ С„Р°Р№Р»Р°. */
const readInput = async (chooser) => (await (await chooser).element()).evaluate(describe);

const browser = await chromium.launch();
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const login = await phone.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!login.ok()) throw new Error(`РІС…РѕРґ РЅРµ СѓРґР°Р»СЃСЏ: ${login.status()}`);
  const page = await phone.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#fileBtn');
  ok('РЅР° С‚РµР»РµС„РѕРЅРµ С‚СЂРё РєРЅРѕРїРєРё РїСЂРёРєСЂРµРїР»РµРЅРёСЏ РµСЃС‚СЊ',
    (await page.isVisible('#photoBtn')) && (await page.isVisible('#galleryBtn')) && (await page.isVisible('#fileBtn')));
  ok('РєРЅРѕРїРєРё В«пј‹В» Р±РѕР»СЊС€Рµ РЅРµС‚', (await page.locator('#attachBtn').count()) === 0);

  const row = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    return {
      photo: box('photoBtn').top,
      gallery: box('galleryBtn').top,
      file: box('fileBtn').top,
      spell: box('spellBtn').top,
      mic: box('micBtn').top,
      send: box('sendBtn').top,
    };
  });
  const tops = Object.values(row).map((value) => Math.round(value));
  ok('РІСЃРµ С‚СЂРё РєРЅРѕРїРєРё РІ РѕРґРЅРѕРј СЂСЏРґСѓ СЃ РѕСЂС„РѕРіСЂР°С„РёРµР№, РјРёРєСЂРѕС„РѕРЅРѕРј Рё РѕС‚РїСЂР°РІРєРѕР№',
    Math.max(...tops) - Math.min(...tops) < 2, tops.join(' / '));

  /* РљР°РјРµСЂР°: Chrome РІ headless РЅРµ С„РѕС‚РѕРіСЂР°С„РёСЂСѓРµС‚, РЅРѕ РѕР±СЏР·Р°РЅ РїРѕРєР°Р·Р°С‚СЊ РІС‹Р±РѕСЂ Рё
     РїРѕРјРµС‚РёС‚СЊ СЃРµР±СЏ РєР°Рє СЃСЉС‘РјРєСѓ вЂ” РёРЅР°С‡Рµ iPhone РѕС‚РєСЂРѕРµС‚ РіР°Р»РµСЂРµСЋ РІРјРµСЃС‚Рѕ РєР°РјРµСЂС‹. */
  const cameraChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#photoBtn');
  const cameraInput = await readInput(cameraChooser);
  ok('В«РЎС„РѕС‚РѕРіСЂР°С„РёСЂРѕРІР°С‚СЊВ» Р·РѕРІС‘С‚ РєР°РјРµСЂСѓ РЅР° С„РѕС‚Рѕ',
    cameraInput.accept === 'image/*' && cameraInput.capture === 'environment' && !cameraInput.multiple,
    JSON.stringify(cameraInput));

  const galleryChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#galleryBtn');
  const galleryInput = await readInput(galleryChooser);
  ok('В«Р¤РѕС‚Рѕ РёР· РіР°Р»РµСЂРµРёВ» Р±РµСЂС‘С‚ С‚РѕР»СЊРєРѕ СЃРЅРёРјРєРё Рё Р±РµР· РєР°РјРµСЂС‹',
    galleryInput.accept === 'image/*' && !galleryInput.capture, JSON.stringify(galleryInput));

  const fileChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#fileBtn');
  const fileInput = await readInput(fileChooser);
  ok('В«Р¤Р°Р№Р»В» СЂР°Р·СЂРµС€Р°РµС‚ Р»СЋР±С‹Рµ С„Р°Р№Р»С‹ Рё РЅРµСЃРєРѕР»СЊРєРѕ СЃСЂР°Р·Сѓ',
    fileInput.accept === '' && !fileInput.capture && fileInput.multiple, JSON.stringify(fileInput));

  ok('РЅРёРєР°РєРѕРіРѕ РјРµРЅСЋ РЅР° СЌРєСЂР°РЅРµ РЅРµ РїРѕСЏРІР»СЏРµС‚СЃСЏ', !(await page.isVisible('.attach-menu')));
  await phone.close();

  /* РљРѕРјРїСЊСЋС‚РµСЂ: С‚Рµ Р¶Рµ С‚СЂРё РєРЅРѕРїРєРё, Р±РµР· РєР°РјРµСЂС‹ вЂ” РѕРЅР° РЅСѓР¶РЅР° С‚РѕР»СЊРєРѕ С‚РµР»РµС„РѕРЅСѓ, РЅРѕ
     РЅР°Р¶Р°С‚РёРµ РІСЃС‘ СЂР°РІРЅРѕ РѕС‚РєСЂС‹РІР°РµС‚ РІС‹Р±РѕСЂ С„Р°Р№Р»РѕРІ СЃ РїРѕРґС…РѕРґСЏС‰РёРј accept. */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskLogin = await desktop.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!deskLogin.ok()) throw new Error(`РІС…РѕРґ РЅР° РєРѕРјРїСЊСЋС‚РµСЂРµ РЅРµ СѓРґР°Р»СЃСЏ: ${deskLogin.status()}`);
  const deskPage = await desktop.newPage();
  await deskPage.goto(BASE, { waitUntil: 'load' });
  await deskPage.waitForSelector('#fileBtn');
  ok('РЅР° РєРѕРјРїСЊСЋС‚РµСЂРµ С‚СЂРё РєРЅРѕРїРєРё РїСЂРёРєСЂРµРїР»РµРЅРёСЏ С‚РѕР¶Рµ РЅР° РјРµСЃС‚Рµ',
    (await deskPage.isVisible('#photoBtn')) && (await deskPage.isVisible('#galleryBtn')) && (await deskPage.isVisible('#fileBtn')));
  ok('РєРЅРѕРїРєР° В«Р Р°СЃСЃСѓР¶РґРµРЅРёСЏВ» РЅР° РєРѕРјРїСЊСЋС‚РµСЂРµ СЃРєСЂС‹С‚Р°', !(await deskPage.isVisible('#thinkToggle')));
  const deskChooser = deskPage.waitForEvent('filechooser', { timeout: 5000 });
  await deskPage.click('#fileBtn');
  const deskInput = await readInput(deskChooser);
  ok('РЅР° РєРѕРјРїСЊСЋС‚РµСЂРµ В«Р¤Р°Р№Р»В» СЃСЂР°Р·Сѓ РѕС‚РєСЂС‹РІР°РµС‚ РІС‹Р±РѕСЂ С„Р°Р№Р»РѕРІ',
    deskInput.accept === '' && deskInput.multiple, JSON.stringify(deskInput));
  ok('РЅР° РєРѕРјРїСЊСЋС‚РµСЂРµ РјРµРЅСЋ РЅРµ РїРѕСЏРІР»СЏРµС‚СЃСЏ', !(await deskPage.isVisible('.attach-menu')));
  await desktop.close();
} finally {
  await browser.close();
}

console.log(failed ? `РџСЂРѕРІР°Р»РѕРІ: ${failed}` : 'Р’РЎРЃ РџР РћРЁР›Рћ');
process.exit(failed ? 1 : 0);

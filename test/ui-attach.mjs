// Проверка прикрепления файлов в композере: «Сфотографировать», «Фото из
// галереи» и «Файл» — отдельные кнопки в нижнем ряду, там же, где орфография и
// кнопка действия (на телефоне это одна кнопка: микрофон, пока поле пустое, и
// отправка, как только появился текст). Меню «＋» больше нет.
//
// На телефоне «Сфотографировать» открывает системную камеру выбором файла с
// capture. На компьютере признак capture ничего не значит, поэтому там кнопка
// включает камеру ноутбука в окне: живой кадр, фото или видео со звуком.
// Камера в проверке подменена виртуальной, иначе снимать было бы нечем.
//
// Запуск (нужен уже работающий сервер с админом из DSHOW_ADMIN_PASSWORD):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/ui-attach.mjs
import { chromium } from 'playwright';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

const describe = (input) => ({
  accept: input.getAttribute('accept') || '',
  capture: input.getAttribute('capture') || '',
  multiple: input.multiple,
});

/* Параметры выбора читаем в самой странице: у <input type=file> они живут в
   атрибутах, а не в объекте, который вернёт выбор файла. */
const readInput = async (chooser) => (await (await chooser).element()).evaluate(describe);

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const login = await phone.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!login.ok()) throw new Error(`вход не удался: ${login.status()}`);
  const page = await phone.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#fileBtn');
  ok('на телефоне три кнопки прикрепления есть',
    (await page.isVisible('#photoBtn')) && (await page.isVisible('#galleryBtn')) && (await page.isVisible('#fileBtn')));
  ok('кнопки «＋» больше нет', (await page.locator('#attachBtn').count()) === 0);

  /* Видимые кнопки ряда: режим с подписью, три прикрепления и действие.
     Отправка в этом состоянии скрыта — её место занимает микрофон, поэтому её
     верх сравнивать не с чем (скрытый элемент отдаёт нулевой прямоугольник).
     Проверка орфографии на телефоне намеренно не показана: в ряду пять кнопок. */
  const row = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const shown = (id) => document.getElementById(id).getBoundingClientRect().width > 0;
    return {
      tops: ['thinkToggle', 'photoBtn', 'galleryBtn', 'fileBtn', 'micBtn'].filter(shown).map((id) => Math.round(box(id).top)),
      micVisible: shown('micBtn'),
      sendVisible: shown('sendBtn'),
      spellVisible: shown('spellBtn'),
      thinkText: document.getElementById('thinkToggle').innerText.trim(),
    };
  });
  ok('пять кнопок в одном ряду: режим, камера, альбом, файл и действие',
    row.tops.length === 5 && Math.max(...row.tops) - Math.min(...row.tops) < 2, row.tops.join(' / '));
  ok('у кнопки режима видна подпись «Рассуждение»', row.thinkText === 'Рассуждение', row.thinkText);
  ok('шестой кнопки (орфографии) в ряду нет', !row.spellVisible);
  ok('пустое поле: в ряду микрофон, а отправка уступает ему место',
    row.micVisible && !row.sendVisible, JSON.stringify(row));

  /* Камера: Chrome в headless не фотографирует, но обязан показать выбор и
     пометить себя как съёмку — иначе iPhone откроет галерею вместо камеры. */
  const cameraChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#photoBtn');
  const cameraInput = await readInput(cameraChooser);
  ok('«Сфотографировать» зовёт камеру на фото',
    cameraInput.accept === 'image/*' && cameraInput.capture === 'environment' && !cameraInput.multiple,
    JSON.stringify(cameraInput));

  const galleryChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#galleryBtn');
  const galleryInput = await readInput(galleryChooser);
  ok('«Фото из галереи» берёт только снимки и без камеры',
    galleryInput.accept === 'image/*' && !galleryInput.capture, JSON.stringify(galleryInput));

  const fileChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#fileBtn');
  const fileInput = await readInput(fileChooser);
  ok('«Файл» разрешает любые файлы и несколько сразу',
    fileInput.accept === '' && !fileInput.capture && fileInput.multiple, JSON.stringify(fileInput));

  ok('никакого меню на экране не появляется', !(await page.isVisible('.attach-menu')));

  /* С текстом в поле та же правая кнопка становится отправкой, и ряд не
     разъезжается: микрофон уходит, отправка встаёт ровно на его место. */
  const micSlot = await page.evaluate(() => {
    const rect = document.getElementById('micBtn').getBoundingClientRect();
    return { right: Math.round(rect.right), top: Math.round(rect.top) };
  });
  await page.fill('#input', 'Проверка кнопки');
  const typed = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const send = rect('sendBtn');
    return {
      sendVisible: send.width > 0,
      micVisible: rect('micBtn').width > 0,
      sameRow: Math.abs(send.top - rect('photoBtn').top) < 2,
      right: Math.round(send.right),
      top: Math.round(send.top),
    };
  });
  ok('появился текст: отправка встала в тот же ряд на место микрофона',
    typed.sendVisible && !typed.micVisible && typed.sameRow && typed.right === micSlot.right && typed.top === micSlot.top,
    `${JSON.stringify(micSlot)} → ${JSON.stringify(typed)}`);
  await page.fill('#input', '');
  await phone.close();

  /* Компьютер: кнопки съёмки и файла стоят справа от поля, альбома нет — он
     открывал тот же проводник, что и «Файл», но только с фильтром картинок. */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskLogin = await desktop.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!deskLogin.ok()) throw new Error(`вход на компьютере не удался: ${deskLogin.status()}`);
  const deskPage = await desktop.newPage();
  await deskPage.goto(BASE, { waitUntil: 'load' });
  await deskPage.waitForSelector('#fileBtn');
  ok('на компьютере «Сфотографировать» и «Файл» на месте',
    (await deskPage.isVisible('#photoBtn')) && (await deskPage.isVisible('#fileBtn')));
  ok('дублирующего альбома на компьютере нет', !(await deskPage.isVisible('#galleryBtn')));
  const deskThink = await deskPage.evaluate(() => {
    const node = document.getElementById('thinkToggle');
    const box = node.getBoundingClientRect();
    return { shown: box.width > 0, text: node.innerText.trim(), height: Math.round(box.height) };
  });
  ok('кнопка «Рассуждение» есть и на компьютере, с подписью',
    deskThink.shown && deskThink.text === 'Рассуждение', JSON.stringify(deskThink));
  const deskOrder = await deskPage.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return {
      input: Math.round(rect('input').x),
      think: Math.round(rect('thinkToggle').x),
      photo: Math.round(rect('photoBtn').x),
      file: Math.round(rect('fileBtn').x),
      inputRight: Math.round(rect('input').right),
      composerRight: Math.round(composer.right),
      photoTop: Math.round(rect('photoBtn').top),
      inputTop: Math.round(rect('input').top),
    };
  });
  ok('поле ввода первое, кнопки ряда — справа от него',
    deskOrder.input < deskOrder.think && deskOrder.think < deskOrder.photo && deskOrder.photo < deskOrder.file,
    JSON.stringify(deskOrder));
  ok('кнопки стоят на одной линии с полем',
    Math.abs(deskOrder.photoTop - deskOrder.inputTop) < 12, JSON.stringify(deskOrder));
  ok('поле тянется вплоть до кнопок', deskOrder.inputRight <= deskOrder.think + 1, JSON.stringify(deskOrder));
  const deskChooser = deskPage.waitForEvent('filechooser', { timeout: 5000 });
  await deskPage.click('#fileBtn');
  const deskInput = await readInput(deskChooser);
  ok('на компьютере «Файл» сразу открывает выбор файлов',
    deskInput.accept === '' && deskInput.multiple, JSON.stringify(deskInput));
  ok('на компьютере меню не появляется', !(await deskPage.isVisible('.attach-menu')));

  /* «Сфотографировать» на компьютере — окно с камерой ноутбука, а не выбор
     файла: раньше здесь открывался проводник, и снять себя было нечем. */
  let chooserOnCamera = false;
  const strayChooser = deskPage.waitForEvent('filechooser', { timeout: 2000 }).then(() => {
    chooserOnCamera = true;
  }).catch(() => {});
  await deskPage.click('#photoBtn');
  await deskPage.waitForSelector('.modal.camera-modal', { state: 'visible', timeout: 5000 });
  await deskPage.waitForFunction(() => {
    const video = document.querySelector('.camera-video');
    return Boolean(video && video.srcObject && video.readyState >= 2 && video.videoWidth > 0);
  }, null, { timeout: 15000 });
  await strayChooser;
  ok('«Сфотографировать» включает камеру, а не открывает проводник', !chooserOnCamera);
  const live = await deskPage.evaluate(() => {
    const video = document.querySelector('.camera-video');
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      mirrored: getComputedStyle(video).transform !== 'none',
      main: document.querySelector('.modal.camera-modal .modal-foot .btn-primary')?.textContent,
      idleHidden: document.querySelector('.camera-idle').classList.contains('hidden'),
    };
  });
  ok('в окне живой кадр камеры', live.width > 0 && live.idleHidden, JSON.stringify(live));
  ok('кадр зеркальный, как в зеркале', live.mirrored === true, JSON.stringify(live));
  ok('главная кнопка подписана «Снять фото»', live.main === 'Снять фото', live.main);

  await deskPage.click('.modal.camera-modal .modal-foot .btn-primary');
  await deskPage.waitForSelector('.camera-shot:not(.hidden)', { timeout: 10000 });
  const shot = await deskPage.evaluate(() => {
    const foot = document.querySelector('.modal.camera-modal .modal-foot');
    const retake = Array.from(foot.querySelectorAll('.btn-quiet')).find((button) => button.textContent === 'Переснять');
    return {
      main: foot.querySelector('.btn-primary')?.textContent,
      retakeShown: Boolean(retake) && !retake.classList.contains('hidden'),
      naturalWidth: document.querySelector('.camera-shot')?.naturalWidth || 0,
      streamOff: !document.querySelector('.camera-video')?.srcObject,
    };
  });
  ok('снимок получился и предлагает «Прикрепить»', shot.main === 'Прикрепить' && shot.naturalWidth > 0, JSON.stringify(shot));
  ok('после снимка предлагается «Переснять»', shot.retakeShown === true);
  ok('камера после снимка выключена', shot.streamOff === true, JSON.stringify(shot));

  await deskPage.click('.modal.camera-modal .modal-foot .btn-primary');
  await deskPage.waitForSelector('#attachStrip .file-chip', { timeout: 20000 });
  const shotChip = await deskPage.evaluate(() => ({
    name: document.querySelector('#attachStrip .file-chip .fc-name')?.textContent || '',
    modalClosed: !document.querySelector('.modal.camera-modal'),
  }));
  ok('снимок прикрепился к сообщению', /^Снимок-\d{4}-/.test(shotChip.name) && shotChip.modalClosed, JSON.stringify(shotChip));

  /* Видео: запись идёт со счётчиком, после остановки запись проигрывается в
     том же окне, а закрытие окна гасит камеру и ссылку на файл. */
  await deskPage.click('#photoBtn');
  await deskPage.waitForFunction(() => {
    const video = document.querySelector('.camera-video');
    return Boolean(video && video.srcObject && video.readyState >= 2);
  }, null, { timeout: 15000 });
  await deskPage.click('.camera-mode:not(.is-on)');
  await deskPage.waitForFunction(() => document.querySelector('.modal.camera-modal .modal-foot .btn-primary')?.textContent === 'Записать видео');
  await deskPage.click('.modal.camera-modal .modal-foot .btn-primary');
  await deskPage.waitForSelector('.camera-rec:not(.hidden)', { timeout: 10000 });
  await deskPage.waitForTimeout(1600);
  const rec = await deskPage.evaluate(() => ({
    main: document.querySelector('.modal.camera-modal .modal-foot .btn-primary')?.textContent,
    time: document.querySelector('.camera-rec-time')?.textContent,
  }));
  ok('идёт запись видео со счётчиком', rec.main === 'Остановить запись' && rec.time !== '0:00', JSON.stringify(rec));
  await deskPage.click('.modal.camera-modal .modal-foot .btn-primary');
  await deskPage.waitForSelector('.camera-playback:not(.hidden)', { timeout: 15000 });
  const video = await deskPage.evaluate(async () => {
    const player = document.querySelector('.camera-playback');
    let error = '';
    try {
      await player.play();
      await new Promise((resolve) => setTimeout(resolve, 700));
    } catch (playError) {
      error = String(playError);
    }
    return {
      main: document.querySelector('.modal.camera-modal .modal-foot .btn-primary')?.textContent,
      currentTime: player.currentTime,
      error,
    };
  });
  ok('видео записалось и проигрывается', video.main === 'Прикрепить' && video.currentTime > 0, JSON.stringify(video));

  await deskPage.locator('.modal.camera-modal .modal-foot').getByRole('button', { name: 'Отмена' }).click();
  await deskPage.waitForSelector('.modal.camera-modal', { state: 'detached', timeout: 5000 });
  const afterClose = await deskPage.evaluate(() => ({
    videoGone: !document.querySelector('.camera-video'),
    recorded: document.querySelectorAll('#attachStrip .file-chip').length,
  }));
  ok('закрытие окна убирает камеру и не прикрепляет запись само',
    afterClose.videoGone && afterClose.recorded === 1, JSON.stringify(afterClose));
  await desktop.close();

  /* Камера отказала: окно не должно молча пустовать. Показываем «Камера
     недоступна», оставляем повтор и выход — выбрать файл с диска. */
  const denied = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await denied.addInitScript(() => {
    const reject = () => {
      const error = new Error('Permission denied');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = reject;
  });
  const deniedLogin = await denied.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!deniedLogin.ok()) throw new Error(`вход без камеры не удался: ${deniedLogin.status()}`);
  const deniedPage = await denied.newPage();
  await deniedPage.goto(BASE, { waitUntil: 'load' });
  await deniedPage.waitForSelector('#photoBtn');
  await deniedPage.click('#photoBtn');
  await deniedPage.waitForSelector('.camera-idle:not(.hidden)', { timeout: 10000 });
  const failed = await deniedPage.evaluate(() => ({
    title: document.querySelector('.camera-idle-title')?.textContent?.trim(),
    reason: document.querySelector('.camera-idle-text')?.textContent?.trim(),
    main: document.querySelector('.modal.camera-modal .modal-foot .btn-primary')?.textContent?.trim(),
    fallback: (() => {
      const node = [...document.querySelectorAll('.camera-idle .btn-quiet')].find((item) => item.textContent.trim() === 'Выбрать файл с диска');
      return node ? Math.round(node.getBoundingClientRect().width) > 0 : false;
    })(),
  }));
  ok('без камеры окно объясняет отказ и предлагает повтор',
    failed.title === 'Камера недоступна' && Boolean(failed.reason) && failed.main === 'Включить камеру' && failed.fallback,
    JSON.stringify(failed));
  const [deniedChooser] = await Promise.all([
    deniedPage.waitForEvent('filechooser', { timeout: 5000 }),
    deniedPage.getByRole('button', { name: 'Выбрать файл с диска' }).click(),
  ]);
  const deniedAccept = await deniedPage.evaluate(() => document.getElementById('fileInput')?.accept);
  const deniedModalGone = await deniedPage.locator('.modal.camera-modal').count();
  ok('«Выбрать файл с диска» выводит к обычному выбору картинки',
    Boolean(deniedChooser) && deniedAccept === 'image/*' && deniedModalGone === 0,
    JSON.stringify({ accept: deniedAccept, modal: deniedModalGone }));
  await deniedChooser.setFiles([]).catch(() => {});
  await denied.close();
} finally {
  await browser.close();
}

console.log(failed ? `Провалов: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);

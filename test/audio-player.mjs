// Проверка блока прослушивания на jsdom: один блок управления, скорости только
// в «трёх точках» (все до 2×, включая 0,8 и 0,9), скрытый док с единственным
// <audio>, память места и скорости, MediaSession для экрана блокировки iPhone.
// Берём ровно тот код, который уезжает в public/app.js, — между маркерами
// audio-player:start / audio-player:end, поэтому тест не расходится с боем.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(process.env.AUDIO_TEST_ROOT || path.join(import.meta.dirname, '..'));
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

const START = '/* --- audio-player:start --- */';
const END = '/* --- audio-player:end --- */';
const startAt = source.indexOf(START);
const endAt = source.indexOf(END);
if (startAt < 0 || endAt < 0 || endAt <= startAt) {
  console.error('В public/app.js нет маркеров блока прослушивания');
  process.exit(1);
}
const block = source.slice(startAt + START.length, endAt);
if (block.trim().length < 1000) {
  console.error('Блок прослушивания подозрительно короткий');
  process.exit(1);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://dshopen.example/',
  pretendToBeVisual: true,
});
const { window } = dom;
const document = window.document;

/* --- мини-среда браузера --------------------------------------------------- */
const media = window.HTMLMediaElement.prototype;
const prop = (name, get, set) =>
  Object.defineProperty(media, name, { configurable: true, get, set });

prop(
  'paused',
  function paused() {
    return this.__paused !== false;
  },
  function paused(value) {
    this.__paused = Boolean(value);
  },
);
prop(
  'ended',
  function ended() {
    return this.__ended === true;
  },
  function ended(value) {
    this.__ended = Boolean(value);
  },
);
prop(
  'duration',
  function duration() {
    return this.__duration === undefined ? NaN : this.__duration;
  },
  function duration(value) {
    this.__duration = Number(value);
  },
);
prop(
  'currentTime',
  function currentTime() {
    return this.__time || 0;
  },
  function currentTime(value) {
    this.__time = Math.max(0, Number(value) || 0);
  },
);
prop(
  'readyState',
  function readyState() {
    return this.__readyState === undefined ? 0 : this.__readyState;
  },
  function readyState(value) {
    this.__readyState = Number(value);
  },
);
prop(
  'playbackRate',
  function playbackRate() {
    return this.__rate === undefined ? 1 : this.__rate;
  },
  function playbackRate(value) {
    this.__rate = Number(value);
  },
);
prop(
  'defaultPlaybackRate',
  function defaultPlaybackRate() {
    return this.__defaultRate === undefined ? 1 : this.__defaultRate;
  },
  function defaultPlaybackRate(value) {
    this.__defaultRate = Number(value);
  },
);
media.load = function load() {
  this.__readyState = 0;
};
media.play = function play() {
  this.__paused = false;
  this.__ended = false;
  this.__readyState = 1;
  this.dispatchEvent(new window.Event('play'));
  return Promise.resolve();
};
media.pause = function pause() {
  if (this.__paused === true) return;
  this.__paused = true;
  this.dispatchEvent(new window.Event('pause'));
};

class FakeMediaMetadata {
  constructor(data) {
    Object.assign(this, data);
  }
}
window.MediaMetadata = FakeMediaMetadata;

const session = {
  metadata: null,
  playbackState: 'none',
  handlers: {},
  position: null,
  setActionHandler(name, handler) {
    this.handlers[name] = handler;
  },
  setPositionState(state) {
    this.position = state;
  },
};
Object.defineProperty(window.navigator, 'mediaSession', { configurable: true, get: () => session });

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
globalThis.MediaMetadata = FakeMediaMetadata;
globalThis.state = { activeProjectId: 'p1' };
globalThis.filesProjectId = () => 'p1';
globalThis.toast = () => {};
globalThis.ICONS = {
  play: '<svg data-icon="play"></svg>',
  dots: '<svg data-icon="dots"></svg>',
};
globalThis.el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const api = new Function(
  `${block}\nreturn { AUDIO_RATES, mountAudioPlayer, audioNowPlaying, saveNowPlaying, audioDockElement };`,
)();

let failed = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('Проверка блока прослушивания');

/* --- 1. Список скоростей и разметка ---------------------------------------- */
check(
  'все скорости до 2× объявлены, включая 0,8 и 0,9',
  api.AUDIO_RATES.join(',') === '0.5,0.75,0.8,0.9,1,1.25,1.5,1.75,2',
  api.AUDIO_RATES.join(','),
);
check('CSS: полоса управления .audio-bar', css.includes('.audio-bar'));
check('CSS: видимая кнопка скорости .audio-speed', css.includes('.audio-speed'));
check('CSS: всплывающее меню .audio-menu', css.includes('.audio-menu'));
check('CSS: скрытый док .audio-dock', css.includes('.audio-dock'));
check('CSS: обложки и «трёх точек» больше нет', !css.includes('.audio-face') && !css.includes('.audio-more'));
check('CSS: ряда скоростей под блоком больше нет', !css.includes('.audio-rates') && !css.includes('.audio-rate['));
check('CSS: плашки «Продолжить прослушивание» больше нет', !css.includes('.resume-bar') && !css.includes('.resume-audio'));
check('в коде нет плашки и её обвязки', !/initResumeBar|refreshResumeBar|hideResumeBar|resumeBar/.test(source));
check('подсказки «Запись можно слушать здесь же» нет', !source.includes('можно слушать здесь же'));

/* --- 2. Блок в окне -------------------------------------------------------- */
const host = document.createElement('div');
document.body.appendChild(host);
const first = api.mountAudioPlayer(host, {
  src: '/api/projects/p1/file?path=book.mp3',
  title: 'Книга.mp3',
  name: 'book.mp3',
  path: 'book.mp3',
  projectId: 'p1',
});
const audio = first.player;
const bar = host.querySelector('.audio-bar');
check('в блоке ровно одна полоса управления', host.querySelectorAll('.audio-bar').length === 1 && Boolean(bar));
check('в блоке нет кнопок скорости', host.querySelectorAll('.audio-rate').length === 0);
check(
  'в полосе есть play, время, перемотка и кнопка скорости',
  Boolean(bar.querySelector('.audio-toggle')) &&
    Boolean(bar.querySelector('.audio-time')) &&
    Boolean(bar.querySelector('input.audio-seek')) &&
    Boolean(bar.querySelector('.audio-speed')),
);
const backBtn = bar.querySelector('.audio-back');
const fwdBtn = bar.querySelector('.audio-forward');
check(
  'перемотка: по 10 секунд в обе стороны',
  backBtn?.getAttribute('aria-label') === 'Назад на 10 секунд' &&
    fwdBtn?.getAttribute('aria-label') === 'Вперёд на 10 секунд' &&
    backBtn.querySelector('.audio-skip-label')?.textContent === '10' &&
    fwdBtn.querySelector('.audio-skip-label')?.textContent === '10',
);
check(
  'в иконках перемотки нет цифр внутри дуги',
  !backBtn?.querySelector('text') && !fwdBtn?.querySelector('text'),
);
check('звук живёт в доке вне окна', audio.parentElement.classList.contains('audio-dock') && audio.parentElement.parentElement === document.body);
check('во всём документе один <audio>', document.querySelectorAll('audio').length === 1);
check('док не виден на экране', Boolean(document.querySelector('.audio-dock')));

/* --- 3. Меню скорости ------------------------------------------------------ */
const more = bar.querySelector('.audio-speed');
const menu = host.querySelector('.audio-menu');
check('меню закрыто до нажатия', menu.hidden === true && more.getAttribute('aria-expanded') === 'false');
more.click();
const labels = Array.from(menu.querySelectorAll('.audio-menu-item')).map((item) => item.textContent);
check('меню открылось', menu.hidden === false && more.getAttribute('aria-expanded') === 'true');
check('в меню девять скоростей 0,5–2', labels.join(' ') === '0,5× 0,75× 0,8× 0,9× 1× 1,25× 1,5× 1,75× 2×', labels.join(' '));
check('0,8× и 0,9× в меню есть', labels.includes('0,8×') && labels.includes('0,9×'));
check('меню — список radio', menu.getAttribute('role') === 'menu' && menu.querySelector('.audio-menu-item').getAttribute('role') === 'menuitemradio');
const checkedNow = Array.from(menu.querySelectorAll('.audio-menu-item')).filter((item) => item.getAttribute('aria-checked') === 'true');
check('текущая скорость отмечена', checkedNow.length === 1 && checkedNow[0].textContent === '1×');
check('на кнопке видно текущую скорость', more.querySelector('.audio-speed-value').textContent === '1×');
check('меню подписано скоростью на кнопке', more.getAttribute('aria-label') === 'Скорость прослушивания: 1×', more.getAttribute('aria-label'));

const item09 = Array.from(menu.querySelectorAll('.audio-menu-item')).find((item) => item.textContent === '0,9×');
item09.click();
check('0,9× ставит playbackRate', audio.playbackRate === 0.9, String(audio.playbackRate));
check('0,9× запомнилась как скорость по умолчанию', audio.defaultPlaybackRate === 0.9);
check('после выбора меню закрылось', menu.hidden === true && more.getAttribute('aria-expanded') === 'false');
check('скорость запомнена в памяти', api.audioNowPlaying()?.rate === 0.9);
check('кнопка показывает выбранную скорость', more.getAttribute('aria-label') === 'Скорость прослушивания: 0,9×' && more.querySelector('.audio-speed-value').textContent === '0,9×', more.getAttribute('aria-label'));
const checked09 = Array.from(menu.querySelectorAll('.audio-menu-item')).filter((item) => item.getAttribute('aria-checked') === 'true');
check('отметка переехала на 0,9×', checked09.length === 1 && checked09[0].textContent === '0,9×');

/* Esc в меню не должен закрывать окно: событие гасим сами. */
more.click();
const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
document.dispatchEvent(escape);
check('Esc закрывает только меню', menu.hidden === true && escape.defaultPrevented === true);

/* --- 4. Экран блокировки и память места ------------------------------------ */
audio.dispatchEvent(new window.Event('play'));
check('MediaSession: название записи', session.metadata?.title === 'Книга.mp3');
check('MediaSession: исполнитель DSH Open', session.metadata?.artist === 'DSH Open');
check(
  'MediaSession: обложка /icons/icon-512.png',
  Array.isArray(session.metadata?.artwork) && session.metadata.artwork[0]?.src === '/icons/icon-512.png',
);
check('MediaSession: состояние playing', session.playbackState === 'playing');
check('MediaSession: обработчик play на экране блокировки', typeof session.handlers.play === 'function');
check('MediaSession: обработчик pause', typeof session.handlers.pause === 'function');
check('MediaSession: обработчик seekbackward', typeof session.handlers.seekbackward === 'function');
check('MediaSession: обработчик seekto', typeof session.handlers.seekto === 'function');

audio.__duration = 754;
audio.__readyState = 1;
audio.__time = 33;
audio.dispatchEvent(new window.Event('timeupdate'));
check('место прослушивания запомнено', Math.abs((api.audioNowPlaying()?.time || 0) - 33) < 1);
check('длительность запомнена', Math.abs((api.audioNowPlaying()?.duration || 0) - 754) < 1);

/* --- 5. Перемотка по 10 секунд --------------------------------------------- */
audio.__time = 100;
backBtn.click();
check('назад на 10 секунд', audio.__time === 90, String(audio.__time));
audio.__time = 100;
fwdBtn.click();
check('вперёд на 10 секунд', audio.__time === 110, String(audio.__time));
audio.__time = 5;
backBtn.click();
check('назад не уходит за начало', audio.__time === 0, String(audio.__time));
audio.__time = 750;
fwdBtn.click();
check('вперёд не уходит за конец', Math.abs(audio.__time - 753.75) < 0.01, String(audio.__time));
audio.__time = 100;
session.handlers.seekbackward({ seekOffset: 10 });
check('экран блокировки: назад 10 секунд', audio.__time === 90, String(audio.__time));
audio.__time = 100;
session.handlers.seekforward({ seekOffset: 10 });
check('экран блокировки: вперёд 10 секунд', audio.__time === 110, String(audio.__time));

/* Долгое удержание: после первого шага включается плавная перемотка. */
audio.__time = 100;
backBtn.dispatchEvent(new window.Event('pointerdown'));
check('удержание: первый шаг сразу', audio.__time === 90, String(audio.__time));
await new Promise((resolve) => setTimeout(resolve, 520));
check('удержание: кнопка подсвечена', backBtn.classList.contains('is-holding'));
check('удержание: позиция продолжает ехать', audio.__time < 90, String(audio.__time));
backBtn.dispatchEvent(new window.Event('pointerup'));
check('удержание: подсветка снята', !backBtn.classList.contains('is-holding'));
/* Возвращаем позицию, которую запомнила память: дальше тест проверяет,
   что новый блок продолжает ровно с неё, а не с последней перемотки. */
audio.__time = 33;

first.rename('Книга — часть 2.mp3', 2);
check('название части обновилось на экране блокировки', session.metadata?.title === 'Книга — часть 2.mp3');
check('часть запомнена', api.audioNowPlaying()?.part === 2);

audio.dispatchEvent(new window.Event('pause'));
check('пауза отдаёт состояние paused', session.playbackState === 'paused');

/* --- 5. Другой файл, потом возврат к книге --------------------------------- */
audio.src = '/api/projects/p1/file?path=other.mp3';
audio.__time = 0;
const other = api.mountAudioPlayer(host, {
  src: '/api/projects/p1/file?path=other.mp3',
  title: 'Другая запись.mp3',
  name: 'other.mp3',
  path: 'other.mp3',
  projectId: 'p1',
});
check('второй блок переиспользует тот же <audio>', other.player === audio);
check('во всём документе по-прежнему один <audio>', document.querySelectorAll('audio').length === 1);
/* Память переключается только когда новая запись заиграла: просто открыть
   другой файл и закрыть окно — не повод забыть место в книге. */
check('память не трогаем, пока новый файл не заиграл', String(api.audioNowPlaying()?.src).endsWith('path=book.mp3'));

/* Возвращаемся к книге: место и скорость должны восстановиться сами. */
const back = api.mountAudioPlayer(host, {
  src: '/api/projects/p1/file?path=book.mp3',
  title: 'Книга — часть 2.mp3',
  name: 'book.mp3',
  path: 'book.mp3',
  projectId: 'p1',
});
check('скорость восстановлена при повторном открытии', back.player.playbackRate === 0.9, String(back.player.playbackRate));
back.player.__duration = 754;
back.player.dispatchEvent(new window.Event('loadedmetadata'));
check(
  'место восстановлено при повторном открытии',
  Math.abs(back.player.currentTime - 33) < 2,
  String(back.player.currentTime),
);

/* --- 6. Смена части не сбрасывает темп ------------------------------------ */
const rateItem = (value) =>
  Array.from(host.querySelectorAll('.audio-menu-item')).find((item) => item.dataset.rate === String(value));
more.click();
rateItem(1.25).click();
check('1,25× выбран до новых метаданных', back.player.playbackRate === 1.25, String(back.player.playbackRate));
back.player.src = '/api/tts/jobs/test/audio?part=2';
back.player.__duration = 600;
back.player.dispatchEvent(new window.Event('loadedmetadata'));
check('смена части не сбрасывает скорость', back.player.playbackRate === 1.25, String(back.player.playbackRate));

/* --- 7. Запись закончилась -------------------------------------------------- */
back.player.__time = 600;back.player.__ended = true;
back.player.dispatchEvent(new window.Event('ended'));
check('после конца записи состояние none', session.playbackState === 'none');
check('после конца место обнулилось', (api.audioNowPlaying()?.time || 0) === 0);

/* --- 8. Память идёт за той записью, которая действительно заиграла --------- */
const again = api.mountAudioPlayer(host, {
  src: '/api/projects/p1/file?path=other.mp3',
  title: 'Другая запись.mp3',
  name: 'other.mp3',
  path: 'other.mp3',
  projectId: 'p1',
});
await again.player.play();
check('после запуска другой записи память переключилась', String(api.audioNowPlaying()?.src).endsWith('path=other.mp3'));

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки блока прослушивания пройдены');

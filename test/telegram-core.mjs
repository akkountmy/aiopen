/**
 * Офлайн-тест src/telegram-core.mjs (node:test, без сети).
 *
 * Фикстуры собраны вручную по реальной структуре https://t.me/s/<channel>:
 * обёртки div.tgme_widget_message_wrap, div.tgme_widget_message[data-post],
 * div.tgme_widget_message_text.js-message_text, <time datetime>, просмотры,
 * пересылки, медиа-маркеры, HTML-сущности и многострочный текст.
 * Порядок атрибутов и лишние классы в фикстурах специально разные.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChannelPage,
  parseChannelInfo,
  normalizeUsername,
  dedupePosts,
  filterPosts,
  aggregateStats,
  renderExportMarkdown,
  renderDigestSources,
  buildDigestPrompt,
  STOPWORDS,
  normalizeBreaker,
  breakerFailure,
  breakerSuccess,
  breakerView,
  breakerPlan,
  breakerCooldownMs,
  BREAKER_BASE_MS,
  BREAKER_MAX_MS,
} from '../src/telegram-core.mjs';

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

const CHANNEL_A_HTML = `<!DOCTYPE html>
<html>
<head>
<meta property="og:title" content="Павел Дуров">
<meta content="Думаю о будущем" property="og:description">
</head>
<body>
<div class="tgme_page_wrap">
  <div class="tgme_channel_info">
    <div class="tgme_channel_info_header">
      <div class="tgme_channel_info_header_title_wrap">
        <div class="tgme_channel_info_header_title"><span dir="auto">Павел Дуров</span></div>
        <div class="tgme_channel_info_header_username"><a href="https://t.me/durov">@durov</a></div>
      </div>
    </div>
    <div class="tgme_channel_info_description">Официальный канал&nbsp;Дурова &amp; команды</div>
    <div class="tgme_channel_info_counters">
      <div class="tgme_channel_info_counter">
        <span class="counter_value">1.2M</span>
        <span class="counter_type">subscribers</span>
      </div>
      <div class="tgme_channel_info_counter">
        <span class="counter_value">3&#160;421</span>
        <span class="counter_type">photos</span>
      </div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="durov/1001" data-view="m1">
      <a class="tgme_widget_message_photo_wrap blured" href="https://t.me/durov/1001" style="background-image:url('https://cdn4.telesco.pe/file/a.jpg')">
        <div class="tgme_widget_message_photo" style="background-image:url('https://cdn4.telesco.pe/file/a.jpg')"></div>
      </a>
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_text js-message_text" dir="auto">Привет,&nbsp;мир &amp; всем<br/>Вторая строка &#33;<br>Ссылка: <a href="https://example.com/news?id=1&amp;utm=x">здесь</a> и <a href="https://t.me/durov/999">старый пост</a></div>
        <div class="tgme_widget_message_footer compact js-message_footer">
          <div class="tgme_widget_message_info short js-message_info">
            <span class="tgme_widget_message_views">1.2K</span>
            <span class="tgme_widget_message_forwards_wrap"><span class="tgme_widget_message_forwards" title="17">17</span></span>
            <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durov/1001"><time datetime="2026-11-08T19:31:00+00:00" class="time">19:31</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div data-post="durov/1002" class="tgme_widget_message js-widget_message">
      <div class="tgme_widget_message_bubble">
        <a class="tgme_widget_message_video_wrap" href="https://t.me/durov/1002">
          <div class="tgme_widget_message_video_player js-message_video_player">
            <div class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/b.jpg')"></div>
          </div>
        </a>
        <div class="tgme_widget_message_text js-message_text" dir="auto">Срочная новость: запуск проекта &quot;Альфа&quot; &mdash; подробности</div>
        <div class="tgme_widget_message_footer">
          <div class="tgme_widget_message_info">
            <span class="tgme_widget_message_views">12.3K</span>
            <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durov/1002"><time datetime="2026-11-08T10:05:00+00:00">10:05</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message js-widget_message" data-post="durov/1003">
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_poll">
          <div class="tgme_widget_message_poll_question">Какой формат лучше?</div>
          <div class="tgme_widget_message_poll_option"><span class="tgme_widget_message_poll_option_percent">64%</span><span class="tgme_widget_message_poll_option_text">Тексты</span></div>
        </div>
        <div class="tgme_widget_message_text js-message_text" dir="auto">Обсуждение: стабильность и новая версия продукта</div>
        <div class="tgme_widget_message_footer">
          <div class="tgme_widget_message_info">
            <span class="tgme_widget_message_views">1.2M</span>
            <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durov/1003"><time datetime="2026-11-07T09:00:00+00:00">09:00</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

const CHANNEL_B_HTML = `<!DOCTYPE html>
<html>
<head>
<meta property="og:title" content="Дуров Новости">
</head>
<body>
<div class="tgme_page_wrap">
  <div class="tgme_channel_info">
    <div class="tgme_channel_info_header_title"><span dir="auto">Дуров Новости</span></div>
    <div class="tgme_channel_info_description">Агрегатор новостей про Telegram</div>
    <div class="tgme_channel_info_counters">
      <div class="tgme_channel_info_counter"><span class="counter_value">45.2K</span><span class="counter_type">subscribers</span></div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message js-widget_message" data-post="durovnews/5001">
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_text js-message_text" dir="auto">Срочная новость: запуск проекта «Альфа» состоялся сегодня</div>
        <div class="tgme_widget_message_footer">
          <div class="tgme_widget_message_info">
            <span class="tgme_widget_message_views">2.5K</span>
            <span class="tgme_widget_message_forwards">3</span>
            <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durovnews/5001"><time datetime="2026-11-08T18:00:00+00:00">18:00</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message js-widget_message" data-post="durovnews/5002">
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_document_wrap">
          <div class="tgme_widget_message_document">
            <div class="tgme_widget_message_document_title">Пояснение.pdf</div>
          </div>
        </div>
        <div class="tgme_widget_message_text js-message_text" dir="auto">Документ с &amp; пояснением<br>вторая строка</div>
        <div class="tgme_widget_message_footer">
          <div class="tgme_widget_message_info">
            <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/durovnews/5002"><time datetime="2026-11-07T08:15:00+00:00">08:15</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

// Краевые случаи: перемешанные атрибуты классов, блок без data-post,
// нечисловые просмотры, пост без текста и без даты.
const MALFORMED_HTML = `<div class="tgme_page_wrap">
  <div class="extra-class js-widget_message_wrap tgme_widget_message_wrap">
    <div data-post="durovnews/5003" data-view="m3" class="tgme_widget_message js-widget_message">
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_document_wrap"><div class="tgme_widget_message_document_title">Смета.pdf</div></div>
        <div class="tgme_widget_message_text js-message_text" dir="auto">Служебное объявление без деталей</div>
        <div class="tgme_widget_message_footer">
          <div class="tgme_widget_message_info">
            <span class="tgme_widget_message_views">—</span>
            <span class="tgme_widget_message_meta"><a href="https://t.me/durovnews/5003"><time class="time" datetime="2026-11-06T12:00:00+00:00">12:00</time></a></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message js-widget_message">
      <div class="tgme_widget_message_text js-message_text" dir="auto">Блок без data-post — его видно только по счётчику wraps</div>
      <time datetime="2026-11-06T12:05:00+00:00">12:05</time>
    </div>
  </div>

  <div class="tgme_widget_message_wrap js-widget_message_wrap">
    <div class="tgme_widget_message js-widget_message" data-post="durovnews/5004">
      <a class="tgme_widget_message_photo_wrap" href="https://t.me/durovnews/5004" style="background-image:url('https://cdn4.telesco.pe/file/c.jpg')"></a>
    </div>
  </div>
</div>`;

const NOW = '2026-11-09T07:00:00.000Z';

const A = parseChannelPage(CHANNEL_A_HTML, 'durov');
const B = parseChannelPage(CHANNEL_B_HTML, 'durovnews');
const M = parseChannelPage(MALFORMED_HTML, 'durovnews');
const FEED = [...A.posts, ...B.posts];

// ---------------------------------------------------------------------------
// parseChannelPage
// ---------------------------------------------------------------------------

test('парсинг страницы канала: 3 поста, все поля по контракту', () => {
  assert.equal(A.title, 'Павел Дуров');
  assert.deepEqual(A.found, { wraps: 3, texts: 3, dates: 3 });
  assert.equal(A.html, CHANNEL_A_HTML);
  assert.equal(A.posts.length, 3);

  assert.deepEqual(A.posts[0], {
    ch: 'durov',
    id: 1001,
    date: '2026-11-08T19:31:00.000Z',
    text: 'Привет, мир & всем\nВторая строка !\nСсылка: здесь и старый пост',
    views: 1200,
    forwards: 17,
    url: 'https://t.me/durov/1001',
    links: ['https://example.com/news?id=1&utm=x', 'https://t.me/durov/999'],
    hasMedia: true,
    mediaKind: 'photo',
  });
});

test('просмотры: 12.3K → 12300, 1.2M → 1200000; пересылок нет → null', () => {
  assert.equal(A.posts[1].views, 12300);
  assert.equal(A.posts[1].forwards, null);
  assert.equal(A.posts[2].views, 1200000);
  assert.equal(A.posts[2].forwards, null);
});

test('сущности, <br> и медиа-маркеры распознаны по видам', () => {
  assert.equal(A.posts[1].text, 'Срочная новость: запуск проекта "Альфа" — подробности');
  assert.deepEqual(A.posts[1].links, []);
  assert.equal(A.posts[1].hasMedia, true);
  assert.equal(A.posts[1].mediaKind, 'video');

  assert.equal(A.posts[2].mediaKind, 'poll');
  assert.equal(A.posts[2].hasMedia, true);
  assert.deepEqual(A.posts[2].links, []);
});

test('второй канал: текст без медиа, документ — медиа без вида из контракта', () => {
  assert.equal(B.title, 'Дуров Новости');
  assert.deepEqual(B.found, { wraps: 2, texts: 2, dates: 2 });
  assert.equal(B.posts[0].views, 2500);
  assert.equal(B.posts[0].forwards, 3);
  assert.equal(B.posts[0].hasMedia, false);
  assert.equal(B.posts[0].mediaKind, null);
  assert.equal(B.posts[0].text, 'Срочная новость: запуск проекта «Альфа» состоялся сегодня');

  assert.equal(B.posts[1].id, 5002);
  assert.equal(B.posts[1].views, null, 'просмотров нет — null, а не 0');
  assert.equal(B.posts[1].text, 'Документ с & пояснением\nвторая строка');
  assert.equal(B.posts[1].hasMedia, true);
  assert.equal(B.posts[1].mediaKind, null, 'документ: медиа есть, вид вне контракта');
  assert.equal(B.posts[1].date, '2026-11-07T08:15:00.000Z');
});

test('терпимость к разметке: перемешанные атрибуты, нечисловые просмотры, пустой пост', () => {
  assert.deepEqual(M.found, { wraps: 3, texts: 1, dates: 1 });
  assert.equal(M.posts.length, 2, 'блок без data-post постом не считается');
  assert.equal(M.title, null);

  assert.equal(M.posts[0].id, 5003);
  assert.equal(M.posts[0].ch, 'durovnews');
  assert.equal(M.posts[0].views, null, '«—» вместо числа → null');
  assert.equal(M.posts[0].date, '2026-11-06T12:00:00.000Z');
  assert.equal(M.posts[0].hasMedia, true);
  assert.equal(M.posts[0].mediaKind, null);

  assert.equal(M.posts[1].id, 5004);
  assert.equal(M.posts[1].text, '');
  assert.equal(M.posts[1].date, null);
  assert.equal(M.posts[1].views, null);
  assert.equal(M.posts[1].hasMedia, true);
  assert.equal(M.posts[1].mediaKind, 'photo');
});

test('мусор вместо HTML не роняет парсер', () => {
  const empty = parseChannelPage('<html><body>Здесь нет постов</body></html>', 'durov');
  assert.deepEqual(empty.posts, []);
  assert.deepEqual(empty.found, { wraps: 0, texts: 0, dates: 0 });
  assert.equal(empty.title, null);

  const nullish = parseChannelPage(null, 'durov');
  assert.deepEqual(nullish.posts, []);
  assert.equal(nullish.html, '');
  assert.equal(parseChannelPage('', '@не_username').posts.length, 0);
});

test('тест ловит поломку парсера, а не проходит на пустых ожиданиях', () => {
  // Если разметка теряет data-post — постов быть не должно, но обёртки видны.
  const brokenDataPost = CHANNEL_A_HTML.replace(/data-post="/g, 'data-broken="');
  const broken = parseChannelPage(brokenDataPost, 'durov');
  assert.equal(broken.posts.length, 0);
  assert.equal(broken.found.wraps, 3, 'обёртки по-прежнему распознаются');
  assert.equal(broken.found.texts, 0);
  assert.equal(broken.found.dates, 0);
  assert.equal(parseChannelPage(CHANNEL_A_HTML, 'durov').posts.length, 3, 'целая разметка даёт посты');

  // Если исчез класс просмотров — поля views становятся null, а не «как раньше».
  const noViews = parseChannelPage(CHANNEL_A_HTML.replace(/tgme_widget_message_views/g, 'views-broken'), 'durov');
  assert.deepEqual(noViews.posts.map((post) => post.views), [null, null, null]);

  // Если исчезли оба класса текста — текст пустой, ссылки тоже.
  const noText = parseChannelPage(
    CHANNEL_A_HTML.replace(/tgme_widget_message_text|js-message_text/g, 'text-broken'),
    'durov',
  );
  assert.equal(noText.posts[0].text, '');
  assert.deepEqual(noText.posts[0].links, []);
  assert.equal(noText.found.texts, 0);
  // Мягкий вариант: пропал только js-message_text — текст всё равно берётся
  // по tgme_widget_message_text (так он размечен на реальной странице).
  const noJsClass = parseChannelPage(CHANNEL_A_HTML.replace(/js-message_text/g, 'text-broken'), 'durov');
  assert.equal(noJsClass.posts[0].links.length, 2);
});

// ---------------------------------------------------------------------------
// parseChannelInfo
// ---------------------------------------------------------------------------

test('parseChannelInfo: заголовок, описание и подписчики', () => {
  assert.deepEqual(parseChannelInfo(CHANNEL_A_HTML), {
    title: 'Павел Дуров',
    description: 'Официальный канал Дурова & команды',
    subscriberCount: 1200000,
  });
  assert.deepEqual(parseChannelInfo(CHANNEL_B_HTML), {
    title: 'Дуров Новости',
    description: 'Агрегатор новостей про Telegram',
    subscriberCount: 45200,
  });
  assert.deepEqual(parseChannelInfo(MALFORMED_HTML), { title: null, description: null, subscriberCount: null });
});

test('parseChannelInfo: резерв через og-разметку', () => {
  const noDescription = CHANNEL_A_HTML.replace(
    '<div class="tgme_channel_info_description">Официальный канал&nbsp;Дурова &amp; команды</div>',
    '',
  );
  assert.equal(parseChannelInfo(noDescription).description, 'Думаю о будущем');

  const noTitleDiv = CHANNEL_A_HTML.replace('<div class="tgme_channel_info_header_title"><span dir="auto">Павел Дуров</span></div>', '');
  assert.equal(parseChannelInfo(noTitleDiv).title, 'Павел Дуров');
});

// ---------------------------------------------------------------------------
// normalizeUsername
// ---------------------------------------------------------------------------

test('normalizeUsername: все формы ссылок и невалидные входы', () => {
  for (const input of ['durov', '@durov', 'Durov', ' https://t.me/durov ', 't.me/durov', 't.me/s/durov',
    'https://t.me/s/durov', 'https://t.me/durov/123', 'durov/123', 'https://t.me/durov?before=12']) {
    assert.equal(normalizeUsername(input), 'durov', `вход: ${input}`);
  }
  assert.equal(normalizeUsername('@Long_Channel_12'), 'long_channel_12');
  for (const input of ['', null, undefined, '@ab', 'abc', 'a b c', 'https://t.me/joinchat/AAAA', 't.me/c/12345/77',
    'https://example.com/durov', 'телеграм']) {
    assert.equal(normalizeUsername(input), null, `должно быть null: ${String(input)}`);
  }
});

// ---------------------------------------------------------------------------
// dedupePosts
// ---------------------------------------------------------------------------

test('dedupePosts: по (ch, id) остаётся более поздний collectedAt, порядок по дате убыв', () => {
  const older = { ...A.posts[0], collectedAt: '2026-11-09T05:00:00.000Z', text: 'старая версия' };
  const newer = { ...A.posts[0], collectedAt: '2026-11-09T06:30:00.000Z', text: 'новая версия' };

  const result = dedupePosts([older, ...FEED, newer]);
  assert.equal(result.length, 5, 'дубль схлопнут');
  assert.equal(result.find((post) => post.id === 1001).text, 'новая версия');
  assert.deepEqual(result.map((post) => post.id), [1001, 5001, 1002, 1003, 5002]);

  const withUnknownDate = dedupePosts([...FEED, M.posts[1]]);
  assert.equal(withUnknownDate.length, 6);
  assert.equal(withUnknownDate.at(-1).id, 5004, 'пост без даты — в конце');

  assert.deepEqual(dedupePosts([]), []);
});

// ---------------------------------------------------------------------------
// filterPosts
// ---------------------------------------------------------------------------

test('filterPosts: несколько слов = все должны встретиться, поиск регистронезависим', () => {
  assert.deepEqual(filterPosts(FEED, { q: 'вторая строка' }).map((post) => post.id), [1001, 5002]);
  assert.deepEqual(filterPosts(FEED, { q: 'ВТОРАЯ СТРОКА' }).map((post) => post.id), [1001, 5002]);
  assert.deepEqual(filterPosts(FEED, { q: 'запуск' }).map((post) => post.id), [5001, 1002]);
  assert.deepEqual(filterPosts(FEED, { q: 'вторая отсутствующееслово' }), []);
});

test('filterPosts: фраза в кавычках ищется как подстрока, иначе — как отдельные слова', () => {
  assert.deepEqual(filterPosts(FEED, { q: '"вторая строка"' }).map((post) => post.id), [1001, 5002]);
  assert.deepEqual(filterPosts(FEED, { q: '"строка вторая"' }), [], 'обратный порядок слов — не фраза');
  assert.deepEqual(filterPosts(FEED, { q: '«вторая строка»' }).map((post) => post.id), [1001, 5002]);
  assert.deepEqual(filterPosts(FEED, { q: 'запуск "запуск проекта"' }).map((post) => post.id), [5001, 1002]);
});

test('filterPosts: окно hours, before, channels и limit', () => {
  assert.deepEqual(
    filterPosts(FEED, { hours: 24, now: NOW }).map((post) => post.id),
    [1001, 5001, 1002],
  );
  assert.equal(filterPosts(FEED, { hours: 168, now: NOW }).length, 5);
  assert.deepEqual(
    filterPosts(FEED, { before: '2026-11-08T18:00:00.000Z' }).map((post) => post.id),
    [1002, 1003, 5002],
  );
  assert.deepEqual(filterPosts(FEED, { channels: ['durov'] }).map((post) => post.id), [1001, 1002, 1003]);
  assert.deepEqual(filterPosts(FEED, { channels: 'durovnews' }).map((post) => post.id), [5001, 5002]);
  assert.deepEqual(filterPosts(FEED, { limit: 2 }).map((post) => post.id), [1001, 5001]);
  assert.deepEqual(filterPosts(FEED, {}).map((post) => post.id), [1001, 5001, 1002, 1003, 5002]);
});

test('filterPosts не мутирует вход и переживает пустой список', () => {
  const before = FEED.map((post) => post.id);
  filterPosts(FEED, { q: 'запуск', hours: 24, now: NOW, limit: 1 });
  assert.deepEqual(FEED.map((post) => post.id), before);
  assert.deepEqual(filterPosts([], { q: 'запуск', hours: 24 }), []);
});

// ---------------------------------------------------------------------------
// aggregateStats
// ---------------------------------------------------------------------------

test('aggregateStats: каналы, средние просмотры, максимум и последний пост', () => {
  const stats = aggregateStats(FEED, { hours: 168, now: NOW });
  assert.deepEqual(stats.channels.map((channel) => channel.username), ['durov', 'durovnews']);
  assert.deepEqual(stats.channels[0], {
    username: 'durov',
    title: null,
    posts: 3,
    viewsAvg: 404500,
    viewsMax: 1200000,
    lastPostAt: '2026-11-08T19:31:00.000Z',
  });
  assert.deepEqual(stats.channels[1], {
    username: 'durovnews',
    title: null,
    posts: 2,
    viewsAvg: 2500,
    viewsMax: 2500,
    lastPostAt: '2026-11-08T18:00:00.000Z',
  });
});

test('aggregateStats: пустой вход — нули и null, а не NaN', () => {
  assert.deepEqual(aggregateStats([]), { channels: [], topKeywords: [], topLinks: [], duplicates: [] });
  assert.deepEqual(aggregateStats(null), { channels: [], topKeywords: [], topLinks: [], duplicates: [] });

  // Ни у одного поста нет просмотров — средние и максимум должны быть null.
  const stats = aggregateStats(M.posts);
  assert.equal(stats.channels[0].username, 'durovnews');
  assert.equal(stats.channels[0].posts, 2);
  assert.equal(stats.channels[0].viewsAvg, null);
  assert.equal(stats.channels[0].viewsMax, null);
  assert.equal(stats.channels[0].lastPostAt, '2026-11-06T12:00:00.000Z');
  assert.ok(!Number.isNaN(stats.channels[0].viewsAvg));
});

test('aggregateStats: словарь стоп-слов 60-80 и топ-20 ключевых слов', () => {
  assert.ok(STOPWORDS.length >= 60 && STOPWORDS.length <= 80, `стоп-слов: ${STOPWORDS.length}`);

  const stats = aggregateStats(FEED, { hours: 168, now: NOW });
  assert.ok(stats.topKeywords.length > 0 && stats.topKeywords.length <= 20);
  assert.deepEqual(stats.topKeywords[0], { word: 'альфа', count: 2 });
  assert.ok(stats.topKeywords.some((entry) => entry.word === 'запуск' && entry.count === 2));
  assert.ok(stats.topKeywords.some((entry) => entry.word === 'срочная' && entry.count === 2));
  assert.ok(stats.topKeywords.every((entry) => !STOPWORDS.includes(entry.word)));
  assert.ok(stats.topKeywords.every((entry) => entry.count >= 1 && entry.word.length >= 4));

  const stopwordOnly = aggregateStats([
    { ch: 'x', id: 1, date: NOW, text: 'который который который продукт', views: null, links: [] },
  ]);
  assert.deepEqual(stopwordOnly.topKeywords, [{ word: 'продукт', count: 1 }]);
});

test('aggregateStats: топ ссылок из текстов постов', () => {
  const stats = aggregateStats(FEED, { hours: 168, now: NOW });
  assert.deepEqual(stats.topLinks, [
    { url: 'https://example.com/news?id=1&utm=x', count: 1 },
    { url: 'https://t.me/durov/999', count: 1 },
  ]);
});

test('aggregateStats: повторы — одна новость в РАЗНЫХ каналах', () => {
  const stats = aggregateStats(FEED, { hours: 168, now: NOW });
  assert.equal(stats.duplicates.length, 1);
  const group = stats.duplicates[0];
  assert.equal(group.count, 2);
  assert.equal(group.posts.length, 2);
  assert.deepEqual(group.posts.map((ref) => ref.ch).sort(), ['durov', 'durovnews']);
  assert.ok(group.posts.some((ref) => ref.url === 'https://t.me/durov/1002'));
  assert.ok(group.posts.some((ref) => ref.url === 'https://t.me/durovnews/5001'));
  for (const ref of group.posts) {
    assert.equal(typeof ref.id, 'number');
    assert.ok(ref.url.startsWith('https://t.me/'));
    assert.ok(ref.text.length > 0 && ref.text.length <= 120);
  }

  // Два одинаковых поста в одном канале повтором не считаются.
  const sameChannel = aggregateStats([
    { ch: 'x', id: 1, date: '2026-11-08T10:00:00.000Z', text: 'Срочная новость запуск раз', links: [] },
    { ch: 'x', id: 2, date: '2026-11-08T11:00:00.000Z', text: 'Срочная новость запуск два', links: [] },
  ]);
  assert.deepEqual(sameChannel.duplicates, []);
});

// ---------------------------------------------------------------------------
// renderExportMarkdown
// ---------------------------------------------------------------------------

test('renderExportMarkdown: таблица и полные тексты со ссылками', () => {
  const markdown = renderExportMarkdown(FEED, {
    hours: 168,
    channels: ['durov', 'durovnews'],
    generatedAt: NOW,
  });
  assert.ok(markdown.startsWith('# Экспорт постов Telegram'));
  assert.ok(markdown.includes('| Дата (UTC) | Канал | Просмотры | Пост |'));
  assert.ok(markdown.includes('период: 168 ч'));
  assert.ok(markdown.includes('2026-11-08 19:31 UTC'));
  assert.ok(markdown.includes('1200000'), 'просмотры третьего поста');
  assert.ok(markdown.includes('—'), 'у поста без просмотров прочерк, а не null');
  for (const post of FEED) {
    assert.ok(markdown.includes(post.url), `нет ссылки на ${post.url}`);
  }
  assert.ok(markdown.includes('## Посты целиком'));
  assert.ok(markdown.includes('Ссылки в тексте: https://example.com/news?id=1&utm=x'));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('NaN'));
});

test('renderExportMarkdown: пустой список не ломает вывод', () => {
  const markdown = renderExportMarkdown([], { hours: 24 });
  assert.ok(markdown.includes('# Экспорт постов Telegram'));
  assert.ok(markdown.includes('Постов за выбранный период нет'));
  assert.ok(!markdown.includes('undefined'));
});

// ---------------------------------------------------------------------------
// buildDigestPrompt
// ---------------------------------------------------------------------------

function syntheticPosts(count) {
  return Array.from({ length: count }, (_, index) => {
    const ch = `ch${(index % 3) + 1}`;
    const id = 1000 + index;
    return {
      ch,
      id,
      date: new Date(Date.UTC(2026, 10, 8, 0, 0, 0) + index * 1000).toISOString(),
      text: `${'длинный текст новости '.repeat(40)}номер ${index}`,
      views: index,
      forwards: null,
      url: `https://t.me/${ch}/${id}`,
      links: [],
      hasMedia: false,
      mediaKind: null,
    };
  });
}

test('buildDigestPrompt: правила в system, ссылки и формат в user', () => {
  const prompt = buildDigestPrompt(FEED, { hours: 24, focus: 'релизы' });
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
  assert.ok(prompt.system.includes('не выдумывай'), 'system запрещает выдумывать');
  assert.ok(prompt.system.includes('t.me/<канал>/<id>'), 'system задаёт форму ссылки');

  assert.ok(prompt.user.includes('за последние 24 ч'));
  assert.ok(prompt.user.includes('релизы'), 'фокус попадает в промпт');
  assert.ok(prompt.user.includes('3-7 тем'));
  assert.ok(prompt.user.includes('Повторы'));
  for (const post of FEED) {
    assert.ok(prompt.user.includes(post.url), `ссылка потерялась: ${post.url}`);
  }
  assert.equal((prompt.user.match(/^\[\d+\] /gm) || []).length, FEED.length);
  assert.ok(!prompt.user.includes('undefined'));
});

test('buildDigestPrompt: лимит 120 постов и обрезка текста до 400 знаков', () => {
  const posts = syntheticPosts(150);
  const prompt = buildDigestPrompt(posts, { hours: 24 });

  const entries = prompt.user.match(/^\[\d+\] /gm) || [];
  assert.equal(entries.length, 120, 'в промпт попадает не больше 120 постов');
  assert.ok(prompt.user.includes('https://t.me/ch3/1149'), 'самый свежий пост на месте');
  assert.ok(!prompt.user.includes('/1000'), 'самый старый пост отброшен');
  assert.ok(
    prompt.user.indexOf('/1030') < prompt.user.indexOf('/1149'),
    'посты идут от старых к новым',
  );

  for (const line of prompt.user.split('\n')) {
    assert.ok(line.length <= 400, `строка промпта длиннее 400 знаков: ${line.length}`);
  }
  for (const url of ['https://t.me/ch1/1030', 'https://t.me/ch2/1031', 'https://t.me/ch3/1149']) {
    assert.ok(prompt.user.includes(url), `ссылка потерялась при обрезке: ${url}`);
  }
});

test('buildDigestPrompt: пустой вход и посты без даты/просмотров', () => {
  const empty = buildDigestPrompt([], { hours: 24 });
  assert.ok(empty.user.includes('за период постов нет'));
  assert.ok(empty.user.includes('(пусто — постов за период нет)'));

  const malformed = buildDigestPrompt(M.posts, { hours: 24 });
  assert.ok(malformed.user.includes('дата неизвестна'));
  assert.ok(!malformed.user.includes('undefined'));
  assert.ok(!malformed.user.includes('NaN'));
});

// ---------------------------------------------------------------------------
// renderDigestSources
// ---------------------------------------------------------------------------

const SOURCE_LINE_RE = /^- \[@[a-z0-9_]+\/\d+\]\(https:\/\/t\.me\/[a-z0-9_]+\/\d+\)( — .+)?$/;

test('renderDigestSources: ссылки модели идут первыми и в порядке появления', () => {
  const modelText = [
    '## 1. Главное',
    '— факт про новости (https://t.me/durovnews/5002)',
    '— факт про Дурова (https://t.me/durov/1001)',
  ].join('\n');
  const { block, sources } = renderDigestSources(FEED, modelText);

  assert.ok(block.startsWith('## Источники'), 'блок начинается с заголовка');
  assert.equal(sources[0].url, 'https://t.me/durovnews/5002');
  assert.equal(sources[1].url, 'https://t.me/durov/1001');
  assert.equal(sources.length, 5, 'добираем до пяти записей');
  for (const line of block.split('\n').slice(2)) {
    assert.match(line, SOURCE_LINE_RE, `строка источника не по формату: ${line}`);
  }
});

test('renderDigestSources: без ссылок модели блок собирается из топ-5 по просмотрам', () => {
  const { block, sources } = renderDigestSources(FEED, '## Просто текст\nбез ссылок вовсе');

  assert.equal(sources.length, 5);
  const views = sources.map((source) => (source.views === null ? -1 : source.views));
  assert.deepEqual(views, [...views].sort((a, b) => b - a), 'порядок по убыванию просмотров');
  assert.equal(sources[0].url, 'https://t.me/durov/1003', 'первым пост с 1,2 млн просмотров');
  assert.ok(block.includes('млн просмотров'), 'крупные просмотры читаются словами');
  assert.ok(block.includes('тыс. просмотров'));
  assert.ok(!block.includes('undefined'));
  assert.ok(!block.includes('NaN'));
});

test('renderDigestSources: дубликаты по ссылке не повторяются', () => {
  const modelText = 'https://t.me/durov/1001 и ещё раз https://t.me/durov/1001, и https://t.me/durov/1001';
  const { block, sources } = renderDigestSources(FEED, modelText);

  assert.equal(sources.filter((source) => source.url === 'https://t.me/durov/1001').length, 1);
  const urls = sources.map((source) => source.url);
  assert.equal(new Set(urls).size, urls.length, 'все ссылки уникальны');
  assert.equal((block.match(/https:\/\/t\.me\/durov\/1001/g) || []).length, 1);
});

test('renderDigestSources: пустой набор постов даёт пустой блок', () => {
  const empty = renderDigestSources([], '');
  assert.equal(empty.block, '');
  assert.deepEqual(empty.sources, []);
});

// ---------------------------------------------------------------------------
// Предохранитель транспортов: пауза после серии отказов
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 9, 9, 0, 0);

test('breaker: один отказ не открывает паузу, второй — открывает на 5 минут', () => {
  let state = normalizeBreaker(null);
  state = breakerFailure(state, 'bridge', { now: T0, error: 'timeout' });
  assert.equal(breakerView(state, T0 + 1).bridge.open, false, 'после одного отказа пробуем снова');

  state = breakerFailure(state, 'bridge', { now: T0 + 1000, error: 'timeout' });
  const view = breakerView(state, T0 + 2000).bridge;
  assert.equal(view.failures, 2);
  assert.equal(view.open, true);
  assert.equal(view.retryInMs, BREAKER_BASE_MS - 1000, 'пауза 5 минут от последнего отказа');
  assert.equal(breakerView(state, T0 + 2000).tme.open, false, 't.me это не касается');
});

test('breaker: пауза удваивается и упирается в час; успех снимает всё', () => {
  assert.equal(breakerCooldownMs(2), 5 * 60 * 1000);
  assert.equal(breakerCooldownMs(3), 10 * 60 * 1000);
  assert.equal(breakerCooldownMs(4), 20 * 60 * 1000);
  assert.equal(breakerCooldownMs(9), BREAKER_MAX_MS, 'дальше часа не растёт');

  let state = normalizeBreaker(null);
  for (let i = 0; i < 4; i += 1) state = breakerFailure(state, 'tme', { now: T0 + i * 1000 });
  assert.equal(breakerView(state, T0).tme.failures, 4);
  assert.equal(breakerView(state, T0 + 4000).tme.retryInMs, 20 * 60 * 1000 - 1000);

  state = breakerSuccess(state, 'tme', T0 + 5000);
  const view = breakerView(state, T0 + 5000).tme;
  assert.equal(view.failures, 0);
  assert.equal(view.open, false);
  assert.equal(view.lastOkAt, new Date(T0 + 5000).toISOString());
});

test('breakerPlan: больной транспорт выпадает, здоровый остаётся первым', () => {
  let state = normalizeBreaker(null);
  state = breakerFailure(state, 'bridge', { now: T0 });
  state = breakerFailure(state, 'bridge', { now: T0 });

  const plan = breakerPlan(['tme', 'bridge'], state, T0 + 1000);
  assert.deepEqual(plan.order, ['tme'], 'мост на паузе — в порядок не попадает');
  assert.equal(plan.waiting.length, 1);
  assert.equal(plan.waiting[0].kind, 'bridge');
  assert.equal(plan.openAll, false);
});

test('breakerPlan: оба на паузе — пустой порядок со сроком ожидания', () => {
  let state = normalizeBreaker(null);
  for (const kind of ['tme', 'bridge']) {
    state = breakerFailure(state, kind, { now: T0 });
    state = breakerFailure(state, kind, { now: T0 });
  }
  const plan = breakerPlan(['tme', 'bridge'], state, T0 + 1000);
  assert.deepEqual(plan.order, []);
  assert.equal(plan.openAll, true);
  assert.equal(plan.retryInMs, BREAKER_BASE_MS - 1000);
});

test('breakerPlan: явный порядок мост-первым уважается, пока мост здоров', () => {
  const state = normalizeBreaker(null);
  assert.deepEqual(breakerPlan(['bridge', 'tme'], state, T0).order, ['bridge', 'tme']);
});

test('breakerPlan: битый файл состояния не ломает план', () => {
  for (const broken of [null, 'мусор', [], { tme: { failures: 'много', until: 'скоро' } }]) {
    const view = breakerView(broken, T0);
    assert.equal(view.tme.open, false);
    assert.equal(view.bridge.open, false);
    assert.equal(typeof view.tme.retryInMs, 'number');
    assert.deepEqual(breakerPlan(['tme', 'bridge'], broken, T0).order, ['tme', 'bridge']);
  }
});

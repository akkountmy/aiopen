import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const DATA_DIR = process.env.DSHOW_DATA_DIR
  ? path.resolve(process.env.DSHOW_DATA_DIR)
  : path.join(ROOT, 'data');

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
/** Документы, приложенные к заданиям «Дашборда»: живут отдельно от проектов,
 *  чтобы смена проекта задания не теряла материалы. */
export const DASHBOARD_FILES_DIR = path.join(DATA_DIR, 'dashboard-files');
/** Скриншоты из окна «Поддержка»: лежат отдельно от проектов — обращение
 *  принадлежит человеку, а не папке, и не должно пропадать при удалении
 *  проекта. Доступ к файлу — только у автора и у администратора. */
export const SUPPORT_DIR = path.join(DATA_DIR, 'support');
/** Раздел «Телеграм»: каналы, посты (JSONL) и дайджесты. Живёт отдельно от
 *  индекса: лента растёт неограниченно, а index.json пишется целиком. */
export const TELEGRAM_DIR = path.join(DATA_DIR, 'telegram');
/** Реестры задания из харнесса (dsh-task-brief): один json на задание плюс
 *  человеческая копия .md. Отдельная папка — потому что это не файлы проектов
 *  и не переписка: реестр переживает и смену проекта, и удаление диалога. */
export const TASK_BRIEF_DIR = path.join(DATA_DIR, 'task-briefs');
/** Токен, которым харнесс присылает реестр (POST /api/tasks/briefs). Без него
 *  приём реестров закрыт: иначе любой желающий писал бы задания на доску. */
export const TASK_BRIEF_TOKEN = String(process.env.DSHOW_TASKS_TOKEN || '').trim();
/** Второй транспорт «Телеграма»: публичный JSON канала с моста TelegramRSS
 *  (https://tg.i-c-a.su). Нужен там, где контейнер не пускает t.me напрямую.
 *  Пустое значение в DSHOW_TG_BRIDGE отключает мост, оставляя только t.me. */
export const TELEGRAM_BRIDGE = String(process.env.DSHOW_TG_BRIDGE ?? 'https://tg.i-c-a.su')
  .trim()
  .replace(/\/+$/, '');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const INDEX_FILE = path.join(DATA_DIR, 'index.json');

export const HOST = process.env.DSHOW_HOST || '127.0.0.1';
export const PORT = Number(process.env.DSHOW_PORT || 3123);

/** За обратным прокси (Amvera и подобные) реальный IP приходит в X-Forwarded-For. */
export const TRUST_PROXY = process.env.DSHOW_TRUST_PROXY === '1';

/** Уровень контекста: средний. Значения можно переопределить окружением —
 *  это удобно для тестов и для тонкой настройки облака без правки кода. */
export const CONTEXT = {
  profile: 'medium',
  /* Сколько истории уходит в модель. Большая задача — это десятки шагов с
     файлами и расчётами, поэтому запас нужен приличный; лишнее отрезается
     между шагами, чтобы модель не упёрлась в окно контекста. */
  historyTokens: Number(process.env.DSHOW_HISTORY_TOKENS || 60000),
  toolResultChars: 12000,
  summaryChars: 2200,
  keepRecentMessages: Number(process.env.DSHOW_KEEP_RECENT || 10),
  /* Шагов до мягкого продолжения: дальше агент сам получает «продолжай» и
     работает, вместо того чтобы остановиться и спросить человека. */
  maxSteps: Number(process.env.DSHOW_MAX_STEPS || 40),
  /* Сколько таких отрезков разрешено на одну задачу. 40 × 24 = 960 шагов —
     вдвое больше прежнего: долгая работа не должна упираться в счётчик, а
     зацикливание всё равно останавливается и подводит итог. */
  maxSegments: Number(process.env.DSHOW_MAX_SEGMENTS || 24),
  maxOutputTokens: 16000,
  /* Обрезка результатов инструментов и автосжатие истории (аналог плагина
     dsh-trim из локального харнесса). Малые ответы не трогаем вовсе, крупные
     детерминированно сжимаем, а то, что не влезло, выгружаем в файл проекта
     `.trims/…`, чтобы модель могла открыть его read_file. */
  trim: {
    compactAboveChars: Number(process.env.DSHOW_TRIM_ABOVE || 1200),
    maxInlineChars: Number(process.env.DSHOW_TRIM_INLINE || 8000),
    headChars: 3200,
    tailChars: 2200,
    adaptive: process.env.DSHOW_TRIM_ADAPTIVE !== '0',
    adaptivePressureTokens: Number(process.env.DSHOW_TRIM_PRESSURE || 20000),
    keepDiffContextLines: 2,
    minShrinkRatio: 0.05,
    spillDir: '.trims',
    maxSpillFiles: 60,
    minHistoryChars: 2500,
  },
  /* Хранение контекста без срока. Раньше контекст «старел»: задача, прерванную
     больше недели назад, сервис автоматически не подхватывал, и работа
     человека пропадала из-за одной даты. Теперь переписка и незаконченные
     задачи остаются навсегда, а чтобы давний диалог не стоил полного окна
     токенов, раз в месяц (30 дней) давно не тронутая история сворачивается в
     конспект: старые реплики уходят файлом в `.history/`, в памяти диалога
     остаются последние и сводка. Сжимаем только то, что и правда раздулось:
     диалог ниже `staleTokens` не трогаем вовсе. */
  retain: {
    compactAfterDays: Number(process.env.DSHOW_CONTEXT_COMPACT_DAYS || 30),
    staleTokens: Number(process.env.DSHOW_CONTEXT_STALE_TOKENS || 8000),
    keepRecent: Number(process.env.DSHOW_CONTEXT_KEEP_RECENT || 12),
    memoryChars: Number(process.env.DSHOW_CONTEXT_MEMORY_CHARS || 2200),
  },
};

/**
 * Маршрутизация модели по сложности задачи: короткий вопрос идёт на быстрой
 * модели, аудит, финмодель, ресёрч и сборка документов — на сильной с
 * максимальным усилием рассуждения. Порог и профили переопределяются
 * окружением, поэтому на облаке можно поднять планку без пересборки.
 */
export const ESCALATION = {
  enabled: process.env.DSHOW_ESCALATE !== '0',
  /* Сколько баллов сложности нужно, чтобы включить сильный профиль. */
  threshold: Number(process.env.DSHOW_ESCALATE_AT || 3),
  /* Какие модели использовать. Пустое значение pro — работаем на одной. */
  flashModel: process.env.DSHOW_MODEL || 'deepseek-flash',
  /* id сильной модели из каталога шлюза. Раньше здесь стояло «deepseek-pro» —
     такого id шлюз не знает (400 «supported API model names are deepseek-flash,
     deepseek-v4-pro»), и откат в callModel тихо подменял сильную модель
     быстрой: эскалация была декоративной. */
  proModel: process.env.DSHOW_MODEL_PRO || 'deepseek-v4-pro',
  flashEffort: process.env.DSHOW_EFFORT || 'high',
  proEffort: process.env.DSHOW_EFFORT_PRO || 'max',
  /* Сложная задача остаётся на сильной модели до конца хода: не мигаем
     профилем на каждом шаге и не платим дважды за разбор одного и того же. */
  stick: process.env.DSHOW_ESCALATE_STICK !== '0',
};

/**
 * Распределение шагов между двумя моделями внутри одного хода.
 *
 * Профиль хода (flash или pro) выбирается по сложности задачи один раз. Но шаги
 * хода неравноценны: чтение и поиск — механика, а вот разбор того, что пришло
 * из файла на десять тысяч знаков, ошибка в инструменте или расчёт — это ровно
 * та работа, где сильная модель окупается. Поэтому следующий шаг уходит на pro,
 * когда предыдущий принёс много данных, упал или работал «умным» инструментом,
 * и возвращается на профиль хода, когда механика продолжилась.
 *
 * Обратное направление (сильная модель → быстрая на механике внутри тяжёлого
 * хода) выключено по умолчанию: там риск потерять качество больше экономии.
 * Включается явно: DSHOW_SPLIT_GRIND=1.
 */
export const SPLIT = {
  enabled: process.env.DSHOW_SPLIT !== '0',
  /* Порог «пришли данные»: столько знаков результата инструментов на прошлом
     шаге, после которого разбор отдаём сильной модели. */
  dataChars: Math.max(200, Number(process.env.DSHOW_SPLIT_DATA_CHARS || 2500)),
  /* Отдельный порог для веб-страниц. Текст статьи — материал для пересказа и
     цитат, а не выгрузка с числами: одна страница (у fetch_url потолок 24 000
     знаков) остаётся на модели хода, а сильная берётся, только когда пришёл
     целый корпус — несколько страниц или обход сайта. Те же знаки. */
  webChars: Math.max(1000, Number(process.env.DSHOW_SPLIT_WEB_CHARS || 24_000)),
  /* Разрешить отдавать повторную механику сильной модели на быстрой. */
  grind: process.env.DSHOW_SPLIT_GRIND === '1',
  /* Сколько механических шагов подряд считаем «перекладыванием». */
  grindAfter: Math.max(1, Number(process.env.DSHOW_SPLIT_GRIND_AFTER || 2)),
};

/**
 * Финальный ревью-пасс: перед выдачей ответа модель сверяет цифры и файлы с
 * тем, что реально вернули инструменты. Это защита от выдуманных сумм и
 * «красивого, но пустого» документа — самая частая претензия к длинным ответам.
 */
export const REVIEW = {
  enabled: process.env.DSHOW_REVIEW !== '0',
  /* Ниже этого размера ответа проверять нечего: короткие ответы пишутся по
     фактам из того же контекста и не стоят лишнего вызова. */
  minAnswerChars: Number(process.env.DSHOW_REVIEW_MIN || 600),
  /* Сколько знаков выжимки результатов даём проверяющему: ему нужны цифры,
     а не весь текст страниц. */
  digestChars: Number(process.env.DSHOW_REVIEW_DIGEST || 9000),
  /* Правка ответа моделью — только когда найдены серьёзные расхождения. */
  fix: process.env.DSHOW_REVIEW_FIX !== '0',
  /* Сколько раз разрешено править ответ. Второй круг нужен, когда первая
     правка сама внесла новые числа без опоры: раньше такой ответ просто
     отбрасывался, и человек получал исходный — с той же ошибкой, из-за
     которой правка и начиналась. */
  fixRounds: Math.max(1, Number(process.env.DSHOW_REVIEW_FIX_ROUNDS || 2)),
  maxIssues: 12,
  /* Сколько источников (адрес + год) видит проверяющий: больше — уже не
     проверка, а второй ресёрч. */
  sources: 12,
  /* Проверяющий на другой модели. Одна и та же модель повторяет свои слепые
     зоны: если задача шла на быстрой, ответ проверяет сильная (и наоборот она
     же, если задача уже шла на сильной). Пусто — проверяем той же моделью.
     Явное значение DSHOW_REVIEW_MODEL сильнее автоматики. */
  model: process.env.DSHOW_REVIEW_MODEL || '',
  /* Сколько знаков выдержки из каждого готового файла видит проверяющий:
     имя файла он и так знает, а тему и итоги документа — нет. */
  excerptChars: Number(process.env.DSHOW_REVIEW_EXCERPT || 700),
  excerptFiles: 3,
};

/**
 * Состояние задачи: между отрезками длинной работы модель получает не голое
 * «продолжай», а короткий структурированный перечень — что сделано, что
 * осталось, какие файлы готовы. Состояние переживает отрезки и ходы.
 */
export const TASK_STATE = {
  enabled: process.env.DSHOW_TASK_STATE !== '0',
  /* Сколько пунктов в каждом списке держим: больше — уже не состояние, а лог. */
  maxItems: 8,
  /* Бюджет вставки в подсказку. */
  promptChars: 1400,
};

/** Бюджет системного сообщения. Считаем знаки, а не токены: так рост подсказки
 *  видно сразу, без обращения к модели и без счёта денег.
 *  Прежний предел 12 000 исчерпывался до последнего знака (11 991), поэтому
 *  каждая новая строка роняла сборку. Лимит 13 000 тоже стал тесным: блок аудита
 *  с экспертных режимов доводил подсказку до 13 131 знака. 14 000 оставляют
 *  запас и на экспертные блоки, и на новые правила: тест проверяет и то, что
 *  мы влезаем, и то, что свободный остаток не меньше reserveChars.
 *  Лимит 19 500 (27.10.2026) — под переписанный блок веб-дизайна: он один
 *  занимает 5 462 знака, потому что без дизайн-системы, глубины содержания,
 *  технических критериев и самопроверки слабый лендинг и получается. Замеры:
 *  лендинг 17 150 знаков, «лендинг и финмодель» (два блока) — 18 071,
 *  финансы одни — 12 609. Тест держит и предел, и свободный остаток.
 *  Лимит 21 000 (11.11.2026) — под каталог навыков: 26 PM-навыков добавили
 *  4 564 знака (каталог 10 889 → 15 453), и самый тяжёлый случай — лендинг —
 *  вырос до 19 467 при прежнем пределе 19 500, то есть запас под новые правила
 *  кончился (33 знака вместо 1 200). Замеры после подъёма: лендинг 19 467,
 *  финансы 16 087, обычный вопрос 14 054; свободно 1 533. Дальше растить
 *  каталог молча нельзя: следующий шаг — сжимать описания навыков, а не
 *  поднимать предел. */
export const PROMPT_BUDGET = {
  limitChars: 21000,
  reserveChars: 1200,
};

const MB = 1024 * 1024;

/** Сколько ОЗУ дал тариф: cgroup v2, затем v1. null — не контейнер (ноутбук). */
function containerMemoryMb() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!/^\d+$/.test(raw)) continue;
      const mb = Math.round(Number(raw) / MB);
      /* Больше терабайта — это «без лимита» на хосте, а не тариф. */
      if (mb > 0 && mb < 1024 * 1024) return mb;
    } catch {
      /* файла нет — значит не cgroup-контейнер */
    }
  }
  return null;
}

/** Потолок памяти процесса по умолчанию: 75 % ОЗУ контейнера (на 500 МБ это
 *  375 МБ), чтобы сервис начал вежливо отказывать раньше OOM-убийцы. Вне
 *  контейнера — прежние 1536 МБ: на ноутбуке это просто предохранитель.
 *  Раньше потолок был всегда 1536 МБ, и на тарифе в 500 МБ он не срабатывал
 *  вовсе: процесс убивала платформа, забирая чужие диалоги. */
function defaultMaxRssMb() {
  const container = containerMemoryMb();
  if (!container) return 1536;
  return Math.min(1536, Math.max(256, Math.round((container * 0.75) / 8) * 8));
}

/** Целое из окружения: не задано или мусор — берём запасное значение.
 *  Отдельная функция, потому что нужна выше, чем общий count (он объявлен
 *  ниже и до этого места ещё не существует). */
function envCount(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const LIMITS = {
  jsonBody: 8 * MB,
  uploadBody: 160 * MB,
  maxAttachmentBytes: Number(process.env.DSHOW_MAX_ATTACHMENT_MB || 128) * MB,
  /** Не принимать файлы, если на диске останется меньше этого запаса. */
  minFreeBytes: Number(process.env.DSHOW_MIN_FREE_MB || 64) * MB,
  /** Файлы крупнее этого не разбираем в память — только сохраняем и предупреждаем. */
  maxParseBytes: Number(process.env.DSHOW_MAX_PARSE_MB || 32) * MB,
  maxFileTextChars: 200000,
  maxAttachmentsPerMessage: 24,
  attachmentsContextChars: 60000,
  /** Сколько ответов может идти одновременно у одного аккаунта. По умолчанию
   *  три: человек с ноутбуком, телефоном и планшетом работает спокойно, но
   *  двадцать открытых вкладок не выедают все места сервиса у остальных.
   *  0 — без ограничений (так было раньше). Внутри одного диалога всегда ровно
   *  один ответ — иначе сообщения перепутаются. Меняется DSHOW_RUNS_PER_USER. */
  agentConcurrencyPerUser: envCount(process.env.DSHOW_RUNS_PER_USER, 3),
  pythonTimeoutMs: 60000,
  /* Ожидание ответа чужого сайта. Меняется DSHOW_FETCH_TIMEOUT_S: на медленных
     каналах 30 секунд мало, а на общем сервисе больше минуты вредит — запрос
     держит место в счётчике тяжёлых задач. */
  fetchTimeoutMs: envCount(process.env.DSHOW_FETCH_TIMEOUT_S, 30) * 1000,
  transcribeBody: 24 * MB,
  proofreadChars: 24000,
  /** Обращение в поддержку: текст и скриншот. Скриншот приходит в JSON как
   *  data-URL уже сжатым на клиенте (JPEG, длинная сторона ~1600 px), поэтому
   *  серверный предел считаем по готовому файлу, а не по исходной картинке. */
  supportTextChars: 4000,
  supportScreenshotBytes: 4 * MB,
  supportContactChars: 200,
};

/**
 * Запас прочности сервиса под одновременную работу людей.
 *
 * Считаем не «сколько пользователей зарегистрировано», а сколько ответов
 * агента может идти ОДНОВРЕМЕННО, не выедая память контейнера: каждый живой
 * ответ держит историю диалога, а инструменты могут поднять Chromium (сотни
 * мегабайт) или Python.
 *
 * Откуда 24. Замер `test/load-50.mjs` (24 прогона разом, заглушка модели):
 * процесс держит 250 МБ на холостом ходу и прибавляет 4–6 МБ на живой прогон,
 * то есть 24 прогона — это ~400 МБ плюс запас на тяжёлые инструменты, которые
 * отдельно ограничены тремя (Chromium). Потолок памяти 1536 МБ остаётся
 * жёстким тормозом: он срабатывает раньше, чем OOM-убийца контейнера.
 * Пятьдесят человек, у каждого до трёх задач, одновременно в один контейнер
 * не влезают физически — 150 прогонов это гигабайты; поэтому 24 места сразу,
 * остальное встаёт в очередь ожидания и получает ответ по мере освобождения.
 *
 * Числа меняются переменными окружения, потому что тариф хостинга поднимают
 * без правки кода.
 */
export const CAPACITY = {
  /** Сколько ответов агента идёт одновременно во всём сервисе. 0 — без предела. */
  maxRuns: envCount(process.env.DSHOW_MAX_RUNS, 24),
  /** Сколько из них может занимать один аккаунт (см. LIMITS выше). */
  runsPerUser: envCount(process.env.DSHOW_RUNS_PER_USER, 3),
  /** Сколько ждём свободного места, прежде чем честно ответить «занято».
   *  Минута: большинство ответов короче, и человек дождётся, не нажимая
   *  «отправить» заново. 0 — не ждать вовсе. */
  runWaitMs: envCount(process.env.DSHOW_RUN_WAIT_S, 60) * 1000,
  /** Сколько запросов может одновременно стоять в ожидании места. Больше —
   *  отказ сразу: бесконечная очередь съедает память и ничего не ускоряет.
   *  120 — это наплыв полусотни человек по две-три задачи: место ждут, а не
   *  получают отказ на первой же секунде. Ждущий запрос стоит один сокет,
   *  а не прогон, поэтому очередь дешевле отказа. */
  maxWaiting: envCount(process.env.DSHOW_MAX_WAITING_RUNS, 120),
  /** Потолок времени на одну задачу. Счётчики шагов не спасают от зависшего
   *  HTTP-соединения к модели: без часов задача держит место вечно, а диалог
   *  навсегда считается занятым. 45 минут — выше любой нормальной работы и
   *  ниже терпения человека. DSHOW_RUN_MAX_MIN=0 — без потолка. */
  runMaxMs: envCount(process.env.DSHOW_RUN_MAX_MIN, 45) * 60 * 1000,
  /** Сколько ждём ответа модели на одном шаге (первый байт и весь поток).
   *  Зависшее соединение рвём и повторяем, а не ждём до утра. */
  modelTimeoutMs: envCount(process.env.DSHOW_MODEL_TIMEOUT_S, 300) * 1000,
  /** Потолок сообщений одного аккаунта за 10 минут. Это защита от программной
   *  очереди в сотни задач, а не от живой работы: вдумчивый человек столько не
   *  напишет, а «нажму сорок раз» перестаёт топить остальных. */
  messagesPerUser: envCount(process.env.DSHOW_MESSAGES_PER_10MIN, 60),
  /** Сколько одновременно тяжёлых инструментов (браузер, Python, распаковка)
   *  может работать в процессе. Один Chromium на десять задач — это OOM. */
  heavyTools: envCount(process.env.DSHOW_HEAVY_TOOLS, 3),
  /** Сколько страниц одновременно тянет краулер внутри одного вызова. */
  crawlConcurrency: envCount(process.env.DSHOW_CRAWL_CONCURRENCY, 2),
  /** Потолок времени на один сетевой инструмент (краулер, обход сайта):
   *  иначе «Стоп» не действует, а место в очереди занято. */
  toolDeadlineMs: envCount(process.env.DSHOW_TOOL_DEADLINE_S, 120) * 1000,
  /** Потолок памяти процесса: выше него новые задачи не начинаем, а честно
   *  говорим «занято». Один прогон с браузером и Python добавляет сотни
   *  мегабайт, и раньше единственным ограничением был OOM-убийца контейнера:
   *  он забирает весь сервис вместе с чужими диалогами. 0 — без предела.
   *  По умолчанию — 75 % ОЗУ контейнера (см. defaultMaxRssMb выше). */
  maxRssMb: envCount(process.env.DSHOW_MAX_RSS_MB, defaultMaxRssMb()),
  /** Через сколько секунд безжизненной очереди событий сервис перезапускают
   *  сами. Зависший процесс хуже перезапуска: он держит соединения и молчит.
   *  0 — сторож выключен (только строка [beat] останется). */
  watchdogSec: envCount(process.env.DSHOW_WATCHDOG_S, 180),
  /** Жёсткий сторож: поток, который замечает, что главный поток молчал дольше
   *  этого времени, и пишет след в журнал. Мягкий сторож живёт таймером в
   *  главном потоке и против синхронной блокировки бесполезен — а именно так
   *  сервис и умирал 4 ноября: последняя строка [beat], двадцать минут тишины,
   *  статус RUNNING. 0 — выключен. */
  hardWatchdogSec: envCount(process.env.DSHOW_HARD_WATCHDOG_S, 240),
  /** Что делать, когда главный поток встал: 'log' — только строка в журнал
   *  (по умолчанию), 'kill' — завершить процесс. 'kill' опасен: проверено
   *  в облаке 4 ноября — контейнер после SIGKILL не поднимается, поэтому
   *  зависание превращается в такую же тишину, только без следа в журнале.
   *  Аварию закрывает внешний сторож scripts/health-guard.mjs. */
  hardWatchdogAction: (process.env.DSHOW_HARD_WATCHDOG_ACTION || 'log').trim(),
  /** Продолжать ли задачи, прерванные перезапуском, без человека.
   *  DSHOW_AUTO_RESUME=0 выключает автопродолжение: нужно, когда конкретная
   *  задача сама роняет сервис — тогда каждое поднятие снова берётся за неё.
   *  Читается только здесь: одно место — один писатель правила (в сервисе
   *  раньше проверялось прямо из process.env, и выключенное продолжение никак
   *  не было видно в журнале). */
  autoResume: process.env.DSHOW_AUTO_RESUME !== '0',
};

/* Срок жизни входа можно задать переменной окружения — это нужно и облаку,
   и проверкам, которые не могут ждать месяц. */
function sessionDaysFromEnv(value, fallback) {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 24 * 60 * 60 * 1000;
}

/* Сколько живёт вход. Срок скользящий: пока человек заходит, он продлевается и
   на сервере, и в браузере (см. currentUser в server.mjs). Тридцать дней — это
   «открыл ярлык через месяц отпуска и остался внутри»; раньше было семь, и
   у приложения с домашнего экрана ровно через неделю просили пароль. */
export const SESSION = {
  cookie: 'dshow_session',
  ttlMs: sessionDaysFromEnv(process.env.DSHOW_SESSION_DAYS, 30),
  sliding: true,
};

/* Аккаунт держит сколько угодно живых сеансов одновременно: ноутбук, браузер
   телефона, ярлык-приложение с домашнего экрана и ещё десяток вкладок
   работают параллельно и друг друга не выбивают. Ниже — пороги, по которым
   администратор узнаёт о подозрительных входах. */
const hours = (value, fallback) => {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60 * 60 * 1000;
};

const count = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const DEVICE = {
  cookie: 'dshow_device',
  cookieMs: 400 * 24 * 60 * 60 * 1000,
  /* Окно, за которое считаем устройства и адреса. */
  windowMs: hours(process.env.DSHOW_DEVICE_WINDOW_HOURS, 24),
  /* Сколько храним историю входов (для разбора и показа в панели). */
  keepMs: 14 * 24 * 60 * 60 * 1000,
  maxEvents: 200,
  /* Порог подозрения: столько разных устройств / адресов за окно. */
  alertDevices: Number(process.env.DSHOW_ALERT_DEVICES || 3),
  alertIps: Number(process.env.DSHOW_ALERT_IPS || 4),
  /* Сколько раз за окно у пользователя выбивали активный сеанс новым входом. */
  alertDisplaced: Number(process.env.DSHOW_ALERT_DISPLACED || 3),
  /* Не чаще одного сообщения в столько часов на аккаунт. */
  cooldownMs: hours(process.env.DSHOW_ALERT_COOLDOWN_HOURS, 12),
  /* Сколько живёт пометка «сеанс закрыт новым входом» — чтобы старый браузер
     показал понятное объяснение вместо пустого экрана входа. */
  kickedTtlMs: 30 * 60 * 1000,
  /* Сколько живых сеансов человек может держать одновременно. 0 — без
     ограничений: один ник и пароль работают на любом числе устройств, вкладок
     и ярлыков одновременно, и никто ни у кого место не отбирает. Внутри одной
     машины новый вход по-прежнему заменяет прежний сеанс этой же машины —
     иначе старые вкладки продолжали бы жить со своей копией сессии.
     Ограничение можно вернуть явно: DSHOW_SESSIONS_MAX=3. */
  maxSessions: count(process.env.DSHOW_SESSIONS_MAX, 0),
};

/** Классы устройств — нужны для истории входов и для ярлыка, а не для выбивания. */
export const DEVICE_KINDS = ['desktop', 'mobile', 'app'];

/** Сколько сеансов одного аккаунта разрешено держать активными.
 *  `Infinity` — мест не считаем вовсе (штатный режим, см. `maxSessions`). */
export function sessionLimit() {
  const value = DEVICE.maxSessions;
  return Number.isInteger(value) && value >= 1 ? value : Infinity;
}

export const SECURITY = {
  loginWindowMs: 10 * 60 * 1000,
  loginMaxPerIp: 12,
  loginMaxPerUser: 6,
  passwordMinLength: 8,
  scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
};

/* Свободная регистрация: по умолчанию выключена, включается DSHOW_OPEN_SIGNUP=1.
   Пока выключена, аккаунты создаёт только администратор. */
export const SIGNUP = {
  open: process.env.DSHOW_OPEN_SIGNUP === '1',
  maxPerIpPerHour: Number(process.env.DSHOW_SIGNUP_PER_HOUR || 3),
};

/** Служебная модель. Наружу (в интерфейс) не выводится. */
export const MODEL = {
  baseURL: process.env.DSHOW_MODEL_BASE || 'https://api.deepseek.com',
  name: process.env.DSHOW_MODEL || 'deepseek-flash',
  effort: process.env.DSHOW_EFFORT || 'high',
  visionFallback: true,
};

/**
 * Оценка стоимости работы модели — только для внутреннего учёта и предупреждений.
 * Наружу ни цена, ни модель не показываются.
 */
export const PRICING = {
  inputPerM: Number(process.env.DSHOW_PRICE_IN || 0.28),
  outputPerM: Number(process.env.DSHOW_PRICE_OUT || 0.42),
};

export function costUsd(tokensIn = 0, tokensOut = 0) {
  const inCost = (Number(tokensIn) || 0) / 1e6 * PRICING.inputPerM;
  const outCost = (Number(tokensOut) || 0) / 1e6 * PRICING.outputPerM;
  return inCost + outCost;
}

/**
 * Сколько списывается с баланса пользователя. Считается всегда по «часу пик»
 * (это и есть цена из PRICING) с внутренним коэффициентом. Коэффициент, как и
 * сами цены, наружу не выводится: ни в интерфейсе, ни в ответах ассистента.
 */
export const BILLING = {
  multiplier: Number(process.env.DSHOW_BILL_MULTIPLIER || 2),
  /** Стартовый баланс старых пользователей при первом включении счётчика. */
  migrationCreditUsd: Number(process.env.DSHOW_START_CREDIT_USD || 20),
};

export function chargeUsd(tokensIn = 0, tokensOut = 0) {
  const raw = costUsd(tokensIn, tokensOut) * (Number.isFinite(BILLING.multiplier) ? BILLING.multiplier : 2);
  return Number(raw.toFixed(6));
}

/**
 * Порог «тяжёлой» задачи: стоимость ОДНОЙ задачи. Пока задача дешевле порога,
 * она идёт молча, в фоне, без уведомлений. Когда перевалила — работа
 * приостанавливается, пользователь получает предупреждение, а администратор
 * запрос на подтверждение. Порог — $10 на задачу: этого хватает на большой
 * проект (десятки документов и страниц), и до него ничего согласовывать не
 * нужно. Смысл именно в дорогих задачах, а не в накопленном расходе проекта:
 * сотня мелких задач не должна упираться в лимит.
 */
function usdFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const BUDGET = {
  limitUsd: usdFromEnv('DSHOW_TASK_LIMIT_USD', 10),
  /** Сколько добавляется к порогу после одобрения администратора. */
  stepUsd: usdFromEnv('DSHOW_TASK_STEP_USD', 10),
};

/**
 * Порог для одной задачи с учётом того, что администратор уже разрешил.
 * Одобрение может только ПОДНЯТЬ порог: крошечные значения, оставшиеся от
 * ранних версий (например, $0.0005 в старых проектах), не опускают его до нуля —
 * иначе дешёвая задача сразу упирается в «лимит $0.00» и уходит на подтверждение.
 */
export function taskLimitUsd(storedBudgetUsd) {
  const stored = Number(storedBudgetUsd);
  return Number.isFinite(stored) && stored > BUDGET.limitUsd ? stored : BUDGET.limitUsd;
}

/** Уведомления администратору в Telegram (бот «Василина»). */
export const TELEGRAM = {
  token: process.env.DSHOW_TG_TOKEN || '',
  chatId: process.env.DSHOW_TG_CHAT || '660339011',
  publicUrl: process.env.DSHOW_PUBLIC_URL || 'https://dshopen-vladimir00177.msk1.amvera.tech',
};

/**
 * Цепочка бесплатных визуальных моделей для распознавания изображений.
 * Используется только на стороне сервера.
 */
export const VISION = {
  baseURL: 'https://openrouter.ai/api/v1',
  timeoutMs: 45000,
  totalBudgetMs: 100000,
  attemptsPerModel: 2,
  maxTokens: 3000,
  maxImageBytes: 8 * 1024 * 1024,
  models: [
    'dots-studio/dots-3-note-preview:free',
    'qwen/qwen3.8-27b:free',
    'inclusionai/ling-3.0-flash-vl',
    'google/gemini-2.5-flash',
    'google/gemma-3-12b-it',
  ],
};

export const ADMIN = {
  username: process.env.DSHOW_ADMIN_USER || 'DSH',
  password: process.env.DSHOW_ADMIN_PASSWORD || '',
  displayName: 'Администратор',
};

/**
 * Распознавание речи. Как и визуальные модели — только на сервере.
 *
 * Модели запускаются наперегонки (см. `src/asr.mjs`), поэтому порядок здесь —
 * это не очередь, а список участников: ответ берётся от первой успешной.
 * Повторных попыток на модель нет: гонка сама по себе надёжнее повтора.
 */
export const ASR = {
  baseURL: 'https://openrouter.ai/api/v1',
  timeoutMs: 45000,
  maxTokens: 1600,
  maxAudioBytes: 16 * 1024 * 1024,
  models: [
    'google/gemini-2.5-flash-lite',
    'mistralai/voxtral-small-24b-2507',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ],
};

export function ensureDirs() {
  for (const dir of [DATA_DIR, WORKSPACES_DIR, CHATS_DIR, UPLOADS_DIR, LOGS_DIR, DASHBOARD_FILES_DIR, SUPPORT_DIR, TELEGRAM_DIR, TASK_BRIEF_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function dataHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

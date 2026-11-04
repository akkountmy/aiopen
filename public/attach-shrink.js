/* --------------------- сжатие вложений перед отправкой ---------------------
   Требование (задача #16 от 02.11.2026): если человек прикрепляет файл больше
   0,7 МБ, перед отправкой в модель он должен сжиматься — чтобы загрузка шла
   быстрее, модель тратила меньше токенов, а файл занимал меньше места.

   Где сжимаем и почему именно там:
   • В браузере, до отправки на сервер. Тогда экономится и трафик человека (на
     телефоне это мобильный интернет), и место на диске сервера, и время разбора.
   • Не на сервере: там нет ни sharp, ни canvas, а рисовать картинку headless-
     Chrome ради каждого вложения на 0,1 CPU — дороже, чем весь остальной разбор.
   • Работает одинаково во всех версиях интерфейса: телефоне, планшете,
     компьютере и в установленном приложении — это один и тот же app.js.

   Что сжимаем:
   • Изображения (JPEG/PNG/WebP/BMP): перекодируем в WebP (или JPEG, если
     браузер WebP не умеет), длинную сторону ограничиваем 1600 px, качество
     подбираем лестницей от 0,9 вниз — берём лучшее качество, которое укладывается
     в 0,7 МБ. Для фото 4–8 МБ это обычно 250–500 КБ без потери читаемости.
     Порог 1600 px выбран и под токены: распознавалка всё равно ужимает картинку
     под свои тайлы, а лишние пиксели оплачиваются токенами.
   • GIF, SVG, HEIC/HEIF, AVIF, TIFF не трогаем: у первых двух canvas теряет
     анимацию и вектор, остальные браузер часто не умеет декодировать.
   • Документы (PDF, DOCX, XLSX и прочее) не сжимаем побайтово: они уже сжаты
     внутри (zip/deflate), повторное сжатие даёт единицы процентов и ломает
     формат. Экономия токенов для них достигается другим путём — сервер вынимает
     из документа текст и отдаёт модели текст, а не двоичный файл.
   • Архивы (zip/7z) — то же самое: уже сжаты.

   Файл подключается отдельным скриптом, чтобы логику можно было проверить в
   node без запуска всего интерфейса (test/attach-shrink.mjs). */
(function (root) {
  'use strict';

  /* Порог из требования: файлы не больше этого не трогаем совсем. */
  const LIMIT_BYTES = 700 * 1024;
  /* Длинная сторона после сжатия. Меньше — мельче текст на скриншотах. */
  const MAX_SIDE = 1600;
  /* Ниже этого не опускаемся даже если файл всё ещё больше 0,7 МБ: читаемость
     важнее; такой файл уйдёт как есть, и сервер скажет о размере честно. */
  const MIN_SIDE = 640;
  /* Лестница качества: от «почти без потерь» к «заметно, но читаемо». */
  const QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
  /* Типы, которые canvas испортит или не декодирует. */
  const SKIP = /^image\/(gif|svg\+xml|avif|heic|heif|tiff|bmp)$/i;
  /* Больше 40 Мпикс не декодируем целиком: на телефоне это упирается в память. */
  const MAX_PIXELS = 40 * 1000 * 1000;

  /** Нужно ли вообще сжимать этот файл: решается по размеру и типу. */
  function shouldShrink({ size = 0, type = '' } = {}) {
    if (!(size > LIMIT_BYTES)) return false;
    return /^image\//i.test(String(type)) && !SKIP.test(String(type));
  }

  /**
   * План попыток: пары «длинная сторона + качество», от лучшего качества к худшему.
   * Считается отдельно от рисования, чтобы это можно было проверить тестом.
   * width/height — размеры исходника, чтобы не увеличивать маленькие картинки.
   */
  function planAttempts(width, height) {
    const longest = Math.max(1, Math.max(width, height));
    const steps = [];
    for (const side of [Math.min(MAX_SIDE, longest), 1280, 1024, 800, MIN_SIDE]) {
      for (const quality of QUALITIES) {
        steps.push({ side, quality });
      }
    }
    /* Убираем повторы (для маленьких картинок несколько «сторон» — одно и то же). */
    const seen = new Set();
    return steps.filter((step) => {
      const key = `${step.side}:${step.quality}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Размеры холста для шага: масштабируем по длинной стороне, не увеличивая. */
  function scaledSize(width, height, side) {
    const longest = Math.max(width, height) || 1;
    const scale = Math.min(1, side / longest);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /** Человеческая подпись экономии: «3,4 МБ → 0,4 МБ (−88 %)». */
  function formatNote(from, to) {
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
    const saved = from > 0 ? Math.round((1 - to / from) * 100) : 0;
    return `${mb(from)} → ${mb(to)} (−${saved} %)`;
  }

  /** Какое расширение и тип отдать браузеру: WebP, если он его умеет. */
  function pickFormat() {
    try {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      // Safari до 14 не умеет WebP; тогда честно уходим в JPEG.
      return probe.toDataURL('image/webp').startsWith('data:image/webp')
        ? { mime: 'image/webp', ext: '.webp' }
        : { mime: 'image/jpeg', ext: '.jpg' };
    } catch {
      return { mime: 'image/jpeg', ext: '.jpg' };
    }
  }

  /** Декодирует файл в ImageBitmap; при отсутствии API — через <img>. */
  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        // imageOrientation: 'from-image' — иначе фото с телефона приезжает боком.
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        /* ниже общий путь */
      }
      try {
        return await createImageBitmap(file);
      } catch {
        /* ниже общий путь */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('не удалось прочитать изображение'));
        el.src = url;
      });
      return { width: img.naturalWidth, height: img.naturalHeight, source: img };
    } finally {
      // Освобождаем сразу после отрисовки: держать URL незачем.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  /** Рисует кандидата нужного размера и кодирует его в blob. */
  function encode(bitmap, width, height, mime, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: mime !== 'image/jpeg' });
    if (!ctx) return Promise.reject(new Error('нет 2d-контекста'));
    // Фон для JPEG: прозрачные PNG иначе получают чёрные поля.
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap.source || bitmap, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  }

  /** Переименовывает файл под новый формат, сохраняя читаемое имя. */
  function renameTo(name, ext) {
    const base = String(name || 'файл').replace(/\.[^.]+$/, '');
    return `${base}${ext}`;
  }

  /**
   * Сжимает файл. Возвращает { file, changed, from, to, note }.
   * Никогда не бросает исключение наружу: если сжатие не удалось, отдаём исходный
   * файл — прикрепить его важнее, чем сэкономить байты.
   */
  async function shrink(file, { limitBytes = LIMIT_BYTES } = {}) {
    const from = file?.size || 0;
    const result = { file, changed: false, from, to: from, note: '' };
    if (!file || !shouldShrink(file)) return result;

    let bitmap = null;
    try {
      bitmap = await decode(file);
      const width = bitmap.width || 0;
      const height = bitmap.height || 0;
      if (!width || !height) return result;
      if (width * height > MAX_PIXELS) return result;

      const format = pickFormat();
      let best = null;      // самый маленький из полученных
      for (const step of planAttempts(width, height)) {
        const size = scaledSize(width, height, step.side);
        let blob = null;
        try {
          blob = await encode(bitmap, size.width, size.height, format.mime, step.quality);
        } catch {
          blob = null;
        }
        if (!blob || !blob.size) continue;
        if (!best || blob.size < best.size) best = blob;
        // Первый, кто уложился в порог, — лучший по качеству из подходящих.
        if (blob.size <= limitBytes) break;
      }
      if (!best) return result;
      // Совсем маленькая экономия не стоит потери исходного качества.
      if (best.size >= from * 0.92) return result;

      const name = renameTo(file.name, format.ext);
      const out = typeof File === 'function'
        ? new File([best], name, { type: format.mime, lastModified: Date.now() })
        : Object.assign(best, { name });
      return {
        file: out,
        changed: true,
        from,
        to: best.size,
        note: formatNote(from, best.size),
      };
    } catch {
      return result;
    } finally {
      // ImageBitmap держит память до close() — на телефоне это заметно.
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  root.AttachShrink = {
    LIMIT_BYTES,
    MAX_SIDE,
    MIN_SIDE,
    QUALITIES,
    shouldShrink,
    planAttempts,
    scaledSize,
    formatNote,
    renameTo,
    pickFormat,
    shrink,
  };
})(globalThis);

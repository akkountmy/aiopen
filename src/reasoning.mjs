/**
 * Ход рассуждений модели — только по-русски.
 *
 * У DeepSeek «внутренняя речь» (reasoning_content) почти всегда английская,
 * даже когда ответ и весь системный промпт русские. Правило в промпте это
 * уменьшает, но не убирает: поведение модели недетерминировано. Поэтому
 * решение принимаем в коде, как и с английскими вступлениями в narration.mjs.
 *
 * Как решаем:
 *  • смотрим первые несколько сотен знаков. Если в них уже есть кириллица и
 *    она не уступает латинице — рассуждения русские, отдаём их в поток сразу;
 *  • если текст явно латинский — не показываем ни строчки: копим и переводим
 *    на русский к концу шага, после чего отдаём одним блоком;
 *  • совсем короткий или неопределившийся хвост тоже переводим — лучше
 *    задержка, чем английская фраза в ленте.
 *
 * Английский оригинал не попадает ни в события интерфейса, ни в сохранённый
 * ход задачи: после перезагрузки страницы пользователь видит тот же русский.
 */
const CYRILLIC = /[А-Яа-яЁё]/g;
const LATIN = /[A-Za-z]/g;

function letters(text) {
  const value = String(text ?? '');
  return {
    cyrillic: (value.match(CYRILLIC) || []).length,
    latin: (value.match(LATIN) || []).length,
  };
}

/** Текст уже русский: кириллицы достаточно и она не тонет в латинице. */
export function looksRussian(text) {
  const { cyrillic, latin } = letters(text);
  return cyrillic >= 6 && cyrillic >= latin;
}

/**
 * @param {object} options
 * @param {(text: string) => void} options.emit куда отдавать русский текст
 * @param {(text: string) => Promise<string>} options.translate переводчик
 * @param {number} [options.hold] сколько знаков ждать до решения о языке
 */
export function createReasoningGate({ emit, translate, hold = 700 } = {}) {
  if (typeof emit !== 'function') throw new Error('createReasoningGate: нужен emit');
  const limit = Number.isFinite(hold) && hold > 0 ? hold : 700;
  const translateText = typeof translate === 'function' ? translate : null;

  let raw = '';
  let shown = '';
  /* wait — ещё не решили; stream — русский идёт в ленту; buffer — копим на перевод */
  let mode = 'wait';

  function decide() {
    if (mode !== 'wait') return;
    const sample = raw.slice(0, Math.max(limit, 400));
    if (looksRussian(sample)) {
      mode = 'stream';
      if (raw) {
        shown += raw;
        emit(raw);
      }
      return;
    }
    const { cyrillic, latin } = letters(sample);
    /* Латиницы много, кириллицы нет — это английские рассуждения. */
    if (latin >= 12 && cyrillic === 0) {
      mode = 'buffer';
      return;
    }
    /* Мало букв (цифры, markdown, код) — ждём следующую порцию. */
    if (raw.length >= limit * 2) {
      mode = latin > cyrillic ? 'buffer' : 'stream';
      if (mode === 'stream' && raw) {
        shown += raw;
        emit(raw);
      }
    }
  }

  return {
    /** Очередной кусок reasoning_content от модели. */
    push(text) {
      const chunk = String(text ?? '');
      if (!chunk) return;
      raw += chunk;
      if (mode === 'stream') {
        shown += chunk;
        emit(chunk);
        return;
      }
      if (mode === 'buffer') return;
      decide();
    },

    /**
     * Шаг закончился. Возвращает русский текст, который увидел (или увидит)
     * пользователь; он же идёт в сохранённый ход задачи.
     */
    async finish() {
      if (!raw.trim()) return '';
      if (mode === 'stream') return shown;
      const source = raw.trim();
      if (looksRussian(source)) {
        /* Решение не успело приняться, но текст русский — отдаём как есть. */
        shown += source;
        emit(source);
        return shown;
      }
      if (translateText) {
        let translated = '';
        try {
          translated = String((await translateText(source)) || '').trim();
        } catch {
          translated = '';
        }
        if (translated) {
          shown += translated;
          emit(translated);
          return shown;
        }
      }
      /* Перевод не удался — английский не показываем вовсе. */
      return '';
    },

    /** Исходный текст (для отладки и тестов). */
    get source() {
      return raw;
    },
  };
}

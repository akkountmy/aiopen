/* Длинный текст вложения не должен лежать в index.json.
   Раньше распознанный текст файла целиком писался в индекс: один PDF на
   полтораста тысяч знаков раздувал общий файл состояния, а он переписывается
   на каждое сообщение. Теперь в индексе только начало, полный текст — рядом
   отдельным файлом.

   Что проверяем:
   — короткий текст остаётся в индексе как есть, лишних файлов не появляется;
   — длинный текст: в индексе первые 2 000 знаков, полный — в файле;
   — чтение возвращает полный текст, а не обрезанный;
   — удаление вложения убирает и файл.

   Запуск: node test/attach-text.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-attachtext-'));
process.env.DSHOW_DATA_DIR = dataDir;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  const { storeAttachText, attachText, dropAttachText } = await import('../src/attachtext.mjs');

  /* 1. Короткий текст — без файла. */
  const shortBody = 'Короткая справка про договор.';
  const short = storeAttachText('att_short', shortBody);
  check('короткий текст остаётся в индексе', short.text === shortBody && !short.textFile, JSON.stringify(short).slice(0, 120));
  check('для короткого текста файл не создан', !fs.existsSync(path.join(dataDir, 'attach', 'att_short.txt')));

  /* 2. Длинный текст — в файл, в индексе только начало. */
  const longBody = `${'Пункт договора. '.repeat(4000)}КОНЕЦ-МАРКЕР`;
  const long = storeAttachText('att_long', longBody);
  const filePath = path.join(dataDir, 'attach', 'att_long.txt');
  check('длинный текст вынесен в файл', Boolean(long.textFile) && fs.existsSync(filePath), String(long.textFile || ''));
  check('в индексе только начало', long.text.length <= 2000 && long.text.length > 0, `${long.text.length} знаков`);
  check('в индексе сохранён полный размер', long.textChars === longBody.length, `${long.textChars} из ${longBody.length}`);
  check('начало совпадает с исходным текстом', longBody.startsWith(long.text.slice(0, 200)));

  /* 3. Чтение собирает полный текст обратно. */
  const att = { id: 'att_long', text: long.text, textFile: long.textFile, textChars: long.textChars };
  const restored = attachText(att);
  check('чтение возвращает полный текст', restored === longBody, `${restored.length} из ${longBody.length} знаков`);
  check('хвост текста на месте', restored.endsWith('КОНЕЦ-МАРКЕР'));

  /* 4. Предел при чтении тоже работает. */
  const cut = attachText(att, 500);
  check('предел чтения соблюдается', cut.length <= 500, `${cut.length} знаков`);

  /* 5. Файла нет — отдаём то, что есть в индексе, без падения. */
  fs.rmSync(filePath, { force: true });
  const fallback = attachText(att);
  check('пропавший файл не ломает чтение', fallback === att.text, `${fallback.length} знаков`);

  /* 6. Удаление вложения убирает файл. */
  const again = storeAttachText('att_drop', longBody);
  const dropPath = path.join(dataDir, 'attach', 'att_drop.txt');
  check('файл для удаления создан', fs.existsSync(dropPath));
  dropAttachText({ id: 'att_drop', text: again.text, textFile: again.textFile });
  check('удаление убирает файл', !fs.existsSync(dropPath));
  check('удаление не падает на пустом вложении', (() => {
    try {
      dropAttachText({});
      dropAttachText(null);
      return true;
    } catch {
      return false;
    }
  })());
} catch (error) {
  check('тест дошёл до конца', false, String(error?.message || error));
} finally {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length} из ${results.length} прошли, ${failed.length} упали`);
  if (failed.length) process.exit(1);
}

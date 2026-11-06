/* Проверка запасного пути дизайна: задача про интерьер не должна заканчиваться
   «Готово.» при пустой папке.

   Что проверяем:
   — просьба из отчёта считается «нужен чертёж, а его нет» — то есть включается
     адресная досборка;
   — запасной путь собирает проект сам: спек, план, 3D-сцену и перечень
     принятых допущений, без обращения к модели;
   — чужой готовый проект не перезаписывается: где спек уже есть, досборки нет;
   — просьбы не про интерьер (лендинг, документы) и вызов build_design моделью
     оставляют обычный ход задачи.

   Запуск: node test/design-rescue.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsDrawingRepair, rescueDesign } from '../src/agent.mjs';
import { designView, readSpec } from '../src/design.mjs';

/* Ровно та просьба, из-за которой задача вернулась без файлов. */
const TASK =
  'Сделай современный дизайн с мебелью квартиры студии на 40 квадратов, модные постельные цвета, есть деревянные элементы и окна в пол';

let failures = 0;
function check(ok, title, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'}${title}${extra ? ` — ${extra}` : ''}`);
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-design-'));
}

/* 1. Просьба без результата — повод для досборки. */
{
  const dir = workspace();
  const needed = needsDrawingRepair({ userText: TASK, workspace: dir, toolsUsed: [], answer: 'Готово.' });
  check(needed === true, 'просьба из отчёта включает досборку чертежей');
}

/* 2. Лендинг и документы по дому — не интерьер, досборки быть не должно. */
{
  const dir = workspace();
  const landing = needsDrawingRepair({
    userText: 'Сделай лендинг для студии дизайна: три блока, форма заявки, окна в пол на фото',
    workspace: dir,
    toolsUsed: [],
    answer: 'Готово.',
  });
  check(landing === false, 'лендинг не считается дизайном интерьера');
  const docs = needsDrawingRepair({
    userText: 'Собери документы на дом: уведомление о планируемом строительстве и техплан',
    workspace: dir,
    toolsUsed: [],
    answer: 'Готово.',
  });
  check(docs === false, 'документы на дом не считаются дизайном интерьера');
}

/* 3. Модель уже вызвала сборку — вмешиваться незачем. */
{
  const dir = workspace();
  const needed = needsDrawingRepair({
    userText: TASK,
    workspace: dir,
    toolsUsed: [{ name: 'build_design' }],
    answer: 'Готово.',
  });
  check(needed === false, 'вызов build_design снимает нужду в досборке');
}

/* 4. Готовый проект не перезаписываем: спек уже лежит в папке. */
{
  const dir = workspace();
  const rescued = await rescueDesign({ workspace: dir, userText: TASK });
  check(Boolean(rescued), 'запасной путь собрал проект в пустой папке');
  const needed = needsDrawingRepair({
    userText: TASK,
    workspace: dir,
    toolsUsed: [],
    answer: 'Готово.',
  });
  check(needed === false, 'готовый проект не требует досборки');
  check(fs.existsSync(path.join(dir, 'design.json')), 'спек записан в design.json');
}

/* 5. Что именно получил человек и куда: текст, листы, площадь. */
{
  const dir = workspace();
  const answer = await rescueDesign({ workspace: dir, userText: TASK });
  const text = String(answer || '');
  check(/м²/.test(text), 'в ответе есть площадь', text.slice(0, 70));
  check(/Допущения, принятые за вас/.test(text), 'допущения названы вслух');
  check(!/^готово\.?$/i.test(text.trim()) && text.length > 200, 'ответ содержательный, а не «Готово.»', `${text.length} знаков`);

  const view = designView(dir);
  const built = (view.artifacts || []).filter((item) => item.exists && item.bytes > 0);
  check(built.length === 5, 'собраны все пять листов', built.map((item) => `${item.key}:${item.bytes}`).join(', '));
  for (const key of ['plan', 'floor', 'ceiling', 'axo', 'scene']) {
    const file = path.join(dir, 'design', { plan: 'plan.svg', floor: 'floor.svg', ceiling: 'ceiling.svg', axo: 'axo.svg', scene: '3d.html' }[key]);
    check(fs.existsSync(file), `файл ${path.relative(dir, file)}`, fs.existsSync(file) ? `${fs.statSync(file).size} Б` : 'нет');
  }

  /* readSpec отдаёт { spec, fixes, at }: спек уже нормализован так, как его
     увидит сборщик листов. */
  const { spec } = readSpec(dir);
  const area = Number(view.area);
  check(Math.abs(area - 40) <= 3, 'площадь взята из просьбы', `${area} м² при просьбе 40 м²`);
  check((spec.rooms || []).length >= 1, 'в спеке есть комната');
  check((spec.furniture || []).length >= 8, 'мебель расставлена', `${(spec.walls || []).length} стен, ${(spec.furniture || []).length} предметов`);
  check(Boolean(spec.paper) && Boolean(spec.heights), 'формат листа и высоты заданы', `${spec.paper}, стены ${spec.heights?.wall}`);
}

/* 6. Без просьбы интерьера и без папки запасной путь молчит. */
{
  check((await rescueDesign({ workspace: workspace(), userText: 'Сделай лендинг для студии дизайна' })) === null, 'лендинг запасным путём не собирается');
  check((await rescueDesign({ userText: TASK })) === null, 'без папки проекта запасной путь молчит');
}

console.log('');
console.log(failures ? `ПРОВАЛЕНО: ${failures}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);

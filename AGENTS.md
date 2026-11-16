# DSH.OPEN.WEB — правила работы

Node-сервис (без сборки): `server.mjs` + ванильный SPA в `public/`. Прод — Amvera
(`https://dshopen-vladimir00177.msk1.amvera.tech`), выкладка git-push через
`scripts/deploy-amvera.mjs`. Презентации собирает `src/doc/deck.mjs` → headless-Chromium PDF.

## Обязательный цикл правки

1. **Тест раньше правки.** Сначала воспроизведи дефект локально (`test/*.mjs` или короткий скрипт
   в `tmp/`), потом меняй код. Живой сервис — только для финального подтверждения, один раз.
2. **Одна пересборка на пачку правок.** Правишь несколько файлов — выкладываешь один раз.
   Запрещено деплоить после каждого исправления: сборка Amvera идёт 2–6 минут.
3. **Ожидание сборки — только** `node scripts/deploy-amvera.mjs wait` (смотрит `buildStatus`/
   `buildStatusTime`). Не поллить руками, не ждать `status` (он остаётся `RUNNING`).
4. **Живая проверка презентации — одной командой** `node scripts/check-deck-live.mjs "просьба"`.
   Новых CDP-проб не писать. Браузер — только для визуального вида, и тогда один прогон,
   один снимок, один просмотр.
5. **Тесты — только затронутые наборы** (`node test/deck.mjs`). Полный прогон — перед финальной
   сборкой, не после каждой правки.
6. **Правка UTF-8 — только инструментами `edit`/`write`.** `-replace`/`Set-Content` в PowerShell
   по русскому тексту запрещены: был случай порчи файла и полкруга на поиск несуществующего баг.
7. **Черновики — только в `tmp/`** (в `.gitignore`). В корне репозитория ничего не создавать.
8. **Контекст: `grep` + чтение нужных строк**, а не перечитывание файлов целиком ради фона.
   Дампы логов и скриншоты смотреть точечно, не вываливать целиком в ответ.

## Команды

```powershell
node test/deck.mjs                      # раскладка/подгонка деки
node test/docs.mjs                      # документы (бюджет промпта — предупреждение)
node scripts/check-deck-live.mjs "текст" # сквозная живая проверка деки (сам убирает проект)
node scripts/deploy-diff.mjs            # что в рабочей копии ещё не выложено
node scripts/deploy-amvera.mjs push src/doc/deck.mjs
node scripts/deploy-amvera.mjs build
node scripts/deploy-amvera.mjs wait
node scripts/deploy-amvera.mjs status   # смотреть через -Last, не First (EPIPE = не ошибка)
```

Секреты прода: `& "$env:USERPROFILE\.dsh\secrets\_vault.ps1" get dshow-admin -Field login|password`.

## Где что живёт

`server.mjs` — HTTP и потоковые ответы · `public/app.js`, `public/styles.css` — SPA ·
`src/tools.mjs` — инструменты модели · `src/doc/deck.mjs` — дека и замер раскладки ·
`src/prompt.mjs` — системный промпт · `assets/deck/` — CSS деки · `test/` — наборы проверок ·
`scripts/` — деплой и живые пробы.

## Запреты

- Геометрию `assets/deck/deck.css` не трогать: новые правила — в `assets/deck/deck-extra.css`.
- Деку не сжимать: не уменьшать шрифт, не уплотнять `rows`, не выбрасывать содержимое.
  Порядок подгонки: лид → деление слайда → сноска → миниатюры обложки.
- В `deck.mjs` не читать диск: дека — функция от спека; файлы в base64 превращает `src/tools.mjs`.
- На живом сервисе удалять только свои проекты «Проба …» и сразу за собой.

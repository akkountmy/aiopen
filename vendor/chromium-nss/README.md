# Библиотеки NSS для встроенного Chromium

В node-сборке Amvera нет ни root, ни пакетного менеджера, а встроенному
Chromium из `@sparticuz/chromium` нужны библиотеки NSS (сеть и TLS). Без них
запуск падает с `Code: 127`, и `ldd` перечисляет: `libnss3.so`,
`libnssutil3.so`, `libnspr4.so`.

Поэтому библиотеки лежат рядом с сервисом и добавляются в `LD_LIBRARY_PATH`
(см. `src/browser.mjs`, функция `useVendorLibs`).

Источник — пакеты Ubuntu 20.04 (focal, glibc 2.31 — совместимо с более новыми):

- `libnss3_3.98-0ubuntu0.20.04.2_amd64.deb`
- `libnspr4_4.25-1_amd64.deb`

Лицензии NSS и NSPR — MPL 2.0 / GPL-2.0 (двойная), копии взяты из тех же пакетов.
Каталог нужен только Linux-сборке; на Windows и в Docker-образе он не используется
(там Playwright ставит Chromium вместе с зависимостями).

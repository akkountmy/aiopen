# Сервис в контейнере: Node 20 + Python 3 + браузер Chromium.
#
# Зачем Python: инструмент run_python включается автоматически, когда сервис
# находит интерпретатор. В облаке Amvera образа нет — там чистый nodejs, и
# run_python просто не показывается модели. В контейнере он есть.
#
# Зачем Chromium: инструмент check_page проверяет собранную страницу живьём —
# скриншот, ошибки консоли, горизонтальная прокрутка на 390/768/1440 px.
# Playwright стоит в optionalDependencies: без браузера сервис работает как
# раньше, инструмент просто не появляется в наборе.
#
# Сборка и запуск:
#   docker build -t dsh-open-web .
#   docker run -d --name dsh-open-web -p 3123:3123 \
#     -v dsh_data:/data \
#     -e DSHOW_DEEPSEEK_KEY=... \
#     -e DSHOW_ADMIN_PASSWORD=... \
#     dsh-open-web
#
# Каталог /data — единственное место, которое нужно сохранять между
# перезапусками: там учётные записи, проекты и выгрузки. Владелец тома должен
# быть доступен пользователю node (uid 1000): примонтированный пустой том
# Docker создаёт с владельцем root, поэтому либо используйте именованный том
# (как выше), либо выполните `chown -R 1000:1000 /путь/на/хосте`.
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    DSHOW_HOST=0.0.0.0 \
    DSHOW_PORT=3123 \
    DSHOW_DATA_DIR=/data \
    DSHOW_TRUST_PROXY=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# python3 — для run_python; tini — корректная остановка по SIGTERM;
# gosu — переход с root на node после починки прав /data;
# ca-certificates — исходящие HTTPS-запросы (поиск, загрузка страниц).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      tini \
      gosu \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала только манифест — слой зависимостей кэшируется и не пересобирается
# при правке кода.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

# Chromium ставим отдельным слоем: системные библиотеки под него тянет
# --with-deps. Браузеры лежат в /ms-playwright и должны быть читаемы
# пользователю node, под которым работает сервис.
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /tmp/*

COPY . .

RUN mkdir -p /data \
 && chown -R node:node /app /data \
 && chmod +x /app/entrypoint.sh

# Специально без USER node: вход через entrypoint.sh. Постоянное хранилище /data
# досталось от прежнего окружения nodejs, и его владелец может быть root.
# Скрипт возвращает владельца пользователю node и уже потом сбрасывает права;
# если прав не хватило — работает от root, чтобы сервис не падал на старте.
EXPOSE 3123
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DSHOW_PORT || 3123) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server.mjs"]

# Сервис в контейнере: Node 20 + Python 3.
#
# Зачем Python: инструмент run_python включается автоматически, когда сервис
# находит интерпретатор. В облаке Amvera образа нет — там чистый nodejs, и
# run_python просто не показывается модели. В контейнере он есть.
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
    DSHOW_TRUST_PROXY=1

# python3 — для run_python; tini — корректная остановка по SIGTERM;
# ca-certificates — исходящие HTTPS-запросы (поиск, загрузка страниц).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      tini \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала только манифест — слой зависимостей кэшируется и не пересобирается
# при правке кода.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

COPY . .

RUN mkdir -p /data \
 && chown -R node:node /app /data

USER node

EXPOSE 3123
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DSHOW_PORT || 3123) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]

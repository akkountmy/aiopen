#!/bin/sh
# Запуск сервиса в контейнере.
#
# Постоянное хранилище /data сервис получил ещё в окружении nodejs, и владельцем
# файлов там может быть root. Если контейнер стартует от root, сначала возвращаем
# /data пользователю node (под ним работает сервис и браузер Chromium), затем
# сбрасываем права. Не получилось — работаем от root, но не падаем.
set -e

if [ "$(id -u)" = "0" ]; then
  if chown -R node:node /data 2>/dev/null; then
    echo "entrypoint: /data принадлежит node, запускаю сервис от node"
    exec gosu node "$@"
  fi
  echo "entrypoint: не смог вернуть владельца /data, запускаю от root"
fi

exec "$@"

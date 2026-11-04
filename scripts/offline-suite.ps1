# Прогон оффлайн-набора сервиса — то же, что `npm test`.
# Логика живёт в scripts/check.mjs (кроссплатформенно, --json, честный код выхода).
# Оставлено для привычных вызовов из PowerShell.
node "$PSScriptRoot\check.mjs" @args
exit $LASTEXITCODE

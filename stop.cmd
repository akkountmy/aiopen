@echo off
chcp 65001 >nul
powershell -NoProfile -Command "$p = (Get-NetTCPConnection -LocalPort 3123 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host 'Сервер остановлен.' } else { Write-Host 'Сервер не запущен.' }"
timeout /t 2 >nul

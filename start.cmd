@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist data mkdir data
node server.mjs
echo.
echo Сервер остановлен. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul

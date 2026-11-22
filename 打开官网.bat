@echo off
chcp 65001 >nul
cd /d "%~dp0site"
start "" http://127.0.0.1:8780/
python -m http.server 8780 --bind 127.0.0.1
echo.
echo 官网已退出。
pause

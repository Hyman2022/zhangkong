@echo off
chcp 65001 >nul
cd /d "%~dp0"
python -c "import aiohttp,qrcode,PIL" 2>nul
if errorlevel 1 python -m pip install -r requirements.txt
python -m zhangkong
echo.
echo 掌控已退出。
pause

@echo off
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5602"
node server.js
pause

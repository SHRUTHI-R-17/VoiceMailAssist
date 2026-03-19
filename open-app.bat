@echo off
echo ══════════════════════════════════════════
echo   VoiceMailAssist v4 — Starting...
echo ══════════════════════════════════════════
echo.
echo Starting Node.js server...
start /B node server.js
echo Waiting for server to start...
timeout /t 3 /nobreak > nul
echo Opening Chrome...
start chrome http://localhost:3000/app.html
echo.
echo ✅ App is now open in Chrome!
echo    URL: http://localhost:3000/app.html
echo    Admin: http://localhost:3000/admin.html
echo.
echo Press Ctrl+C to stop the server.
echo ══════════════════════════════════════════

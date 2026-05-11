@echo off
title Maquis Manager - Demarrage
color 0A

echo.
echo  ================================================
echo   Maquis Manager - Gestion maquis / cave
echo  ================================================
echo.

cd /d "%~dp0"

echo  Arret des anciens processus...
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
python "%~dp0launcher.py"

pause

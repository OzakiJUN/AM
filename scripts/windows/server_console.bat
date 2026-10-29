@echo off
rem Runs am-server with its log in this window (for troubleshooting).
rem Normally just double-click am-server.exe instead: it runs in the background
rem with a tray icon and opens the admin panel in your browser.
cd /d "%~dp0"
title AM server (console)
am-server.exe -headless
echo.
echo Server stopped.
pause

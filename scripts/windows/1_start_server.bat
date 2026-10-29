@echo off
rem Starts the AM server. Close this window or press Ctrl+C to stop it.
rem First start creates config.toml and the database (SQLite) automatically.
rem All settings are in config.toml.
cd /d "%~dp0"
title AM server
am-server.exe -config config.toml
echo.
echo Server stopped.
pause

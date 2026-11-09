@echo off
rem Creates the key that signs the AM Android app.
rem It goes into a GitHub Secret, and a copy is kept somewhere safe offline:
rem phones only accept updates signed with the same key.
rem Run it once, on your own computer.
cd /d "%~dp0"
title AM Android signing key
am-server.exe android-keygen
echo.
pause

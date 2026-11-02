@echo off
rem Creates the signing key of AM releases (auto-update).
rem The private key goes into a GitHub Secret, the public key into am-server and the client.
rem Run it once, on your own computer.
cd /d "%~dp0"
title AM release signing key
am-server.exe release-keygen
echo.
pause

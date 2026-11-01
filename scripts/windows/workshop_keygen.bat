@echo off
rem Creates the signing key of the AM creative workshop (am-workshop repository).
rem The private key goes into a GitHub Secret, the public key into the client.
rem Run it once, on your own computer.
cd /d "%~dp0"
title AM workshop signing key
am-server.exe workshop-keygen
echo.
pause

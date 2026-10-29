@echo off
rem Command-line test client. Settings are in testclient.toml (created on first run).
rem It asks for a profile name; use different names (alice, bob) to log in as several users.
cd /d "%~dp0"
title AM test client
am-testclient.exe -config testclient.toml
pause

@echo off
rem ONLY needed if you switch config.toml to database driver = "postgres".
rem The default (SQLite) needs no setup at all.
rem Creates the PostgreSQL user and database named in config.toml.
rem You will be asked for the PostgreSQL "postgres" password (set when you installed PostgreSQL).
cd /d "%~dp0"
am-server.exe setup-db -config config.toml
echo.
pause

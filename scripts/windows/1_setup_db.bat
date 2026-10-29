@echo off
rem Creates the database user and database for AM.
rem First run also creates config.toml with a random database password.
rem You will be asked for the PostgreSQL "postgres" password (set when you installed PostgreSQL).
cd /d "%~dp0"
am-server.exe setup-db -config config.toml
echo.
pause

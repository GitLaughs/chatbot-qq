@echo off
cd /d "%~dp0.."
call "%APPDATA%\npm\cc-connect.cmd" --config "%CD%\configs\cc-connect.napcat.local.toml" --force >> "%CD%\cc-connect-napcat-live.log" 2>&1

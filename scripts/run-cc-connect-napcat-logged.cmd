@echo off
if "%CHATBOT_QQ_ROOT%"=="" set "CHATBOT_QQ_ROOT=%~dp0.."
cd /d "%CHATBOT_QQ_ROOT%"
call "%APPDATA%\npm\cc-connect.cmd" --config "%CHATBOT_QQ_ROOT%\configs\cc-connect.napcat.local.toml" --force >> "%CHATBOT_QQ_ROOT%\cc-connect-napcat-live.log" 2>&1

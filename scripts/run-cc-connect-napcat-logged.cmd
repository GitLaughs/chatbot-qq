@echo off
cd /d C:\chatbot-qq
call "%APPDATA%\npm\cc-connect.cmd" --config "C:\chatbot-qq\configs\cc-connect.napcat.local.toml" --force >> "C:\chatbot-qq\cc-connect-napcat-live.log" 2>&1

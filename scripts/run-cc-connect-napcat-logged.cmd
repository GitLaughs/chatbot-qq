@echo off
cd /d E:\CHATBOT-QQ
call "%APPDATA%\npm\cc-connect.cmd" --config "E:\CHATBOT-QQ\configs\cc-connect.napcat.local.toml" --force >> "E:\CHATBOT-QQ\cc-connect-napcat-live.log" 2>&1

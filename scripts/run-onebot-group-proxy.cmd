@echo off
chcp 65001 >nul
cd /d C:\chatbot-qq
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 13110 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if %ERRORLEVEL%==0 exit /b 0
set ONEBOT_ALLOWED_GROUPS=123456789,234567890,345678901
set ONEBOT_AT_ONLY_GROUPS=234567890
set ONEBOT_SILENT_FILE_GROUPS=123456789,234567890,345678901
set ONEBOT_ALLOWED_PRIVATE_USERS=100000002,100000003,100000004,100000005,100000001,100000006
set ONEBOT_PROXY_PORTS=13002,13003,13005,13006,13007,13008,13009,13011,13012,13013,13014,13015
set ONEBOT_LISTEN_PORT=13002
set ONEBOT_AT_PORT=13003
set ONEBOT_VIVADO_TASK_PORT=13014
set ONEBOT_GROUP_ROUTES=123456789:13002:13003,234567890::13005,345678901:13012:13013
set ONEBOT_PRIVATE_ROUTES=100000002:13006,100000003:13007,100000004:13008,100000005:13009,100000001:13011,100000006:13015
set ONEBOT_UPSTREAM_URL=ws://127.0.0.1:13001
set ONEBOT_HEALTH_HOST=127.0.0.1
set ONEBOT_HEALTH_PORT=13110
set QQ_COURSE_OCR_COMMAND=["node","C:\\chatbot-qq\\scripts\\course-ocr-bridge.js"]
set QQ_COURSE_OCR_PROVIDER_COMMAND=["dotnet","run","--project","C:\\chatbot-qq\\scripts\\course-ocr-windows"]
set QQ_COURSE_OCR_TIMEOUT_MS=60000
set QQ_COURSE_OCR_PROVIDER_TIMEOUT_MS=45000
set ONEBOT_ACK_EMOJI_ID=76
set ONEBOT_LISTEN_TRIGGER_MODE=selective
set ONEBOT_LISTEN_TRIGGER_KEYWORDS=bot,机器人,助手,codex,qqbot,qq bot,帮我,帮忙,可以帮,求助,看看这个,看一下这个,分析一下,总结一下,给个建议,报错,错误,失败,修一下,改一下,代码,脚本,python,公式,推导,实验报告,作业题,题目,文件,论文,pdf
set ONEBOT_MINIMAL_LISTEN_GROUPS=345678901
set ONEBOT_MINIMAL_LISTEN_KEYWORDS=bot,机器人,助手,codex,qqbot,qq bot,写不完作业
set ONEBOT_GROUP_TRIGGER_KEYWORD_FILE=trigger_keywords.txt
set ONEBOT_PROFILE_REPLY_MARKERS=触发回复,需要回复,关注点,未解决,重要信息
set QQ_TASK_TIMEZONE=Asia/Shanghai
set QQ_TASK_MODEL_PARSER_COMMAND=["node","C:\\chatbot-qq\\scripts\\task-model-parser-bridge.js"]
set QQ_TASK_MODEL_PARSER_MODEL=gpt-5.4
set QQ_TASK_MODEL_PARSER_MODE=responses
set QQ_TASK_MODEL_PARSER_TIMEOUT_MS=8000
set QQ_TASK_MODEL_PARSER_HTTP_TIMEOUT_MS=30000
set QQ_TASK_FILE_MODIFIER_COMMAND=["node","C:\\chatbot-qq\\scripts\\artifact-model-bridge.js"]
set QQ_TASK_FILE_MODIFIER_TIMEOUT_MS=10000
set QQ_TASK_SCRIPT_GENERATOR_COMMAND=["node","C:\\chatbot-qq\\scripts\\artifact-model-bridge.js"]
set QQ_TASK_SCRIPT_GENERATOR_TIMEOUT_MS=10000
set QQ_TASK_ARTIFACT_MODEL=gpt-5.4
set QQ_TASK_ARTIFACT_MODEL_MODE=responses
set QQ_TASK_ARTIFACT_MODEL_HTTP_TIMEOUT_MS=60000
set QQ_TASK_ARTIFACT_MODEL_MAX_OUTPUT_TOKENS=4096
node "C:\chatbot-qq\scripts\onebot-group-proxy.js" >> "C:\chatbot-qq\onebot-group-proxy.local.out.log" 2>> "C:\chatbot-qq\onebot-group-proxy.local.err.log"

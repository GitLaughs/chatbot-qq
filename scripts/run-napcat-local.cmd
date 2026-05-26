@echo off
chcp 65001 >nul

powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 13001 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if %ERRORLEVEL%==0 exit /b 0

if "%CHATBOT_QQ_ROOT%"=="" set "CHATBOT_QQ_ROOT=%~dp0.."
if "%NAPCAT_ROOT%"=="" set "NAPCAT_ROOT=%CHATBOT_QQ_ROOT%\tools\NapCat.Shell.Windows.OneKey\NapCat.Shell"
if "%NAPCAT_LOG_DIR%"=="" set "NAPCAT_LOG_DIR=%CHATBOT_QQ_ROOT%\tmp"

if "%NAPCAT_QQ%"=="" (
  echo Set NAPCAT_QQ to the QQ account number before starting NapCat.
  exit /b 1
)

if not exist "%NAPCAT_ROOT%\NapCatWinBootMain.exe" (
  echo Missing NapCatWinBootMain.exe under "%NAPCAT_ROOT%".
  exit /b 1
)

if not exist "%NAPCAT_LOG_DIR%" mkdir "%NAPCAT_LOG_DIR%"

cd /d "%NAPCAT_ROOT%"
.\NapCatWinBootMain.exe %NAPCAT_QQ% >> "%NAPCAT_LOG_DIR%\napcat-local.out.log" 2>> "%NAPCAT_LOG_DIR%\napcat-local.err.log"

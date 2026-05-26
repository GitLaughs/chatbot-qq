param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$QQNumber = "",
    [string]$GroupId = "",
    [string]$PrivateUserId = "",
    [string]$NapCatRoot = "",
    [int]$NapCatPort = 13001,
    [int]$HealthPort = 13110,
    [int]$ListenPort = 13002,
    [int]$AtPort = 13003,
    [int]$PrivatePort = 13006,
    [switch]$SkipNpmInstall,
    [switch]$SkipCcConnectInstall,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-LocalPath {
    param([string]$Path)
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Read-Value {
    param([string]$Prompt, [string]$Default = "", [switch]$Required)
    while ($true) {
        $suffix = if ([string]::IsNullOrWhiteSpace($Default)) { "" } else { " [$Default]" }
        $value = Read-Host "$Prompt$suffix"
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $Default
        }
        if (!$Required -or ![string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
        Write-Host "Required." -ForegroundColor Yellow
    }
}

function Test-PortListening {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port {
    param([int]$Port, [int]$TimeoutSeconds, [string]$Label)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) {
            Write-Host "$Label ready on 127.0.0.1:$Port" -ForegroundColor Green
            return $true
        }
        Start-Sleep -Seconds 2
    }
    Write-Host "$Label did not become ready on 127.0.0.1:$Port within $TimeoutSeconds seconds." -ForegroundColor Yellow
    return $false
}

function Wait-ProxyHealth {
    param([int]$Port, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $url = "http://127.0.0.1:$Port/healthz"
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri $url -TimeoutSec 3
            if ($health.ok -and $health.upstream.ready) {
                Write-Host "Proxy health ok: $url" -ForegroundColor Green
                return $health
            }
            Write-Host "Waiting for proxy health: upstream_ready=$($health.upstream.ready) ok=$($health.ok)"
        }
        catch {
            Write-Host "Waiting for proxy health: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 3
    }
    throw "Proxy did not become healthy: $url"
}

function Find-NapCatRoot {
    param([string]$Root)
    $candidates = @(
        (Join-Path $Root "tools\NapCat.Shell.Windows.OneKey\NapCat.Shell"),
        (Join-Path $Root "tools\NapCat.Shell.Windows.OneKey")
    )
    foreach ($candidate in $candidates) {
        $exe = Join-Path $candidate "NapCatWinBootMain.exe"
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            return $candidate
        }
    }
    $toolsRoot = Join-Path $Root "tools"
    if (Test-Path -LiteralPath $toolsRoot -PathType Container) {
        $match = Get-ChildItem -LiteralPath $toolsRoot -Recurse -Filter NapCatWinBootMain.exe -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) {
            return $match.DirectoryName
        }
    }
    return ""
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This installer is for Windows."
}

$Root = Resolve-LocalPath $Root
Set-Location $Root

Write-Host "chatbot-qq Windows interactive installer" -ForegroundColor Cyan
Write-Host "Root: $Root"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is missing. Install Node.js 20+ first, then rerun this script."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is missing. Install Node.js with npm first, then rerun this script."
}

if ([string]::IsNullOrWhiteSpace($QQNumber)) {
    $QQNumber = Read-Value -Prompt "QQ account number for NapCat login" -Required
}
if ([string]::IsNullOrWhiteSpace($GroupId)) {
    $GroupId = Read-Value -Prompt "QQ group ID to allow" -Required
}
if ([string]::IsNullOrWhiteSpace($PrivateUserId)) {
    $PrivateUserId = Read-Value -Prompt "Private QQ user ID to allow (optional)" -Default ""
}

if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
    $detectedNapCatRoot = Find-NapCatRoot -Root $Root
    $NapCatRoot = Read-Value -Prompt "NapCat folder containing NapCatWinBootMain.exe" -Default $detectedNapCatRoot -Required
}
$NapCatRoot = Resolve-LocalPath $NapCatRoot
$napcatExe = Join-Path $NapCatRoot "NapCatWinBootMain.exe"
if (-not (Test-Path -LiteralPath $napcatExe -PathType Leaf)) {
    throw "NapCatWinBootMain.exe not found: $napcatExe"
}

if (-not $SkipNpmInstall) {
    Write-Host "Installing npm dependencies..."
    npm install
}

if (-not $SkipCcConnectInstall -and -not (Get-Command cc-connect -ErrorAction SilentlyContinue)) {
    Write-Host "Installing cc-connect globally..."
    npm install -g cc-connect
}

$installArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $Root "scripts\install.ps1"),
    "-InstallRoot", $Root,
    "-GroupId", $GroupId,
    "-ListenPort", $ListenPort,
    "-AtPort", $AtPort,
    "-PrivatePort", $PrivatePort,
    "-NoStart"
)
if (-not [string]::IsNullOrWhiteSpace($PrivateUserId)) {
    $installArgs += @("-PrivateUserId", $PrivateUserId)
}
if ($SkipNpmInstall) {
    $installArgs += "-NoNpmInstall"
}
Write-Host "Writing cc-connect local config..."
& powershell.exe @installArgs

$localDir = Join-Path $Root ".cc-connect"
$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $localDir, $logDir | Out-Null

$allowedPrivateUsers = if ([string]::IsNullOrWhiteSpace($PrivateUserId)) { "" } else { $PrivateUserId }
$privateRoutes = if ([string]::IsNullOrWhiteSpace($PrivateUserId)) { "" } else { "${PrivateUserId}:$PrivatePort" }
$proxyPorts = if ([string]::IsNullOrWhiteSpace($PrivateUserId)) { "$ListenPort,$AtPort" } else { "$ListenPort,$AtPort,$PrivatePort" }
$escapedRoot = $Root.Replace("\", "\\")
$proxyCmd = @"
@echo off
chcp 65001 >nul
cd /d "$Root"
set ONEBOT_ALLOWED_GROUPS=$GroupId
set ONEBOT_AT_ONLY_GROUPS=
set ONEBOT_SILENT_FILE_GROUPS=$GroupId
set ONEBOT_ALLOWED_PRIVATE_USERS=$allowedPrivateUsers
set ONEBOT_PROXY_PORTS=$proxyPorts
set ONEBOT_LISTEN_PORT=$ListenPort
set ONEBOT_AT_PORT=$AtPort
set ONEBOT_GROUP_ROUTES=${GroupId}:${ListenPort}:${AtPort}
set ONEBOT_PRIVATE_ROUTES=$privateRoutes
set ONEBOT_UPSTREAM_URL=ws://127.0.0.1:$NapCatPort
set ONEBOT_HEALTH_HOST=127.0.0.1
set ONEBOT_HEALTH_PORT=$HealthPort
set ONEBOT_ACK_EMOJI_ID=76
set ONEBOT_LISTEN_TRIGGER_MODE=selective
set ONEBOT_LISTEN_TRIGGER_KEYWORDS=bot,机器人,助手,codex,qqbot,qq bot,帮我,帮忙,可以帮,求助,看看这个,看一下这个,分析一下,总结一下,给个建议,报错,错误,失败,修一下,改一下,代码,脚本,python,公式,推导,实验报告,作业题,题目,文件,论文,pdf
set ONEBOT_GROUP_TRIGGER_KEYWORD_FILE=trigger_keywords.txt
set ONEBOT_PROFILE_REPLY_MARKERS=触发回复,需要回复,关注点,未解决,重要信息
set QQ_TASK_TIMEZONE=Asia/Shanghai
set QQ_TASK_MODEL_PARSER_COMMAND=["node","$escapedRoot\\scripts\\task-model-parser-bridge.js"]
set QQ_TASK_MODEL_PARSER_MODEL=gpt-5.4
set QQ_TASK_MODEL_PARSER_MODE=responses
set QQ_TASK_MODEL_PARSER_TIMEOUT_MS=8000
set QQ_TASK_MODEL_PARSER_HTTP_TIMEOUT_MS=30000
set QQ_TASK_FILE_MODIFIER_COMMAND=["node","$escapedRoot\\scripts\\artifact-model-bridge.js"]
set QQ_TASK_FILE_MODIFIER_TIMEOUT_MS=10000
set QQ_TASK_SCRIPT_GENERATOR_COMMAND=["node","$escapedRoot\\scripts\\artifact-model-bridge.js"]
set QQ_TASK_SCRIPT_GENERATOR_TIMEOUT_MS=10000
set QQ_TASK_ARTIFACT_MODEL=gpt-5.4
set QQ_TASK_ARTIFACT_MODEL_MODE=responses
set QQ_TASK_ARTIFACT_MODEL_HTTP_TIMEOUT_MS=60000
set QQ_TASK_ARTIFACT_MODEL_MAX_OUTPUT_TOKENS=4096
node "$Root\scripts\onebot-group-proxy.js"
"@
$proxyCmdPath = Join-Path $localDir "run-onebot-group-proxy.local.cmd"
Write-Utf8File -Path $proxyCmdPath -Content $proxyCmd

if ($NoStart) {
    Write-Host "Wrote local proxy starter: $proxyCmdPath" -ForegroundColor Green
    exit 0
}

if (-not (Test-PortListening -Port $NapCatPort)) {
    Write-Host "Starting NapCat. Scan the QR code in the NapCat window if login is required." -ForegroundColor Cyan
    $napcatCommand = "title NapCat QQ Login && cd /d `"$NapCatRoot`" && `"$napcatExe`" $QQNumber"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $napcatCommand -WindowStyle Normal | Out-Null
    Start-Process "http://127.0.0.1:6099" -ErrorAction SilentlyContinue | Out-Null
}
else {
    Write-Host "NapCat port already listening on 127.0.0.1:$NapCatPort" -ForegroundColor Green
}

Wait-Port -Port $NapCatPort -TimeoutSeconds 600 -Label "NapCat OneBot" | Out-Null

if (-not (Test-PortListening -Port $HealthPort)) {
    Write-Host "Starting onebot-group-proxy..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$proxyCmdPath`"" -WindowStyle Normal | Out-Null
}
else {
    Write-Host "Proxy health port already listening on 127.0.0.1:$HealthPort" -ForegroundColor Green
}

Wait-Port -Port $HealthPort -TimeoutSeconds 120 -Label "onebot-group-proxy health" | Out-Null

Write-Host "Starting cc-connect..." -ForegroundColor Cyan
$ccScript = Join-Path $Root "scripts\start-cc-connect-napcat.ps1"
Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$ccScript`"" -WorkingDirectory $Root -WindowStyle Normal | Out-Null

$health = Wait-ProxyHealth -Port $HealthPort -TimeoutSeconds 180
Write-Host ""
Write-Host "Deployment is ready." -ForegroundColor Green
Write-Host "Health URL: http://127.0.0.1:$HealthPort/healthz"
Write-Host "Upstream: ws://127.0.0.1:$NapCatPort"
Write-Host "Proxy clients: $($health.capabilities.checks.proxy_clients.detail)"
Write-Host "Now send a message or @ the bot in QQ group $GroupId."

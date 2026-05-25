param(
    [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ConfigPath = "",
    [string]$GroupId = "",
    [string]$PrivateUserId = "",
    [string]$WorkspaceRoot = "",
    [int]$ListenPort = 3002,
    [int]$AtPort = 3003,
    [int]$PrivatePort = 3006,
    [switch]$NoNpmInstall,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Read-Value {
    param([string]$Prompt, [string]$Default = "", [switch]$Required)
    while ($true) {
        $suffix = if ($Default) { " [$Default]" } else { "" }
        $value = Read-Host "$Prompt$suffix"
        if ([string]::IsNullOrWhiteSpace($value)) { $value = $Default }
        if (!$Required -or ![string]::IsNullOrWhiteSpace($value)) { return $value }
        Write-Host "Value is required." -ForegroundColor Yellow
    }
}

function Toml-Escape {
    param([string]$Value)
    return $Value.Replace("\", "\\").Replace('"', '\"')
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Content, $utf8)
}

$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $InstallRoot "configs\cc-connect.napcat.local.toml"
}
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $InstallRoot "groups"
}

Write-Host "chatbot-qq Windows installer" -ForegroundColor Cyan
Write-Host "Install root: $InstallRoot"
Write-Host "Config path:  $ConfigPath"
Write-Host ""

if ([string]::IsNullOrWhiteSpace($GroupId)) {
    $GroupId = Read-Value -Prompt "QQ group ID to allow" -Required
}
if ([string]::IsNullOrWhiteSpace($PrivateUserId)) {
    $PrivateUserId = Read-Value -Prompt "Private QQ user ID to allow (optional)" -Default ""
}

$WorkspaceRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkspaceRoot)
$groupWorkspace = Join-Path $WorkspaceRoot "sandbox-$GroupId"
New-Item -ItemType Directory -Force -Path $groupWorkspace | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $groupWorkspace "local_files") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $groupWorkspace "memory") | Out-Null

$indexPath = Join-Path $groupWorkspace "local_files\INDEX.md"
if (!(Test-Path -LiteralPath $indexPath)) {
    Write-Utf8File -Path $indexPath -Content "# Local File Index`n`n| Date | Name | Path | Type | Notes |`n|---|---|---|---|---|`n"
}
$knowledgePath = Join-Path $groupWorkspace "KNOWLEDGE.md"
if (!(Test-Path -LiteralPath $knowledgePath)) {
    Write-Utf8File -Path $knowledgePath -Content "# Knowledge`n"
}
$agentsPath = Join-Path $groupWorkspace "AGENTS.md"
if (!(Test-Path -LiteralPath $agentsPath)) {
    Copy-Item -LiteralPath (Join-Path $InstallRoot "groups\default\AGENTS.md") -Destination $agentsPath
}

$dataDir = Join-Path $InstallRoot ".cc-connect"
$configDir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

$groupWorkspaceToml = Toml-Escape $groupWorkspace
$dataDirToml = Toml-Escape $dataDir
$config = @"
language = "zh"
data_dir = "$dataDirToml"

[log]
level = "info"

[display]
mode = "compact"
thinking_messages = false
tool_messages = false
show_context_indicator = false
reply_footer = false

[stream_preview]
enabled = false

[instant_reply]
enabled = false
content = ""

[rate_limit]
max_messages = 20
window_secs = 60

[[projects]]
name = "qq-sandbox-$GroupId-listen"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$groupWorkspaceToml"
mode = "full-auto"
model = "gpt-5.4-mini"
reasoning_effort = "medium"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$ListenPort"
token = ""
allow_from = "*"
share_session_in_channel = true

[[projects]]
name = "qq-sandbox-$GroupId-at"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$groupWorkspaceToml"
mode = "full-auto"
model = "gpt-5.5"
reasoning_effort = "medium"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$AtPort"
token = ""
allow_from = "*"
share_session_in_channel = false
"@

if (![string]::IsNullOrWhiteSpace($PrivateUserId)) {
    $privateWorkspace = Join-Path $InstallRoot "users\$PrivateUserId"
    New-Item -ItemType Directory -Force -Path $privateWorkspace | Out-Null
    $privateWorkspaceToml = Toml-Escape $privateWorkspace
    $config += @"

[[projects]]
name = "qq-private-$PrivateUserId"
reset_on_idle_mins = 30

[projects.agent]
type = "codex"

[projects.agent.options]
work_dir = "$privateWorkspaceToml"
mode = "full-auto"
model = "gpt-5.5"
reasoning_effort = "medium"

[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:$PrivatePort"
token = ""
allow_from = "$PrivateUserId"
share_session_in_channel = false
"@
}

if (Test-Path -LiteralPath $ConfigPath) {
    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
}
Write-Utf8File -Path $ConfigPath -Content ($config + "`n")

if (!$NoNpmInstall) {
    Push-Location $InstallRoot
    npm install
    Pop-Location
}

Write-Host ""
Write-Host "Wrote config: $ConfigPath" -ForegroundColor Green
Write-Host "Group workspace: $groupWorkspace"
Write-Host "Set NapCat OneBot v11 upstream to ws://127.0.0.1:3001."
Write-Host "Run proxy in another terminal:"
Write-Host "  `$env:ONEBOT_ALLOWED_GROUPS='$GroupId'; `$env:ONEBOT_PROXY_PORTS='$ListenPort,$AtPort'; node scripts\onebot-group-proxy.js"
Write-Host "Then start cc-connect:"
Write-Host "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cc-connect-napcat.ps1"

if (!$NoStart) {
    Write-Host ""
    Write-Host "Starting cc-connect. Keep this terminal open." -ForegroundColor Cyan
    & (Join-Path $InstallRoot "scripts\start-cc-connect-napcat.ps1")
}

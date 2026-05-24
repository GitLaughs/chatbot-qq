param(
    [string]$Server = "root@43.108.37.203",
    [string]$RemoteDir = "/opt/chatbot-qq",
    [string]$RemoteConfigDir = "/root/.cc-connect-qq",
    [string]$LocalBackupDir = "E:\CHATBOT-QQ\backup\server-daily",
    [int]$KeepDays = 14,
    [switch]$IncludeSecrets,
    [switch]$InstallScheduledTask
)

$ErrorActionPreference = "Stop"

if ($InstallScheduledTask) {
    $script = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\backup-chatbot-qq-server.ps1"
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Server `"$Server`" -RemoteDir `"$RemoteDir`" -RemoteConfigDir `"$RemoteConfigDir`" -LocalBackupDir `"$LocalBackupDir`" -KeepDays $KeepDays"
    if ($IncludeSecrets) {
        $args += " -IncludeSecrets"
    }
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
    $trigger = New-ScheduledTaskTrigger -Daily -At 3:40am
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName "CHATBOT-QQ server daily backup" -Action $action -Trigger $trigger -Settings $settings -Description "Pull /opt/chatbot-qq runtime data from QQ server every day." -Force | Out-Null
    Write-Host "Scheduled task installed: CHATBOT-QQ server daily backup"
    return
}

New-Item -ItemType Directory -Force -Path $LocalBackupDir | Out-Null

function Quote-BashArg([string]$Value) {
    return "'" + ($Value -replace "'", "'`"`"`'") + "'"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteArchive = "/tmp/chatbot-qq-backup-$stamp.tar.gz"
$localArchive = Join-Path $LocalBackupDir "chatbot-qq-server-$stamp.tar.gz"
$manifest = Join-Path $LocalBackupDir "MANIFEST-$stamp.txt"
$latestStatus = Join-Path $LocalBackupDir "LATEST.json"
$backupPaths = @(
    "$RemoteDir/groups",
    "$RemoteDir/users",
    "$RemoteDir/.cc-connect",
    "$RemoteDir/package.json",
    "$RemoteDir/package-lock.json",
    "$RemoteDir/AGENTS.md",
    "$RemoteDir/docs"
)
if ($IncludeSecrets) {
    $backupPaths += "/etc/chatbot-qq.env"
    $backupPaths += "$RemoteConfigDir/config.toml"
}
$remoteCommand = @(
    "set -eu",
    "test $(Quote-BashArg $RemoteDir) != '/'",
    "test -d $(Quote-BashArg $RemoteDir)",
    "rm -f $(Quote-BashArg $remoteArchive)",
    "tar --warning=no-file-changed --ignore-failed-read --exclude=$(Quote-BashArg "$RemoteDir/tools") --exclude=$(Quote-BashArg "$RemoteDir/*.log") --exclude=$(Quote-BashArg "$RemoteDir/backup") -czf $(Quote-BashArg $remoteArchive) $(($backupPaths | ForEach-Object { Quote-BashArg $_ }) -join ' ')",
    "chmod 600 $(Quote-BashArg $remoteArchive)"
) -join "; "

ssh $Server $remoteCommand
if ($LASTEXITCODE -ne 0) {
    throw "Remote backup archive creation failed"
}

scp "${Server}:$remoteArchive" $localArchive
if ($LASTEXITCODE -ne 0) {
    throw "Backup download failed"
}
ssh $Server "rm -f '$remoteArchive'"

$hash = Get-FileHash -Algorithm SHA256 -Path $localArchive
$status = [ordered]@{
    time = (Get-Date).ToString('o')
    server = $Server
    remote_dir = $RemoteDir
    include_secrets = [bool]$IncludeSecrets
    archive = $localArchive
    bytes = (Get-Item -LiteralPath $localArchive).Length
    sha256 = $hash.Hash
}
@(
    "time=$($status.time)"
    "server=$Server"
    "remote_dir=$RemoteDir"
    "include_secrets=$IncludeSecrets"
    "archive=$localArchive"
    "bytes=$($status.bytes)"
    "sha256=$($hash.Hash)"
) | Set-Content -Path $manifest -Encoding UTF8

$status | ConvertTo-Json | Set-Content -Path $latestStatus -Encoding UTF8

Get-ChildItem -Path $LocalBackupDir -Filter "chatbot-qq-server-*.tar.gz" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force

Write-Host "Backup saved: $localArchive"
Write-Host "Bytes: $($status.bytes)"
Write-Host "SHA256: $($hash.Hash)"

param(
    [string]$Server = "root@example.com",
    [string]$RemoteDir = "/opt/chatbot-qq",
    [string]$RemoteConfigDir = "/root/.cc-connect-qq",
    [switch]$InstallServices,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP ("chatbot-qq-deploy-{0}.tar" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$napCatJsonName = "Nap" + "Cat.json"
$onebotJsonGlob = ("onebot" + "11_*.json")
$onebotJsonRegex = ("onebot" + "11_.*\.json")
$deferredEvidencePacketRegex = '(?:docs/json-evidence-packet-optimization-plan\.md|scripts/build-dream-packet\.js|scripts/build-profile-update-packet\.js|scripts/lib/evidence-packet\.js)$'
$forbiddenArchivePathRegex = '^(?:\./)?(?:\.env(?:\..*)?$|\.cc-connect/|\.codex/|\.claude/|backup/|tmp/|tools/|users/|runs/|memory/|node_modules/|chatbot-qq-qrcode\.png$|' + $deferredEvidencePacketRegex + '|' + [regex]::Escape($napCatJsonName) + '$|' + $onebotJsonRegex + '$|configs/' + [regex]::Escape($napCatJsonName) + '$|configs/' + $onebotJsonRegex + '$|configs/.*\.local\.toml(?:\.bak-.*)?$|configs/.*\.lock$|.*\.(?:log|sqlite|sqlite3|db)$|groups/[^/]+/(?:members|memory|local_files|files)/)'

trap {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    throw
}

function Invoke-RemoteBash {
    param(
        [string]$Script
    )
    if ($DryRun) {
        throw "Invoke-RemoteBash called during -DryRun"
    }
    $normalized = ($Script -replace "`r", "").TrimEnd() + "`n"
    $localScript = Join-Path $env:TEMP ("chatbot-qq-remote-{0}.sh" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"))
    $remoteScript = "/tmp/chatbot-qq-remote-$([IO.Path]::GetFileNameWithoutExtension($localScript)).sh"
    try {
        [IO.File]::WriteAllText($localScript, $normalized, [Text.UTF8Encoding]::new($false))
        scp $localScript "${Server}:$remoteScript"
        if ($LASTEXITCODE -ne 0) {
            throw "remote script upload failed with exit code $LASTEXITCODE"
        }
        ssh $Server "bash '$remoteScript'; code=`$?; rm -f '$remoteScript'; exit `$code"
        if ($LASTEXITCODE -ne 0) {
            throw "remote bash failed with exit code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -LiteralPath $localScript -Force -ErrorAction SilentlyContinue
    }
}

Set-Location $root

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Running publish private-data audit"
    node scripts/audit-private-data.js --scope Publish
    if ($LASTEXITCODE -ne 0) {
        throw "publish private-data audit failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Warning "node not found; skipping publish private-data audit"
}

Write-Host "Packaging $root"
tar `
    --exclude ".git" `
    --exclude ".codex" `
    --exclude ".claude" `
    --exclude "node_modules" `
    --exclude "__pycache__" `
    --exclude "*.pyc" `
    --exclude "tools" `
    --exclude ".env" `
    --exclude ".env.*" `
    --exclude "*.log" `
    --exclude "*.sqlite" `
    --exclude "*.sqlite3" `
    --exclude "*.db" `
    --exclude ".cc-connect" `
    --exclude "backup" `
    --exclude "tmp" `
    --exclude "runs" `
    --exclude "memory" `
    --exclude "users" `
    --exclude "docs/json-evidence-packet-optimization-plan.md" `
    --exclude "scripts/build-dream-packet.js" `
    --exclude "scripts/build-profile-update-packet.js" `
    --exclude "scripts/lib/evidence-packet.js" `
    --exclude "chatbot-qq-qrcode.png" `
    --exclude "groups/*/members" `
    --exclude "groups/*/memory" `
    --exclude "groups/*/local_files" `
    --exclude "groups/*/files" `
    --exclude $napCatJsonName `
    --exclude $onebotJsonGlob `
    --exclude "configs/$napCatJsonName" `
    --exclude "configs/$onebotJsonGlob" `
    --exclude "configs/*.local.toml" `
    --exclude "configs/*.local.toml.bak-*" `
    --exclude "configs/*.lock" `
    -cf $archive .

$archiveEntries = @(tar -tf $archive)
if ($LASTEXITCODE -ne 0) {
    throw "failed to list deployment archive"
}
$forbiddenEntries = @($archiveEntries | Where-Object { $_ -match $forbiddenArchivePathRegex })
if ($forbiddenEntries.Count -gt 0) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    throw "deployment archive contains forbidden runtime/private paths: $($forbiddenEntries[0..([Math]::Min($forbiddenEntries.Count, 10) - 1)] -join ', ')"
}

if ($DryRun) {
    $archiveInfo = Get-Item -LiteralPath $archive
    Write-Host "Dry run only. Archive created and checked locally."
    Write-Host ("Archive: {0}" -f $archive)
    Write-Host ("Bytes: {0}" -f $archiveInfo.Length)
    Write-Host ("Entries: {0}" -f $archiveEntries.Count)
    Write-Host "Forbidden runtime/private path check: OK"
    Remove-Item -LiteralPath $archive -Force
    return
}

Write-Host "Uploading to ${Server}:$RemoteDir"
ssh $Server "mkdir -p '$RemoteDir' '$RemoteConfigDir'"
scp $archive "${Server}:/tmp/chatbot-qq-deploy.tar"

Write-Host "Extracting without touching OpenClaw Feishu config"
Invoke-RemoteBash @"
set -e
test '$RemoteConfigDir' != '/root/.cc-connect'
test '$RemoteDir' != '/opt/openclaw'
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y imagemagick librsvg2-bin fonts-noto-cjk
else
  echo 'WARN: apt-get not found; install ImageMagick, librsvg2-bin, and CJK fonts manually for Linux answer-image rendering' >&2
fi
mkdir -p '$RemoteDir' '$RemoteConfigDir'
tar -xf /tmp/chatbot-qq-deploy.tar -C '$RemoteDir'
rm -f /tmp/chatbot-qq-deploy.tar
mkdir -p '$RemoteDir/.cc-connect/codex-home'
if [ -d /root/.codex ] && [ ! -f '$RemoteDir/.cc-connect/codex-home/config.toml' ]; then
  cp -a /root/.codex/. '$RemoteDir/.cc-connect/codex-home/'
fi
chmod -R go-rwx '$RemoteDir/.cc-connect/codex-home'
find '$RemoteDir/groups' -path '*/scripts/dream.sh' -type f -exec chmod +x {} \;
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.sh'
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-cleanup.sh'
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-permission-audit.sh'
chmod +x '$RemoteDir/scripts/confirmed-qq-task-deploy.sh' '$RemoteDir/scripts/confirmed-qq-task-health.sh'
if [ ! -f '$RemoteConfigDir/config.toml' ]; then
  cp '$RemoteDir/configs/cc-connect.napcat.server.example.toml' '$RemoteConfigDir/config.toml'
fi
if [ ! -f /etc/chatbot-qq.env ]; then
  cp '$RemoteDir/deploy/linux/chatbot-qq.env.example' /etc/chatbot-qq.env
  chmod 600 /etc/chatbot-qq.env
fi
'$RemoteDir/deploy/linux/chatbot-qq-permission-audit.sh' --fix
chmod 755 '$RemoteDir/deploy/linux/wait-onebot-ports.sh'
cd '$RemoteDir'
if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev
else
  echo 'WARN: npm not found; install Node.js before starting onebot-group-proxy.service' >&2
fi
"@

if ($InstallServices) {
    Write-Host "Installing isolated QQ services"
    Invoke-RemoteBash @"
set -e
cp '$RemoteDir/deploy/linux/onebot-group-proxy.service' /etc/systemd/system/onebot-group-proxy.service
cp '$RemoteDir/deploy/linux/cc-connect-qq.service' /etc/systemd/system/cc-connect-qq.service
cp '$RemoteDir/deploy/linux/chatbot-qq-profile-update.service' /etc/systemd/system/chatbot-qq-profile-update.service
cp '$RemoteDir/deploy/linux/chatbot-qq-profile-update.timer' /etc/systemd/system/chatbot-qq-profile-update.timer
cp '$RemoteDir/deploy/linux/cc-connect-qq-provider-failover.service' /etc/systemd/system/cc-connect-qq-provider-failover.service
cp '$RemoteDir/deploy/linux/cc-connect-qq-provider-failover.timer' /etc/systemd/system/cc-connect-qq-provider-failover.timer
cp '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.service' /etc/systemd/system/chatbot-qq-integrity-check.service
cp '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.timer' /etc/systemd/system/chatbot-qq-integrity-check.timer
cp '$RemoteDir/deploy/linux/chatbot-qq-cleanup.service' /etc/systemd/system/chatbot-qq-cleanup.service
cp '$RemoteDir/deploy/linux/chatbot-qq-cleanup.timer' /etc/systemd/system/chatbot-qq-cleanup.timer
systemctl daemon-reload
systemctl enable onebot-group-proxy.service cc-connect-qq.service chatbot-qq-profile-update.timer cc-connect-qq-provider-failover.timer chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
echo 'Services installed but not started. Start after NapCat is logged in and ws://127.0.0.1:3001 is ready.'
"@
}

Remove-Item -LiteralPath $archive -Force

Write-Host "Done. Feishu service was not modified."
Write-Host "Next checks:"
Write-Host "  ssh $Server 'systemctl is-active cc-connect; ss -ltnp | grep -E `"3001|3002|3003|3005|3006|3007|3008|3009`" || true'"
Write-Host "  ssh $Server 'systemctl start onebot-group-proxy cc-connect-qq'"

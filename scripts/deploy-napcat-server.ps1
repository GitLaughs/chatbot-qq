param(
    [string]$Server = "root@203.0.113.10",
    [string]$RemoteDir = "/opt/chatbot-qq",
    [string]$RemoteConfigDir = "/root/.cc-connect-qq",
    [switch]$InstallServices
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP ("chatbot-qq-deploy-{0}.tar" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

Set-Location $root

Write-Host "Packaging $root"
tar `
    --exclude ".git" `
    --exclude "__pycache__" `
    --exclude "*.pyc" `
    --exclude "tools" `
    --exclude "*.log" `
    --exclude ".cc-connect" `
    --exclude "configs/*.local.toml" `
    --exclude "configs/*.lock" `
    -cf $archive .

Write-Host "Uploading to ${Server}:$RemoteDir"
ssh $Server "mkdir -p '$RemoteDir' '$RemoteConfigDir'"
scp $archive "${Server}:/tmp/chatbot-qq-deploy.tar"

Write-Host "Extracting without touching OpenClaw Feishu config"
ssh $Server @"
set -e
test '$RemoteConfigDir' != '/root/.cc-connect'
test '$RemoteDir' != '/opt/openclaw'
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y imagemagick fonts-noto-cjk
else
  echo 'WARN: apt-get not found; install ImageMagick and CJK fonts manually for Linux answer-image rendering' >&2
fi
mkdir -p '$RemoteDir' '$RemoteConfigDir'
tar -xf /tmp/chatbot-qq-deploy.tar -C '$RemoteDir'
rm -f /tmp/chatbot-qq-deploy.tar
find '$RemoteDir/groups' -path '*/scripts/dream.sh' -type f -exec chmod +x {} \;
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.sh'
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-cleanup.sh'
chmod +x '$RemoteDir/deploy/linux/chatbot-qq-permission-audit.sh'
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
    ssh $Server @"
set -e
cp '$RemoteDir/deploy/linux/onebot-group-proxy.service' /etc/systemd/system/onebot-group-proxy.service
cp '$RemoteDir/deploy/linux/cc-connect-qq.service' /etc/systemd/system/cc-connect-qq.service
cp '$RemoteDir/deploy/linux/cc-connect-qq-provider-failover.service' /etc/systemd/system/cc-connect-qq-provider-failover.service
cp '$RemoteDir/deploy/linux/cc-connect-qq-provider-failover.timer' /etc/systemd/system/cc-connect-qq-provider-failover.timer
cp '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.service' /etc/systemd/system/chatbot-qq-integrity-check.service
cp '$RemoteDir/deploy/linux/chatbot-qq-integrity-check.timer' /etc/systemd/system/chatbot-qq-integrity-check.timer
cp '$RemoteDir/deploy/linux/chatbot-qq-cleanup.service' /etc/systemd/system/chatbot-qq-cleanup.service
cp '$RemoteDir/deploy/linux/chatbot-qq-cleanup.timer' /etc/systemd/system/chatbot-qq-cleanup.timer
systemctl daemon-reload
systemctl enable onebot-group-proxy.service cc-connect-qq.service cc-connect-qq-provider-failover.timer chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer
echo 'Services installed but not started. Start after NapCat is logged in and ws://127.0.0.1:3001 is ready.'
"@
}

Remove-Item -LiteralPath $archive -Force

Write-Host "Done. Feishu service was not modified."
Write-Host "Next checks:"
Write-Host "  ssh $Server 'systemctl is-active cc-connect; ss -ltnp | grep -E `"3001|3002|3003|3005|3006|3007|3008|3009`" || true'"
Write-Host "  ssh $Server 'systemctl start onebot-group-proxy cc-connect-qq'"

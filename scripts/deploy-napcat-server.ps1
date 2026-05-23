param(
    [string]$Server = "root@43.108.37.203",
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
    --exclude "tools" `
    --exclude "*.log" `
    --exclude ".cc-connect" `
    --exclude "configs/*.local.toml" `
    --exclude "configs/*.lock" `
    --exclude "groups/sandbox-*" `
    --exclude "users" `
    -cf $archive .

Write-Host "Uploading to ${Server}:$RemoteDir"
ssh $Server "mkdir -p '$RemoteDir' '$RemoteConfigDir'"
scp $archive "${Server}:/tmp/chatbot-qq-deploy.tar"

Write-Host "Extracting without touching OpenClaw Feishu config"
ssh $Server @"
set -e
test '$RemoteConfigDir' != '/root/.cc-connect'
test '$RemoteDir' != '/opt/openclaw'
mkdir -p '$RemoteDir' '$RemoteConfigDir'
tar -xf /tmp/chatbot-qq-deploy.tar -C '$RemoteDir'
rm -f /tmp/chatbot-qq-deploy.tar
find '$RemoteDir/groups' -path '*/scripts/dream.sh' -type f -exec chmod +x {} \;
if [ ! -f '$RemoteConfigDir/config.toml' ]; then
  cp '$RemoteDir/configs/cc-connect.napcat.server.example.toml' '$RemoteConfigDir/config.toml'
fi
if [ ! -f /etc/chatbot-qq.env ]; then
  cp '$RemoteDir/deploy/linux/chatbot-qq.env.example' /etc/chatbot-qq.env
  chmod 600 /etc/chatbot-qq.env
fi
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
systemctl daemon-reload
systemctl enable onebot-group-proxy.service cc-connect-qq.service cc-connect-qq-provider-failover.timer
echo 'Services installed but not started. Start after NapCat is logged in and ws://127.0.0.1:3001 is ready.'
"@
}

Remove-Item -LiteralPath $archive -Force

Write-Host "Done. Feishu service was not modified."
Write-Host "Next checks:"
Write-Host "  ssh $Server 'systemctl is-active cc-connect; ss -ltnp | grep -E `"3001|3002|3003|3004|3005|3006`" || true'"
Write-Host "  ssh $Server 'systemctl start onebot-group-proxy cc-connect-qq'"

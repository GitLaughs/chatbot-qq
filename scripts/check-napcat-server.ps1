param(
    [string]$Server = "root@43.108.37.203",
    [string]$LocalBackupDir = "E:\CHATBOT-QQ\backup\server-daily"
)

$ErrorActionPreference = "Continue"

ssh $Server @'
echo "== Feishu service must remain active =="
systemctl is-active cc-connect || true

echo
echo "== QQ services =="
systemctl is-active onebot-group-proxy cc-connect-qq 2>/dev/null || true
systemctl is-active chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer 2>/dev/null || true

echo
echo "== Listen ports =="
ss -ltnp | grep -E '(:3001|:3002|:3003|:3005|:3006|:3007|:3008|:3009|:3010|:18081)' || true

echo
echo "== OneBot proxy health =="
curl -fsS http://127.0.0.1:3010/healthz 2>/dev/null || true

echo
echo "== Config isolation =="
test -f /root/.cc-connect/config.toml && echo "Feishu config present: /root/.cc-connect/config.toml"
test -f /root/.cc-connect-qq/config.toml && echo "QQ config present: /root/.cc-connect-qq/config.toml"

echo
echo "== Recent QQ logs =="
tail -n 80 /var/log/onebot-group-proxy.log 2>/dev/null || true
tail -n 80 /var/log/cc-connect-qq.log 2>/dev/null || true
tail -n 20 /var/log/chatbot-qq-integrity.log 2>/dev/null || true
tail -n 20 /var/log/chatbot-qq-cleanup.log 2>/dev/null || true
'@

Write-Host
Write-Host "== Local backup status =="
& (Join-Path $PSScriptRoot "check-backup-status.ps1") -LocalBackupDir $LocalBackupDir

Write-Host
Write-Host "== Latest health report =="
$healthLatest = Join-Path (Split-Path -Parent $LocalBackupDir) "health-reports\LATEST.json"
if (Test-Path $healthLatest) {
    $health = Get-Content -Raw -Path $healthLatest | ConvertFrom-Json
    [ordered]@{
        ok = $health.ok
        time = $health.time
        server = $health.server
        failures = $health.failures
        backup_ok = $health.backup.ok
        integrity_ok = $health.integrity.ok
        integrity_state = $health.integrity.state
        permissions_ok = $health.permissions.ok
        permissions_state = $health.permissions.state
        proxy_ok = $health.proxy.health.ok
    } | ConvertTo-Json -Depth 6
} else {
    Write-Host "No health report found under $(Split-Path -Parent $healthLatest)"
}

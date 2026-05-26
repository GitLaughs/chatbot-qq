param(
    [string]$Server = "root@43.108.37.203",
    [string]$LocalBackupDir = "C:\chatbot-qq\backup\server-daily",
    [switch]$RawHealth,
    [switch]$IncludeLogs
)

$ErrorActionPreference = "Continue"

function Invoke-RemoteBash {
    param(
        [string]$Script
    )
    $normalized = ($Script -replace "`r", "").TrimEnd() + "`n"
    $localScript = Join-Path $env:TEMP ("chatbot-qq-check-{0}.sh" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"))
    $remoteScript = "/tmp/chatbot-qq-check-$([IO.Path]::GetFileNameWithoutExtension($localScript)).sh"
    try {
        [IO.File]::WriteAllText($localScript, $normalized, [Text.UTF8Encoding]::new($false))
        scp $localScript "${Server}:$remoteScript"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "remote health script upload failed with exit code $LASTEXITCODE"
            return
        }
        ssh $Server "bash '$remoteScript'; code=`$?; rm -f '$remoteScript'; exit `$code"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "remote health script failed with exit code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -LiteralPath $localScript -Force -ErrorAction SilentlyContinue
    }
}

if ($RawHealth) {
    $rawHealthValue = "1"
} else {
    $rawHealthValue = "0"
}
if ($IncludeLogs) {
    $includeLogsValue = "1"
} else {
    $includeLogsValue = "0"
}

$remoteScript = "RAW_HEALTH=$rawHealthValue`nINCLUDE_LOGS=$includeLogsValue`n" + @'
echo "== Feishu service must remain active =="
systemctl is-active cc-connect || true

echo
echo "== QQ services =="
systemctl is-active onebot-group-proxy cc-connect-qq 2>/dev/null || true
systemctl is-active chatbot-qq-integrity-check.timer chatbot-qq-cleanup.timer cc-connect-qq-provider-failover.timer 2>/dev/null || true

echo
echo "== Listen ports =="
ss -ltnp | grep -E '(:3001|:3002|:3003|:3005|:3006|:3007|:3008|:3009|:13110|:18081)' || true

echo
echo "== OneBot proxy health =="
health_file="$(mktemp /tmp/chatbot-qq-health.XXXXXX.json)"
trap 'rm -f "$health_file"' EXIT
if curl -fsS http://127.0.0.1:13110/healthz >"$health_file" 2>/dev/null; then
  if [ "$RAW_HEALTH" = "1" ]; then
    cat "$health_file"
    echo
  elif command -v node >/dev/null 2>&1; then
    node - "$health_file" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const health = JSON.parse(fs.readFileSync(file, "utf8"));
const checks = health.capabilities && health.capabilities.checks ? health.capabilities.checks : {};
const failedChecks = Object.entries(checks)
  .filter(([, value]) => value && typeof value === "object" && value.ok === false)
  .map(([name]) => name);
const summary = {
  ok: health.ok,
  time: health.time || "",
  upstream_ready: Boolean(health.upstream && health.upstream.ready),
  upstream_socket_state: health.upstream ? health.upstream.socket_state : null,
  required_ports: health.required_ports || [],
  ports: health.ports || {},
  proxy_clients: checks.proxy_clients && checks.proxy_clients.detail ? checks.proxy_clients.detail : "",
  pending: health.pending || {},
  recent_error_count: Array.isArray(health.recent_errors) ? health.recent_errors.length : 0,
  failed_checks: failedChecks,
  default_listen: health.capabilities && health.capabilities.mode ? health.capabilities.mode.default_listen : ""
};
console.log(JSON.stringify(summary));
NODE
  else
    echo "healthz ok, bytes=$(wc -c < "$health_file" | tr -d ' ')"
  fi
else
  echo "healthz unavailable"
fi

echo
echo "== Config isolation =="
test -f /root/.cc-connect/config.toml && echo "Feishu config present: /root/.cc-connect/config.toml"
test -f /root/.cc-connect-qq/config.toml && echo "QQ config present: /root/.cc-connect-qq/config.toml"

echo
echo "== Log files =="
for file in /var/log/onebot-group-proxy.log /var/log/cc-connect-qq.log /var/log/chatbot-qq-integrity.log /var/log/chatbot-qq-cleanup.log; do
  if [ -f "$file" ]; then
    stat -c '%n size=%s mtime=%y' "$file" 2>/dev/null || true
  else
    echo "$file missing"
  fi
done
if [ "$INCLUDE_LOGS" = "1" ]; then
  echo
  echo "== Recent QQ logs (explicit IncludeLogs) =="
  tail -n 80 /var/log/onebot-group-proxy.log 2>/dev/null || true
  tail -n 80 /var/log/cc-connect-qq.log 2>/dev/null || true
  tail -n 20 /var/log/chatbot-qq-integrity.log 2>/dev/null || true
  tail -n 20 /var/log/chatbot-qq-cleanup.log 2>/dev/null || true
fi
'@

Invoke-RemoteBash $remoteScript

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

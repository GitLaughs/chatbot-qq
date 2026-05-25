param(
    [string]$Server = "root@43.108.37.203",
    [string]$RemoteQqDir = "/opt/chatbot-qq",
    [string]$RemoteFeishuDir = "/opt/openclaw",
    [string]$LocalBackupDir = "C:\chatbot-qq\backup\server-migration",
    [switch]$WithoutSecrets,
    [switch]$IncludeLogs,
    [switch]$InventoryOnly
)

$ErrorActionPreference = "Stop"

function Write-RemoteScript {
    param(
        [string]$Script
    )
    $localScript = Join-Path $env:TEMP ("chatbot-qq-migration-{0}.sh" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"))
    $remoteScript = "/tmp/chatbot-qq-migration-$([IO.Path]::GetFileNameWithoutExtension($localScript)).sh"
    [IO.File]::WriteAllText($localScript, (($Script -replace "`r", "").TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
    try {
        scp $localScript "${Server}:$remoteScript"
        if ($LASTEXITCODE -ne 0) {
            throw "remote migration script upload failed with exit code $LASTEXITCODE"
        }
        return $remoteScript
    } finally {
        Remove-Item -LiteralPath $localScript -Force -ErrorAction SilentlyContinue
    }
}

New-Item -ItemType Directory -Force -Path $LocalBackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteArchive = "/tmp/chatbot-qq-full-migration-$stamp.tar.gz"
$remoteInventoryArchive = "/tmp/chatbot-qq-full-migration-inventory-$stamp.tar.gz"
$localArchive = Join-Path $LocalBackupDir "chatbot-qq-full-migration-$stamp.tar.gz"
$localInventoryArchive = Join-Path $LocalBackupDir "chatbot-qq-full-migration-inventory-$stamp.tar.gz"
$manifest = Join-Path $LocalBackupDir "MANIFEST-$stamp.txt"
$latestStatus = Join-Path $LocalBackupDir "LATEST.json"

$includeSecretsValue = if ($WithoutSecrets) { "0" } else { "1" }
$includeLogsValue = if ($IncludeLogs) { "1" } else { "0" }
$inventoryOnlyValue = if ($InventoryOnly) { "1" } else { "0" }

function ConvertTo-BashLiteral([string]$Value) {
    return "'" + ($Value -replace "'", "'\''") + "'"
}

$remoteScriptTemplate = @'
set -euo pipefail

STAMP=__STAMP__
REMOTE_QQ_DIR=__REMOTE_QQ_DIR__
REMOTE_FEISHU_DIR=__REMOTE_FEISHU_DIR__
INCLUDE_SECRETS=__INCLUDE_SECRETS__
INCLUDE_LOGS=__INCLUDE_LOGS__
INVENTORY_ONLY=__INVENTORY_ONLY__
ARCHIVE=__ARCHIVE__
INVENTORY_ARCHIVE=__INVENTORY_ARCHIVE__
STAGE="/tmp/chatbot-qq-full-migration-$STAMP"
INVENTORY="$STAGE/inventory"
INCLUDE_FILE="$STAGE/include-paths.txt"

rm -rf "$STAGE" "$ARCHIVE" "$INVENTORY_ARCHIVE"
mkdir -p "$INVENTORY"
: > "$INCLUDE_FILE"

capture() {
  name="$1"
  shift
  bash -lc "$*" > "$INVENTORY/${name}.txt" 2>&1 || true
}

add_path() {
  path="$1"
  if [ -e "$path" ]; then
    printf '%s\n' "${path#/}" >> "$INCLUDE_FILE"
  fi
}

add_matching_units() {
  find /etc/systemd/system -maxdepth 1 -type f \
    \( -name 'cc-connect*.service' -o -name 'cc-connect*.timer' -o -name 'onebot*.service' -o -name 'onebot*.timer' -o -name 'chatbot-qq*.service' -o -name 'chatbot-qq*.timer' -o -name 'openclaw*.service' -o -name 'openclaw*.timer' \) \
    -printf '%p\n' 2>/dev/null | while IFS= read -r unit; do add_path "$unit"; done
}

cat > "$INVENTORY/README.txt" <<EOF
Created: $(date -Is)
Host: $(hostname 2>/dev/null || true)
Server-side archive: $ARCHIVE
QQ dir: $REMOTE_QQ_DIR
Feishu/OpenClaw dir: $REMOTE_FEISHU_DIR
Includes secrets: $INCLUDE_SECRETS
Includes logs: $INCLUDE_LOGS

This migration package is for moving the current server to a new host.
It may contain API keys, cookies, local auth state, QQ/NapCat login state, Feishu config, chat data, and Codex auth.
Keep it offline or encrypted. Do not commit it.
EOF

capture os-release 'cat /etc/os-release; uname -a; hostnamectl 2>/dev/null || true'
capture command-paths 'for c in node npm pnpm yarn cc-connect codex python3 pip3 go git docker docker-compose systemctl journalctl nginx caddy tar rsync; do printf "%s: " "$c"; command -v "$c" || true; done'
capture versions 'node -v 2>/dev/null; npm -v 2>/dev/null; python3 --version 2>/dev/null; go version 2>/dev/null; cc-connect --version 2>/dev/null; codex --version 2>/dev/null; docker --version 2>/dev/null; docker compose version 2>/dev/null'
capture services 'systemctl --no-pager --full status cc-connect onebot-group-proxy cc-connect-qq chatbot-qq-profile-update.timer chatbot-qq-cleanup.timer chatbot-qq-integrity-check.timer cc-connect-qq-provider-failover.timer 2>/dev/null || true'
capture service-files 'for u in cc-connect.service onebot-group-proxy.service cc-connect-qq.service chatbot-qq-profile-update.service chatbot-qq-profile-update.timer chatbot-qq-cleanup.service chatbot-qq-cleanup.timer chatbot-qq-integrity-check.service chatbot-qq-integrity-check.timer cc-connect-qq-provider-failover.service cc-connect-qq-provider-failover.timer; do echo "===== $u"; systemctl cat "$u" 2>/dev/null || true; done'
capture timers 'systemctl list-timers --all --no-pager'
capture ports 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true'
capture processes 'ps auxww | grep -E "cc-connect|onebot|NapCat|napcat|openclaw|codex|node" | grep -v grep || true'
capture disk-usage 'for p in /opt/chatbot-qq /opt/openclaw /root/.cc-connect /root/.cc-connect-qq /root/.codex /root/.codex-qq-home /var/lib/chatbot-qq-integrity /root/.config/QQ/NapCat /opt/napcat /root/napcat; do [ -e "$p" ] && du -sh "$p"; done'
capture path-tree 'for p in /opt/chatbot-qq /opt/openclaw /root/.cc-connect /root/.cc-connect-qq /var/lib/chatbot-qq-integrity; do [ -e "$p" ] && { echo "===== $p"; find "$p" -maxdepth 3 -mindepth 1 -printf "%y %p\n" | sort | head -1000; }; done'
capture apt-manual 'apt-mark showmanual 2>/dev/null || true'
capture dpkg-list 'dpkg-query -W -f="${binary:Package}\t${Version}\n" 2>/dev/null || true'
capture npm-global 'npm list -g --depth=0 2>/dev/null || true'
capture docker 'docker ps -a 2>/dev/null || true; echo; docker images 2>/dev/null || true; echo; docker volume ls 2>/dev/null || true; echo; docker compose ls 2>/dev/null || true'
capture docker-inspect 'docker inspect napcat 2>/dev/null || true'
capture crontab 'crontab -l 2>/dev/null || true; ls -la /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly 2>/dev/null || true'
capture env-metadata 'for f in /etc/chatbot-qq.env /etc/openclaw.env /root/.cc-connect/config.toml /root/.cc-connect-qq/config.toml; do [ -e "$f" ] && stat -c "%n mode=%a owner=%U:%G size=%s mtime=%y" "$f"; done'
capture git-state 'for p in /opt/chatbot-qq /opt/openclaw; do if [ -d "$p/.git" ]; then echo "===== $p"; git -C "$p" status --short --branch; git -C "$p" rev-parse HEAD; git -C "$p" remote -v; fi; done'

add_path "$REMOTE_QQ_DIR"
add_path "$REMOTE_FEISHU_DIR"
add_path /var/lib/chatbot-qq-integrity
add_path /etc/nginx
add_path /etc/caddy
add_path /etc/cron.d
add_path /etc/docker/daemon.json
add_matching_units

if [ "$INCLUDE_SECRETS" = "1" ]; then
  add_path /etc/chatbot-qq.env
  add_path /etc/openclaw.env
  add_path /root/.cc-connect
  add_path /root/.cc-connect-qq
  add_path /root/.codex
  add_path /root/.codex-qq-home
  add_path /root/.config/QQ/NapCat
  add_path /opt/napcat
  add_path /root/napcat
fi

if [ "$INCLUDE_LOGS" = "1" ]; then
  find /var/log -maxdepth 1 -type f \
    \( -name 'cc-connect*.log*' -o -name 'onebot*.log*' -o -name 'chatbot-qq*.log*' -o -name 'openclaw*.log*' \) \
    -printf '%p\n' 2>/dev/null | while IFS= read -r log; do add_path "$log"; done
fi

sort -u "$INCLUDE_FILE" -o "$INCLUDE_FILE"
cp "$INCLUDE_FILE" "$INVENTORY/included-paths.txt"

tar -czf "$INVENTORY_ARCHIVE" -C "$STAGE" inventory
chmod 600 "$INVENTORY_ARCHIVE"

if [ "$INVENTORY_ONLY" != "1" ]; then
  tar --warning=no-file-changed --ignore-failed-read -czf "$ARCHIVE" -C / -T "$INCLUDE_FILE" -C "$STAGE" inventory
  chmod 600 "$ARCHIVE"
fi

echo "inventory_archive=$INVENTORY_ARCHIVE"
if [ "$INVENTORY_ONLY" != "1" ]; then
  echo "archive=$ARCHIVE"
fi
'@

$remoteScript = $remoteScriptTemplate.
    Replace("__STAMP__", (ConvertTo-BashLiteral $stamp)).
    Replace("__REMOTE_QQ_DIR__", (ConvertTo-BashLiteral $RemoteQqDir)).
    Replace("__REMOTE_FEISHU_DIR__", (ConvertTo-BashLiteral $RemoteFeishuDir)).
    Replace("__INCLUDE_SECRETS__", (ConvertTo-BashLiteral $includeSecretsValue)).
    Replace("__INCLUDE_LOGS__", (ConvertTo-BashLiteral $includeLogsValue)).
    Replace("__INVENTORY_ONLY__", (ConvertTo-BashLiteral $inventoryOnlyValue)).
    Replace("__ARCHIVE__", (ConvertTo-BashLiteral $remoteArchive)).
    Replace("__INVENTORY_ARCHIVE__", (ConvertTo-BashLiteral $remoteInventoryArchive))

$uploadedScript = Write-RemoteScript -Script $remoteScript
try {
    ssh $Server "bash '$uploadedScript'; code=`$?; rm -f '$uploadedScript'; exit `$code"
    if ($LASTEXITCODE -ne 0) {
        throw "remote migration backup failed with exit code $LASTEXITCODE"
    }
} catch {
    ssh $Server "rm -f '$uploadedScript'" 2>$null | Out-Null
    throw
}

if ($InventoryOnly) {
    scp "${Server}:$remoteInventoryArchive" $localInventoryArchive
    if ($LASTEXITCODE -ne 0) {
        throw "inventory download failed"
    }
    ssh $Server "rm -f '$remoteInventoryArchive'"
    $hash = Get-FileHash -Algorithm SHA256 -Path $localInventoryArchive
    $archivePathForStatus = $localInventoryArchive
} else {
    scp "${Server}:$remoteArchive" $localArchive
    if ($LASTEXITCODE -ne 0) {
        throw "migration backup download failed"
    }
    scp "${Server}:$remoteInventoryArchive" $localInventoryArchive
    if ($LASTEXITCODE -ne 0) {
        throw "inventory download failed"
    }
    ssh $Server "rm -f '$remoteArchive' '$remoteInventoryArchive'"
    $hash = Get-FileHash -Algorithm SHA256 -Path $localArchive
    $archivePathForStatus = $localArchive
}

$archiveItem = Get-Item -LiteralPath $archivePathForStatus
$status = [ordered]@{
    time = (Get-Date).ToString('o')
    server = $Server
    qq_dir = $RemoteQqDir
    feishu_dir = $RemoteFeishuDir
    includes_secrets = -not [bool]$WithoutSecrets
    includes_logs = [bool]$IncludeLogs
    inventory_only = [bool]$InventoryOnly
    archive = $archivePathForStatus
    inventory_archive = $localInventoryArchive
    bytes = $archiveItem.Length
    sha256 = $hash.Hash
}

@(
    "time=$($status.time)"
    "server=$Server"
    "qq_dir=$RemoteQqDir"
    "feishu_dir=$RemoteFeishuDir"
    "includes_secrets=$($status.includes_secrets)"
    "includes_logs=$($status.includes_logs)"
    "inventory_only=$($status.inventory_only)"
    "archive=$archivePathForStatus"
    "inventory_archive=$localInventoryArchive"
    "bytes=$($status.bytes)"
    "sha256=$($hash.Hash)"
) | Set-Content -Path $manifest -Encoding UTF8

$status | ConvertTo-Json | Set-Content -Path $latestStatus -Encoding UTF8

Write-Host "Migration backup saved: $archivePathForStatus"
Write-Host "Inventory saved: $localInventoryArchive"
Write-Host "Bytes: $($status.bytes)"
Write-Host "SHA256: $($hash.Hash)"
if (-not $WithoutSecrets) {
    Write-Host "WARNING: archive includes secrets/auth state. Keep offline or encrypted. Do not commit."
}

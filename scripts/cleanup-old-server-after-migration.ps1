param(
    [string]$Server = "root@43.108.37.203",
    [Parameter(Mandatory = $true)]
    [string]$BackupArchive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [switch]$ConfirmCleanup,
    [switch]$KeepFeishu,
    [switch]$KeepRootCodex
)

$ErrorActionPreference = "Stop"

$archivePath = Resolve-Path -LiteralPath $BackupArchive
$hash = Get-FileHash -Algorithm SHA256 -Path $archivePath
if ($hash.Hash -ne $ExpectedSha256) {
    throw "backup SHA256 mismatch: expected=$ExpectedSha256 actual=$($hash.Hash)"
}

$confirmValue = if ($ConfirmCleanup) { "1" } else { "0" }
$keepFeishuValue = if ($KeepFeishu) { "1" } else { "0" }
$keepRootCodexValue = if ($KeepRootCodex) { "1" } else { "0" }

function ConvertTo-BashLiteral([string]$Value) {
    return "'" + ($Value -replace "'", "'\''") + "'"
}

$remoteScriptTemplate = @'
set -euo pipefail
CONFIRM=__CONFIRM__
KEEP_FEISHU=__KEEP_FEISHU__
KEEP_ROOT_CODEX=__KEEP_ROOT_CODEX__

run_or_print() {
  if [ "$CONFIRM" = "1" ]; then
    echo "+ $*"
    eval "$@"
  else
    echo "DRY-RUN: $*"
  fi
}

echo "Cleanup mode: confirm=$CONFIRM keep_feishu=$KEEP_FEISHU keep_root_codex=$KEEP_ROOT_CODEX"

QQ_UNITS="onebot-group-proxy.service cc-connect-qq.service chatbot-qq-profile-update.timer chatbot-qq-profile-update.service chatbot-qq-cleanup.timer chatbot-qq-cleanup.service chatbot-qq-integrity-check.timer chatbot-qq-integrity-check.service cc-connect-qq-provider-failover.timer cc-connect-qq-provider-failover.service"
FEISHU_UNITS="cc-connect.service"

run_or_print "systemctl stop $QQ_UNITS 2>/dev/null || true"
run_or_print "systemctl disable $QQ_UNITS 2>/dev/null || true"

if [ "$KEEP_FEISHU" != "1" ]; then
  run_or_print "systemctl stop $FEISHU_UNITS 2>/dev/null || true"
  run_or_print "systemctl disable $FEISHU_UNITS 2>/dev/null || true"
fi

if [ -f /opt/chatbot-qq/deploy/linux/docker-compose.yml ]; then
  run_or_print "cd /opt/chatbot-qq/deploy/linux && docker compose down 2>/dev/null || true"
fi
run_or_print "docker stop napcat 2>/dev/null || true"
run_or_print "docker rm napcat 2>/dev/null || true"

run_or_print "rm -f /etc/systemd/system/onebot-group-proxy.service /etc/systemd/system/cc-connect-qq.service /etc/systemd/system/chatbot-qq-profile-update.service /etc/systemd/system/chatbot-qq-profile-update.timer /etc/systemd/system/chatbot-qq-cleanup.service /etc/systemd/system/chatbot-qq-cleanup.timer /etc/systemd/system/chatbot-qq-integrity-check.service /etc/systemd/system/chatbot-qq-integrity-check.timer /etc/systemd/system/cc-connect-qq-provider-failover.service /etc/systemd/system/cc-connect-qq-provider-failover.timer"
if [ "$KEEP_FEISHU" != "1" ]; then
  run_or_print "rm -f /etc/systemd/system/cc-connect.service"
fi
run_or_print "systemctl daemon-reload"

run_or_print "rm -rf /opt/chatbot-qq /root/.cc-connect-qq /root/.codex-qq-home /etc/chatbot-qq.env /var/lib/chatbot-qq-integrity"
if [ "$KEEP_FEISHU" != "1" ]; then
  run_or_print "rm -rf /opt/openclaw /root/.cc-connect /etc/openclaw.env"
fi
if [ "$KEEP_ROOT_CODEX" != "1" ]; then
  run_or_print "rm -rf /root/.codex"
fi
run_or_print "rm -f /var/log/onebot-group-proxy.log* /var/log/cc-connect-qq.log* /var/log/chatbot-qq-*.log*"
if [ "$KEEP_FEISHU" != "1" ]; then
  run_or_print "rm -f /var/log/cc-connect.log* /var/log/openclaw*.log*"
fi

echo "Cleanup script finished."
'@

$remoteScript = $remoteScriptTemplate.
    Replace("__CONFIRM__", (ConvertTo-BashLiteral $confirmValue)).
    Replace("__KEEP_FEISHU__", (ConvertTo-BashLiteral $keepFeishuValue)).
    Replace("__KEEP_ROOT_CODEX__", (ConvertTo-BashLiteral $keepRootCodexValue))

$localScript = Join-Path $env:TEMP ("chatbot-qq-cleanup-{0}.sh" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"))
$remoteScriptPath = "/tmp/chatbot-qq-cleanup-$([IO.Path]::GetFileNameWithoutExtension($localScript)).sh"
[IO.File]::WriteAllText($localScript, (($remoteScript -replace "`r", "").TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))
try {
    scp $localScript "${Server}:$remoteScriptPath"
    if ($LASTEXITCODE -ne 0) {
        throw "cleanup script upload failed with exit code $LASTEXITCODE"
    }
    ssh $Server "bash '$remoteScriptPath'; code=`$?; rm -f '$remoteScriptPath'; exit `$code"
    if ($LASTEXITCODE -ne 0) {
        throw "cleanup script failed with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -LiteralPath $localScript -Force -ErrorAction SilentlyContinue
}

if ($ConfirmCleanup) {
    Write-Host "Cleanup completed on $Server"
} else {
    Write-Host "Dry-run only. Re-run with -ConfirmCleanup after the new server is verified."
}

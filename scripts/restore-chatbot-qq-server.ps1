param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [string]$Server = "root@43.108.37.203",
    [string]$RemoteDir = "/opt/chatbot-qq",
    [string]$RemoteConfigDir = "/root/.cc-connect-qq",
    [switch]$RestoreSecrets,
    [switch]$RestartServices
)

$ErrorActionPreference = "Stop"

$archivePath = Resolve-Path -LiteralPath $Archive
$remoteArchive = "/tmp/chatbot-qq-restore.tar.gz"
$remoteStage = "/tmp/chatbot-qq-restore-stage"

Write-Host "Uploading backup: $archivePath"
scp $archivePath "${Server}:$remoteArchive"

$secretBlock = if ($RestoreSecrets) {
@"
if [ -f "$remoteStage/etc/chatbot-qq.env" ]; then
  cp "$remoteStage/etc/chatbot-qq.env" /etc/chatbot-qq.env
  chmod 600 /etc/chatbot-qq.env
fi
if [ -f "$remoteStage/root/.cc-connect-qq/config.toml" ]; then
  mkdir -p '$RemoteConfigDir'
  cp "$remoteStage/root/.cc-connect-qq/config.toml" '$RemoteConfigDir/config.toml'
  chmod 600 '$RemoteConfigDir/config.toml'
fi
"@
} else {
    "echo 'Skipping secrets restore. Use -RestoreSecrets only for trusted encrypted/offline backups.'"
}

$restartBlock = if ($RestartServices) {
@"
systemctl restart onebot-group-proxy.service
systemctl restart cc-connect-qq.service
"@
} else {
    "echo 'Services not restarted. Use -RestartServices after reviewing restored data.'"
}

ssh $Server @"
set -euo pipefail
test '$RemoteDir' != '/'
rm -rf '$remoteStage'
mkdir -p '$remoteStage' '$RemoteDir'
tar -xzf '$remoteArchive' -C '$remoteStage'
rm -f '$remoteArchive'

if [ -d '$remoteStage$RemoteDir/groups' ]; then
  mkdir -p '$RemoteDir/groups'
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete '$remoteStage$RemoteDir/groups/' '$RemoteDir/groups/'
  else
    rm -rf '$RemoteDir/groups'
    mkdir -p '$RemoteDir/groups'
    cp -a '$remoteStage$RemoteDir/groups/.' '$RemoteDir/groups/'
  fi
fi
if [ -d '$remoteStage$RemoteDir/users' ]; then
  mkdir -p '$RemoteDir/users'
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete '$remoteStage$RemoteDir/users/' '$RemoteDir/users/'
  else
    rm -rf '$RemoteDir/users'
    mkdir -p '$RemoteDir/users'
    cp -a '$remoteStage$RemoteDir/users/.' '$RemoteDir/users/'
  fi
fi
if [ -d '$remoteStage$RemoteDir/.cc-connect' ]; then
  mkdir -p '$RemoteDir/.cc-connect'
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete '$remoteStage$RemoteDir/.cc-connect/' '$RemoteDir/.cc-connect/'
  else
    rm -rf '$RemoteDir/.cc-connect'
    mkdir -p '$RemoteDir/.cc-connect'
    cp -a '$remoteStage$RemoteDir/.cc-connect/.' '$RemoteDir/.cc-connect/'
  fi
fi

$secretBlock

rm -rf /var/lib/chatbot-qq-integrity/sha256sums.txt
systemctl start chatbot-qq-integrity-check.service || true
$restartBlock
rm -rf '$remoteStage'
"@

Write-Host "Restore completed on $Server"

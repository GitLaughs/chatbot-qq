param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [string]$Server = "root@43.108.37.203",
    [string]$RemoteDir = "/opt/chatbot-qq"
)

$ErrorActionPreference = "Stop"

$archivePath = Resolve-Path -LiteralPath $Archive
$remoteArchive = "/tmp/chatbot-qq-restore-test.tar.gz"
$remoteStage = "/tmp/chatbot-qq-restore-test-stage"

Write-Host "Uploading backup for restore test: $archivePath"
scp $archivePath "${Server}:$remoteArchive"

ssh $Server @"
set -euo pipefail
rm -rf '$remoteStage'
mkdir -p '$remoteStage'
tar -tzf '$remoteArchive' >/tmp/chatbot-qq-restore-test-list.txt
tar -xzf '$remoteArchive' -C '$remoteStage'

test -d '$remoteStage$RemoteDir/groups'
test -d '$remoteStage$RemoteDir/users'
test -d '$remoteStage$RemoteDir/.cc-connect'

group_count=`$(find '$remoteStage$RemoteDir/groups' -mindepth 1 -maxdepth 1 -type d | wc -l)
user_count=`$(find '$remoteStage$RemoteDir/users' -mindepth 1 -maxdepth 1 -type d | wc -l)
session_count=`$(find '$remoteStage$RemoteDir/.cc-connect' -type f | wc -l)

echo "restore_test=ok"
echo "groups=`$group_count"
echo "users=`$user_count"
echo "cc_connect_files=`$session_count"

rm -rf '$remoteStage'
rm -f '$remoteArchive' /tmp/chatbot-qq-restore-test-list.txt
"@

Write-Host "Restore test completed without touching $RemoteDir"

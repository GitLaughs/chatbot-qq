param(
    [string]$LocalBackupDir = "E:\CHATBOT-QQ\backup\server-daily",
    [int]$MaxAgeHours = 30,
    [string]$TaskName = "CHATBOT-QQ server daily backup",
    [switch]$SkipTaskCheck
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$latest = Join-Path $LocalBackupDir "LATEST.json"

function Add-Failure($Message) {
    $script:failures.Add($Message) | Out-Null
}

Write-Host "== Backup status =="

if (-not (Test-Path $latest)) {
    Add-Failure "Missing backup status file: $latest"
} else {
    $status = Get-Content -Raw -Path $latest | ConvertFrom-Json
    $archive = [string]$status.archive
    $backupTime = [datetime]$status.time
    $ageHours = ((Get-Date) - $backupTime).TotalHours

    Write-Host "Latest: $archive"
    Write-Host ("Time: {0:o} ({1:N1} hours ago)" -f $backupTime, $ageHours)
    Write-Host "Bytes: $($status.bytes)"
    Write-Host "SHA256: $($status.sha256)"

    if ($ageHours -gt $MaxAgeHours) {
        Add-Failure ("Latest backup is too old: {0:N1}h > {1}h" -f $ageHours, $MaxAgeHours)
    }
    if (-not (Test-Path -LiteralPath $archive)) {
        Add-Failure "Backup archive is missing: $archive"
    } else {
        $item = Get-Item -LiteralPath $archive
        if ([int64]$status.bytes -ne $item.Length) {
            Add-Failure "Backup byte count mismatch: status=$($status.bytes), actual=$($item.Length)"
        }
        $hash = Get-FileHash -Algorithm SHA256 -Path $archive
        if ([string]$status.sha256 -ne $hash.Hash) {
            Add-Failure "Backup SHA256 mismatch: status=$($status.sha256), actual=$($hash.Hash)"
        }
    }
}

if (-not $SkipTaskCheck) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Add-Failure "Scheduled task not found: $TaskName"
    } else {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Task: $TaskName"
        Write-Host "Task state: $($task.State)"
        Write-Host "Last run: $($info.LastRunTime)"
        Write-Host "Last task result: $($info.LastTaskResult)"
        Write-Host "Next run: $($info.NextRunTime)"
        if ($task.State -eq "Disabled") {
            Add-Failure "Scheduled task is disabled: $TaskName"
        }
        if ($info.LastTaskResult -ne 0 -and $info.LastRunTime -gt [datetime]"2000-01-01") {
            Add-Failure "Scheduled task last result is non-zero: $($info.LastTaskResult)"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host "Backup status: FAIL"
    foreach ($failure in $failures) {
        Write-Host "- $failure"
    }
    exit 1
}

Write-Host "Backup status: OK"

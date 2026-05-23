param(
    [string]$Server = "root@203.0.113.10",
    [string]$LocalBackupDir = "E:\CHATBOT-QQ\backup\server-daily",
    [int]$BackupMaxAgeHours = 30,
    [switch]$NoExit
)

$ErrorActionPreference = "Stop"

function Invoke-RemoteText($Command) {
    $output = ssh $Server $Command 2>&1
    return ($output -join "`n")
}

function Test-BackupStatus {
    $failures = New-Object System.Collections.Generic.List[string]
    $latest = Join-Path $LocalBackupDir "LATEST.json"
    $result = [ordered]@{
        ok = $false
        latest_file = $latest
        failures = @()
    }

    if (-not (Test-Path $latest)) {
        $failures.Add("missing LATEST.json") | Out-Null
        $result.failures = @($failures)
        return $result
    }

    $status = Get-Content -Raw -Path $latest | ConvertFrom-Json
    $archive = [string]$status.archive
    $backupTime = [datetime]$status.time
    $ageHours = ((Get-Date) - $backupTime).TotalHours

    $result.time = $status.time
    $result.server = $status.server
    $result.archive = $archive
    $result.bytes = [int64]$status.bytes
    $result.sha256 = [string]$status.sha256
    $result.age_hours = [math]::Round($ageHours, 2)

    if ($ageHours -gt $BackupMaxAgeHours) {
        $failures.Add("backup too old: $([math]::Round($ageHours, 2))h > ${BackupMaxAgeHours}h") | Out-Null
    }
    if (-not (Test-Path -LiteralPath $archive)) {
        $failures.Add("archive missing: $archive") | Out-Null
    } else {
        $item = Get-Item -LiteralPath $archive
        $hash = Get-FileHash -Algorithm SHA256 -Path $archive
        $result.actual_bytes = $item.Length
        $result.actual_sha256 = $hash.Hash
        if ([int64]$status.bytes -ne $item.Length) {
            $failures.Add("archive byte count mismatch") | Out-Null
        }
        if ([string]$status.sha256 -ne $hash.Hash) {
            $failures.Add("archive sha256 mismatch") | Out-Null
        }
    }

    $task = Get-ScheduledTask -TaskName "CHATBOT-QQ server daily backup" -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName "CHATBOT-QQ server daily backup"
        $result.task = [ordered]@{
            found = $true
            state = [string]$task.State
            last_run_time = $info.LastRunTime
            last_task_result = $info.LastTaskResult
            next_run_time = $info.NextRunTime
        }
        if ($task.State -eq "Disabled") {
            $failures.Add("scheduled task disabled") | Out-Null
        }
        if ($info.LastTaskResult -ne 0 -and $info.LastRunTime -gt [datetime]"2000-01-01") {
            $failures.Add("scheduled task last result non-zero: $($info.LastTaskResult)") | Out-Null
        }
    } else {
        $result.task = @{ found = $false }
        $failures.Add("scheduled task missing") | Out-Null
    }

    $result.ok = $failures.Count -eq 0
    $result.failures = @($failures)
    return $result
}

$report = [ordered]@{
    time = (Get-Date).ToString("o")
    server = $Server
    ok = $false
    services = [ordered]@{}
    timers = [ordered]@{}
    proxy = [ordered]@{}
    backup = [ordered]@{}
    failures = @()
}
$failures = New-Object System.Collections.Generic.List[string]

$serviceNames = @("cc-connect", "onebot-group-proxy", "cc-connect-qq", "chatbot-qq-integrity-check.timer", "chatbot-qq-cleanup.timer")
foreach ($name in $serviceNames) {
    $state = (Invoke-RemoteText "systemctl is-active $name 2>/dev/null || true").Trim()
    if (-not $state) {
        $state = "unknown"
    }
    if ($name.EndsWith(".timer")) {
        $report.timers[$name] = $state
    } else {
        $report.services[$name] = $state
    }
    if ($state -ne "active") {
        $failures.Add("$name is $state") | Out-Null
    }
}

$healthRaw = Invoke-RemoteText "curl -fsS http://127.0.0.1:3010/healthz"
try {
    $health = $healthRaw | ConvertFrom-Json
    $report.proxy.health = $health
    if (-not $health.ok) {
        $failures.Add("proxy healthz is not ok") | Out-Null
    }
} catch {
    $report.proxy.health_error = $_.Exception.Message
    $report.proxy.health_raw = $healthRaw
    $failures.Add("proxy healthz parse failed") | Out-Null
}

$metricsRaw = Invoke-RemoteText "curl -fsS http://127.0.0.1:3010/metrics | head -80"
$report.proxy.metrics_preview = @($metricsRaw -split "`n" | Where-Object { $_ })
if ($metricsRaw -notmatch "chatbot_qq_up 1") {
    $failures.Add("metrics missing chatbot_qq_up 1") | Out-Null
}

$integrityTail = Invoke-RemoteText "tail -n 5 /var/log/chatbot-qq-integrity.log 2>/dev/null || true"
$cleanupTail = Invoke-RemoteText "tail -n 5 /var/log/chatbot-qq-cleanup.log 2>/dev/null || true"
$report.logs = [ordered]@{
    integrity_tail = @($integrityTail -split "`n" | Where-Object { $_ })
    cleanup_tail = @($cleanupTail -split "`n" | Where-Object { $_ })
}

$backup = Test-BackupStatus
$report.backup = $backup
if (-not $backup.ok) {
    foreach ($failure in $backup.failures) {
        $failures.Add("backup: $failure") | Out-Null
    }
}

$report.ok = $failures.Count -eq 0
$report.failures = @($failures)
$report | ConvertTo-Json -Depth 12

if (-not $report.ok -and -not $NoExit) {
    exit 1
}

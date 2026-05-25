param(
    [string]$Server = "root@43.108.37.203",
    [string]$LocalBackupDir = "C:\chatbot-qq\backup\server-daily",
    [string]$OutputDir = "C:\chatbot-qq\backup\health-reports",
    [string]$AlertDir = "C:\chatbot-qq\backup\health-alerts",
    [int]$BackupMaxAgeHours = 30,
    [int]$KeepDays = 14,
    [switch]$InstallScheduledTask,
    [switch]$IncludeSensitive,
    [switch]$NoExit
)

$ErrorActionPreference = "Stop"

if ($InstallScheduledTask) {
    $script = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\get-chatbot-qq-health-report.ps1"
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Server `"$Server`" -LocalBackupDir `"$LocalBackupDir`" -OutputDir `"$OutputDir`" -AlertDir `"$AlertDir`" -BackupMaxAgeHours $BackupMaxAgeHours -KeepDays $KeepDays"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args
    $trigger = New-ScheduledTaskTrigger -Daily -At 4:00am
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName "CHATBOT-QQ daily health report" -Action $action -Trigger $trigger -Settings $settings -Description "Generate a JSON operations health report for CHATBOT-QQ every day." -Force | Out-Null
    Write-Host "Scheduled task installed: CHATBOT-QQ daily health report"
    return
}

function Invoke-RemoteText($Command) {
    $output = ssh $Server $Command 2>&1
    return ($output -join "`n")
}

function Invoke-RemoteResult($Name, $Command) {
    $output = ssh $Server $Command 2>&1
    return [ordered]@{
        name = $Name
        command = $Command
        ok = $LASTEXITCODE -eq 0
        exit_code = $LASTEXITCODE
        output = @($output | Where-Object { $_ })
    }
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

function Mask-SensitiveValue($Value) {
    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [string]) {
        return $Value -replace '\b\d{6,12}\b', { param($m) Mask-Id $m.Value }
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
        $text = [string]$Value
        if ($text -match '^\d{6,12}$') {
            return Mask-Id $text
        }
        return $Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $copy[$key] = Mask-SensitiveValue $Value[$key]
        }
        return $copy
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @()
        foreach ($item in $Value) {
            $items += Mask-SensitiveValue $item
        }
        return $items
    }
    if ($Value.PSObject -and $Value.PSObject.Properties.Count -gt 0) {
        $copy = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $copy[$prop.Name] = Mask-SensitiveValue $prop.Value
        }
        return $copy
    }
    return $Value
}

function Mask-Id($Text) {
    if ($Text.Length -le 5) {
        return $Text
    }
    return "$($Text.Substring(0, 2))***$($Text.Substring($Text.Length - 2))"
}

function Mask-Text($Text) {
    return [regex]::Replace([string]$Text, '\b\d{6,12}\b', { param($m) Mask-Id $m.Value })
}

function Write-AlertState($Report, $Directory, $Stamp, $ReportPath) {
    if (-not $Directory) {
        return
    }

    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $activePath = Join-Path $Directory "ACTIVE.txt"
    $latestPath = Join-Path $Directory "ALERT.json"
    $okPath = Join-Path $Directory "OK.txt"

    $alert = [ordered]@{
        active = -not $Report.ok
        time = $Report.time
        server = $Report.server
        failures = @($Report.failures)
        report = $ReportPath
    }
    ($alert | ConvertTo-Json -Depth 8) | Set-Content -Path $latestPath -Encoding UTF8

    if ($Report.ok) {
        if (Test-Path -LiteralPath $activePath) {
            Remove-Item -LiteralPath $activePath -Force
        }
        "OK $($Report.time)" | Set-Content -Path $okPath -Encoding UTF8
        return
    }

    $summary = @(
        "CHATBOT-QQ health alert"
        "time: $($Report.time)"
        "server: $($Report.server)"
        "report: $ReportPath"
        "failures:"
    ) + @($Report.failures | ForEach-Object { "- $_" })
    $summaryText = ($summary -join "`n")
    $summaryText | Set-Content -Path $activePath -Encoding UTF8
    $summaryText | Set-Content -Path (Join-Path $Directory "chatbot-qq-health-alert-$Stamp.txt") -Encoding UTF8
}

$report = [ordered]@{
    time = (Get-Date).ToString("o")
    server = $Server
    ok = $false
    services = [ordered]@{}
    timers = [ordered]@{}
    proxy = [ordered]@{}
    refresh = [ordered]@{}
    backup = [ordered]@{}
    failures = @()
}
$failures = New-Object System.Collections.Generic.List[string]

$refreshChecks = @(
    @{ name = "integrity"; command = "systemctl start chatbot-qq-integrity-check.service" },
    @{ name = "permissions"; command = "/opt/chatbot-qq/deploy/linux/chatbot-qq-permission-audit.sh --fix" }
)
foreach ($check in $refreshChecks) {
    $result = Invoke-RemoteResult $check.name $check.command
    $report.refresh[$check.name] = $result
    if (-not $result.ok) {
        $failures.Add("refresh $($check.name) failed: exit $($result.exit_code)") | Out-Null
    }
}

$serviceNames = @("cc-connect", "onebot-group-proxy", "cc-connect-qq", "chatbot-qq-integrity-check.timer", "chatbot-qq-cleanup.timer", "cc-connect-qq-provider-failover.timer")
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
$integrityStatusRaw = Invoke-RemoteText "cat /var/lib/chatbot-qq-integrity/status.json 2>/dev/null || true"
$permissionStatusRaw = Invoke-RemoteText "cat /var/lib/chatbot-qq-integrity/permissions.json 2>/dev/null || true"
$report.logs = [ordered]@{
    integrity_tail = @($integrityTail -split "`n" | Where-Object { $_ })
    cleanup_tail = @($cleanupTail -split "`n" | Where-Object { $_ })
}
if ($integrityStatusRaw.Trim()) {
    try {
        $integrityStatus = $integrityStatusRaw | ConvertFrom-Json
        $report.integrity = $integrityStatus
        if (-not $integrityStatus.ok) {
            $failures.Add("integrity status is $($integrityStatus.state)") | Out-Null
        }
    } catch {
        $report.integrity = [ordered]@{
            ok = $false
            parse_error = $_.Exception.Message
            raw = $integrityStatusRaw
        }
        $failures.Add("integrity status parse failed") | Out-Null
    }
} else {
    $report.integrity = [ordered]@{
        ok = $false
        state = "missing"
    }
    $failures.Add("integrity status missing") | Out-Null
}

if ($permissionStatusRaw.Trim()) {
    try {
        $permissionStatus = $permissionStatusRaw | ConvertFrom-Json
        $report.permissions = $permissionStatus
        if (-not $permissionStatus.ok) {
            $failures.Add("permission audit is $($permissionStatus.state)") | Out-Null
        }
    } catch {
        $report.permissions = [ordered]@{
            ok = $false
            parse_error = $_.Exception.Message
            raw = $permissionStatusRaw
        }
        $failures.Add("permission audit parse failed") | Out-Null
    }
} else {
    $report.permissions = [ordered]@{
        ok = $false
        state = "missing"
    }
    $failures.Add("permission audit status missing") | Out-Null
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
if (-not $IncludeSensitive) {
    if ($report.proxy.health) {
        $report.proxy.health.allowed_groups = @($report.proxy.health.allowed_groups | ForEach-Object { Mask-Id ([string]$_) })
        $report.proxy.health.allowed_private_users = @($report.proxy.health.allowed_private_users | ForEach-Object { Mask-Id ([string]$_) })
        $report.proxy.health.quiet_groups = [ordered]@{}
    }
    if ($report.logs) {
        $report.logs.integrity_tail = @($report.logs.integrity_tail | ForEach-Object { Mask-Text $_ })
        $report.logs.cleanup_tail = @($report.logs.cleanup_tail | ForEach-Object { Mask-Text $_ })
    }
    if ($report.integrity) {
        $report.integrity.root = Mask-Text $report.integrity.root
        $report.integrity.manifest = Mask-Text $report.integrity.manifest
    }
    if ($report.permissions) {
        $report.permissions.root = Mask-Text $report.permissions.root
        $report.permissions.violations = @($report.permissions.violations | ForEach-Object { Mask-Text $_ })
    }
    if ($report.backup) {
        $report.backup.server = Mask-Text $report.backup.server
        $report.backup.archive = Mask-Text $report.backup.archive
    }
}
$json = $report | ConvertTo-Json -Depth 12
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = $null

if ($OutputDir) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $reportPath = Join-Path $OutputDir "chatbot-qq-health-$stamp.json"
    $latestPath = Join-Path $OutputDir "LATEST.json"
    $json | Set-Content -Path $reportPath -Encoding UTF8
    $json | Set-Content -Path $latestPath -Encoding UTF8
    Get-ChildItem -Path $OutputDir -Filter "chatbot-qq-health-*.json" |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
        Remove-Item -Force
}

Write-AlertState $report $AlertDir $stamp $reportPath

$json

if (-not $report.ok -and -not $NoExit) {
    exit 1
}

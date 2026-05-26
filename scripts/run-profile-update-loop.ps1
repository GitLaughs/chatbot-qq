param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [int]$IntervalMinutes = 180,
    [int]$InitialDelayMinutes = 15,
    [switch]$RunImmediately,
    [string]$LogPath = ""
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Resolve-LocalPath {
    param([string]$Path)
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Get-StableHash {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text.ToLowerInvariant())
        return -join ($sha.ComputeHash($bytes)[0..7] | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha.Dispose()
    }
}

function Write-LoopLog {
    param([string]$Message)
    $dir = Split-Path -Parent $script:LogPath
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

function Invoke-ProfileUpdateOnce {
    $scriptPath = Join-Path $script:Root "scripts\update-user-profiles.ps1"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        Write-LoopLog "missing updater: $scriptPath"
        return
    }

    Write-LoopLog "profile update start"
    try {
        $output = & $scriptPath -Root $script:Root -All 2>&1
        $exitCode = $LASTEXITCODE
        foreach ($line in $output) {
            Write-LoopLog "profile update: $line"
        }
        Write-LoopLog "profile update exit code=$exitCode"
    }
    catch {
        Write-LoopLog "profile update error: $($_.Exception.Message)"
    }
}

$Root = Resolve-LocalPath $Root
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $Root "logs\profile-update-loop.log"
}
else {
    $LogPath = Resolve-LocalPath $LogPath
}

$mutexName = "Global\chatbot-qq-profile-update-loop-$(Get-StableHash $Root)"
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$hasMutex = $false

try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) {
        Write-LoopLog "profile update loop already active; exiting pid=$PID"
        exit 0
    }

    Set-Location $Root
    Write-LoopLog "profile update loop started pid=$PID root=$Root interval_minutes=$IntervalMinutes initial_delay_minutes=$InitialDelayMinutes"

    if (-not $RunImmediately -and $InitialDelayMinutes -gt 0) {
        Start-Sleep -Seconds ($InitialDelayMinutes * 60)
    }

    while ($true) {
        Invoke-ProfileUpdateOnce
        Start-Sleep -Seconds ([Math]::Max(1, $IntervalMinutes) * 60)
    }
}
finally {
    if ($hasMutex) {
        $mutex.ReleaseMutex() | Out-Null
    }
    $mutex.Dispose()
}

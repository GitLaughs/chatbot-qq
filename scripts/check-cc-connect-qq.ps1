$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $root "configs\cc-connect.qqbot.local.toml"
$log = Join-Path $root "cc-connect-qq-run.log"

Write-Host "== cc-connect version =="
cc-connect --version

Write-Host ""
Write-Host "== config =="
if (Test-Path -LiteralPath $config) {
    Write-Host $config
}
else {
    Write-Host "missing: $config"
}

Write-Host ""
Write-Host "== processes =="
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -like "cc-connect*" -or $_.CommandLine -like "*cc-connect*" } |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine |
    Format-Table -AutoSize

Write-Host ""
Write-Host "== sessions =="
cc-connect sessions list

Write-Host ""
Write-Host "== recent qq log =="
if (Test-Path -LiteralPath $log) {
    Get-Content -LiteralPath $log -Tail 120 | ForEach-Object { $_ -replace "`0", "" }
}
else {
    Write-Host "log not found: $log"
}

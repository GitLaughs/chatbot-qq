$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $root "configs\cc-connect.napcat.local.toml"
$log = Join-Path $root "cc-connect-napcat-run.log"

Write-Host "== cc-connect version =="
cc-connect --version

Write-Host ""
Write-Host "== NapCat ports =="
Get-NetTCPConnection -LocalPort 13001,6099 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess |
    Format-Table -AutoSize

Write-Host ""
Write-Host "== cc-connect processes =="
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*cc-connect.napcat.local.toml*" } |
    Select-Object ProcessId, Name, CommandLine |
    Format-Table -AutoSize

Write-Host ""
Write-Host "== sessions =="
cc-connect sessions list

Write-Host ""
Write-Host "== recent napcat cc-connect log =="
if (Test-Path -LiteralPath $log) {
    Get-Content -LiteralPath $log -Tail 120 | ForEach-Object { $_ -replace "`0", "" }
}
else {
    Write-Host "log not found: $log"
}

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $root "configs\cc-connect.qqbot.local.toml"
$example = Join-Path $root "configs\cc-connect.qqbot.example.toml"
$log = Join-Path $root "cc-connect-qq-run.log"

if (!(Test-Path -LiteralPath $config)) {
    Copy-Item -LiteralPath $example -Destination $config
    Write-Host "Created local config: $config"
    Write-Host "Fill QQBOT_APP_ID/QQBOT_APP_SECRET env vars or edit configs\cc-connect.qqbot.local.toml, then rerun."
    exit 1
}

Set-Location $root
cc-connect --config $config --force *>&1 | Tee-Object -FilePath $log -Append

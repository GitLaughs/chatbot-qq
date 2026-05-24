$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $root "configs\cc-connect.napcat.local.toml"
$example = Join-Path $root "configs\cc-connect.napcat.example.toml"
$log = Join-Path $root "cc-connect-napcat-run.log"

if (!(Test-Path -LiteralPath $config)) {
    Copy-Item -LiteralPath $example -Destination $config
    Write-Host "Created local config: $config"
    Write-Host "Start NapCat and enable OneBot v11 Forward WebSocket at ws://127.0.0.1:3001, then rerun."
    exit 1
}

Set-Location $root
cc-connect --config $config --force *>&1 | Tee-Object -FilePath $log -Append

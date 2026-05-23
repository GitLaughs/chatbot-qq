Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($Message) {
  Write-Host "==> $Message"
}

Step "Go tests"
if (Get-Command go -ErrorAction SilentlyContinue) {
  go test ./...
  if ($LASTEXITCODE -ne 0) {
    throw "go test failed"
  }
} else {
  Write-Host "SKIP: go not found on PATH"
}

Step "Node syntax checks"
node --check scripts/onebot-group-proxy.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: onebot-group-proxy.js" }
node --check scripts/generate-image.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: generate-image.js" }
node --check scripts/render-qq-card-imagemagick.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: render-qq-card-imagemagick.js" }
node --check scripts/test-onebot-proxy-units.js
if ($LASTEXITCODE -ne 0) { throw "node syntax check failed: test-onebot-proxy-units.js" }

Step "OneBot proxy unit checks"
node scripts/test-onebot-proxy-units.js
if ($LASTEXITCODE -ne 0) { throw "onebot proxy unit checks failed" }

Step "PowerShell parser checks"
$psFiles = Get-ChildItem -Path scripts,deploy -Recurse -Filter *.ps1 -File
foreach ($file in $psFiles) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error "$($file.FullName): $($_.Message)" }
    throw "PowerShell parse failed: $($file.FullName)"
  }
}

Step "Shell syntax checks"
$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
if ($bashCommand -and $bashCommand.Source -notmatch "\\Windows\\system32\\bash\.exe$") {
  $shellFiles = Get-ChildItem -Path deploy -Recurse -Include *.sh -File
  foreach ($file in $shellFiles) {
    bash -n $file.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Shell syntax check failed: $($file.FullName)"
    }
  }
} else {
  Write-Host "SKIP: usable bash not found on PATH"
}

Step "Sensitive local-data scan"
$forbidden = @(
  ("110" + "7099585"),
  ("171" + "290904"),
  ("213" + "8730775"),
  ("sk-" + "qq-low"),
  ("sk-" + "feishu-high")
)
$scanFiles = Get-ChildItem -Recurse -File |
  Where-Object {
    $_.FullName -notmatch "\\\.git\\" -and
    $_.FullName -notmatch "\\\.cc-connect\\" -and
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\tools\\" -and
    $_.FullName -notmatch "\\backup\\" -and
    $_.FullName -notmatch "\\groups\\sandbox-" -and
    $_.FullName -notmatch "\\scripts\\run-.*\.cmd$" -and
    $_.Name -notmatch "\.local\.toml$" -and
    $_.Name -notmatch "\.log$" -and
    $_.Name -ne "chatbot-qq-qrcode.png"
  }
foreach ($needle in $forbidden) {
  $matches = $scanFiles | Select-String -SimpleMatch $needle
  if ($matches) {
    $matches | ForEach-Object { Write-Error "$($_.Path):$($_.LineNumber): contains forbidden local value '$needle'" }
    throw "Sensitive local-data scan failed"
  }
}

Step "Done"

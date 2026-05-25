param(
    [string]$UserId = "ou_replace_me",
    [double]$Threshold = 0.05,
    [int]$UntilHour = 6
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { chcp.com 65001 | Out-Null } catch {}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDir = Join-Path $Root "runs\opentoken-subscription-monitor"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Now = Get-Date
$Until = Get-Date -Hour $UntilHour -Minute 0 -Second 0
if ($Now -ge $Until) {
    $Until = $Until.AddDays(1)
}

$env:LARK_USER_ID = $UserId
$env:LARK_CLI_AS = "bot"
$env:OPENTOKEN_SUBSCRIPTION_STATE_FILE = "runs/opentoken-subscription-monitor/minimum-state.json"

$RunLog = Join-Path $LogDir ("minimum-task-run-{0}.log" -f $Now.ToString("yyyyMMdd"))
$UntilText = $Until.ToString("yyyy-MM-ddTHH:mm:sszzz")
"==== start $(Get-Date -Format o) until=$UntilText threshold=$Threshold ====" | Add-Content -Path $RunLog -Encoding UTF8

& node scripts/monitor-opentoken-subscriptions.js --watch --alert-mode minimum --threshold $Threshold --until $UntilText 2>&1 |
    ForEach-Object {
        $line = $_.ToString()
        $line
        $line | Add-Content -Path $RunLog -Encoding UTF8
    }

$Code = $LASTEXITCODE
"==== exit $(Get-Date -Format o) code=$Code ====" | Add-Content -Path $RunLog -Encoding UTF8
exit $Code

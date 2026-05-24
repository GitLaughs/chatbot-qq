$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$promptPath = Join-Path $PSScriptRoot "dream_prompt.md"
$dreamDir = Join-Path $workspace "memory\dreams"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$lastMessagePath = Join-Path $dreamDir "$stamp-last-message.md"
$logPath = Join-Path $dreamDir "$stamp-events.jsonl"

if (!(Test-Path -LiteralPath $workspace -PathType Container)) {
    throw "workspace missing: $workspace"
}
if (!(Test-Path -LiteralPath $promptPath -PathType Leaf)) {
    throw "prompt missing: $promptPath"
}
if (!(Test-Path -LiteralPath $dreamDir -PathType Container)) {
    New-Item -ItemType Directory -Path $dreamDir | Out-Null
}

$prompt = Get-Content -Raw -LiteralPath $promptPath

$args = @(
    "exec",
    "--ephemeral",
    "--disable", "memories",
    "-C", $workspace,
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m", "gpt-5.5",
    "-c", 'model_reasoning_effort="xhigh"',
    "-o", $lastMessagePath,
    "-"
)

$oldErrorActionPreference = $ErrorActionPreference
$oldPSNativePreference = $null
$hasPSNativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue
if ($hasPSNativePreference) {
    $oldPSNativePreference = $Global:PSNativeCommandUseErrorActionPreference
    $Global:PSNativeCommandUseErrorActionPreference = $false
}

try {
    $ErrorActionPreference = "Continue"
    $eventOutput = $prompt | & codex @args 2>&1
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $oldErrorActionPreference
    if ($hasPSNativePreference) {
        $Global:PSNativeCommandUseErrorActionPreference = $oldPSNativePreference
    }
}
$eventOutput | Set-Content -LiteralPath $logPath -Encoding UTF8

if ($exitCode -ne 0) {
    Write-Output "dream failed: codex exit $exitCode. log: memory/dreams/$stamp-events.jsonl"
    exit $exitCode
}

if (Test-Path -LiteralPath $lastMessagePath) {
    $last = (Get-Content -Raw -LiteralPath $lastMessagePath).Trim()
    if ($last.Length -gt 1200) {
        $last = $last.Substring(0, 1200) + "`n...(truncated; see memory/dreams/$stamp-last-message.md)"
    }
    Write-Output $last
} else {
    Write-Output "dream complete. event log: memory/dreams/$stamp-events.jsonl"
}

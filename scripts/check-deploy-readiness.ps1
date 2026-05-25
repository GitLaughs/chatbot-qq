param(
    [double]$MinBalance = 20,
    [switch]$SkipNpmTest,
    [switch]$SkipPackageDryRun,
    [switch]$SkipCcSwitchCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$ForbiddenKeyPrefix = ("sk-" + "49c")

function Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Run-Checked([string]$Label, [scriptblock]$Block) {
    Step $Label
    & $Block
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Publish-ScanFiles {
    Get-ChildItem -Recurse -File | Where-Object {
        $path = $_.FullName
        $relative = Resolve-Path -LiteralPath $path -Relative
        $relative = $relative -replace '^\.\\', ''
        $path -notmatch '\\(?:node_modules|\.git|backup|memory|runs|tmp|users|tools)\\' -and
        $relative -notmatch '^(?:scripts\\test|scripts\\check-|scripts\\audit-private-data\.js|scripts\\sync-server-keys-from-ccswitch\.ps1|configs\\private-data-audit-rules\.json|docs\\)' -and
        $_.Name -notmatch '^(?:package-lock\.json)$' -and
        $_.Extension -match '^\.(?:js|ps1|sh|toml|env|example|json|md)$'
    }
}

function Is-PlaceholderSecret([string]$Value) {
    $text = ($Value -replace '["'']', '').Trim().TrimEnd(';', ',', ')')
    return -not $text -or
        $text -match '^\$\{[A-Z0-9_]+\}$' -or
        $text -match '^env\.' -or
        $text -match '^(replace-me|changeme|example|placeholder|your-|key\d+|xxx+|test|demo|fake|redacted|\*\*\*)' -or
        $text -match '^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\($' -or
        $text -match '^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$' -or
        $text -match '^\$\w+'
}

function Find-HighSignalSecretFindings {
    $findings = New-Object System.Collections.Generic.List[string]
    $assignment = [regex]'(?i)\b(?:OPENAI_API_KEY|API_KEY|TOKEN|COOKIE|SECRET|AUTHORIZATION|BEARER_TOKEN|NAPCAT_TOKEN)\b\s*[:=]\s*["'']?([^"''\s,#]{16,})'
    $bearer = [regex]'(?i)\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+\-\/=]{16,})'
    foreach ($file in Publish-ScanFiles) {
        $lineNumber = 0
        foreach ($line in [IO.File]::ReadLines($file.FullName)) {
            $lineNumber += 1
            foreach ($match in $assignment.Matches($line)) {
                if (-not (Is-PlaceholderSecret $match.Groups[1].Value)) {
                    $findings.Add("$($file.FullName):$lineNumber assignment")
                }
            }
            foreach ($match in $bearer.Matches($line)) {
                if (-not (Is-PlaceholderSecret $match.Groups[1].Value)) {
                    $findings.Add("$($file.FullName):$lineNumber bearer")
                }
            }
        }
    }
    return @($findings)
}

function Assert-ContainsText([string]$File, [string[]]$Needles, [string]$Label) {
    if (-not (Test-Path -LiteralPath $File)) {
        throw "$Label missing file: $File"
    }
    $text = Get-Content -LiteralPath $File -Raw
    $missing = @($Needles | Where-Object { $text -notmatch [regex]::Escape($_) })
    if ($missing.Count -gt 0) {
        $missing | ForEach-Object { Write-Host "missing: $_" }
        throw "$Label missing required entries"
    }
}

if (-not $SkipNpmTest) {
    Run-Checked "npm test" { npm test }
}

Run-Checked "secret prefix scan" {
    if (Get-Command rg -ErrorAction SilentlyContinue) {
        rg $ForbiddenKeyPrefix -n .
        if ($LASTEXITCODE -eq 0) {
            throw "secret prefix scan found a forbidden key prefix"
        }
        if ($LASTEXITCODE -eq 1) {
            $global:LASTEXITCODE = 0
        }
    } else {
        $files = Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\.git\\|\\backup\\|\\memory\\|\\runs\\' }
        $matches = @($files | Select-String -Pattern $ForbiddenKeyPrefix -SimpleMatch)
        if ($matches.Count -gt 0) {
            $matches | ForEach-Object { Write-Host $_.Path":"$($_.LineNumber) }
            throw "secret prefix scan found a forbidden key prefix"
        }
        $global:LASTEXITCODE = 0
    }
}

Run-Checked "high-signal local secret scan" {
    $findings = @(Find-HighSignalSecretFindings)
    if ($findings.Count -gt 0) {
        $findings | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
        throw "high-signal local secret scan found possible publish secrets"
    }
    $global:LASTEXITCODE = 0
}

Run-Checked "natural task agent deployment surface" {
    if (-not (Test-Path -LiteralPath ".\scripts\task-model-parser-bridge.js")) {
        throw "missing task model parser bridge script"
    }
    if (-not (Test-Path -LiteralPath ".\scripts\artifact-model-bridge.js")) {
        throw "missing artifact model bridge script"
    }
    if (-not (Test-Path -LiteralPath ".\scripts\confirmed-qq-task-deploy.sh")) {
        throw "missing confirmed QQ deploy script"
    }
    if (-not (Test-Path -LiteralPath ".\scripts\confirmed-qq-task-health.sh")) {
        throw "missing confirmed QQ health script"
    }
    Assert-ContainsText -File ".\deploy\linux\chatbot-qq.env.example" -Needles @(
        "QQ_TASK_TIMEZONE",
        "QQ_TASK_MODEL_PARSER_COMMAND",
        "QQ_TASK_MODEL_PARSER_MODEL",
        "QQ_TASK_MODEL_PARSER_MODE",
        "QQ_TASK_MODEL_PARSER_TIMEOUT_MS",
        "QQ_TASK_MODEL_PARSER_HTTP_TIMEOUT_MS",
        "QQ_TASK_FILE_MODIFIER_COMMAND",
        "QQ_TASK_SCRIPT_GENERATOR_COMMAND",
        "QQ_TASK_ARTIFACT_MODEL",
        "QQ_TASK_ARTIFACT_MODEL_MODE",
        "QQ_TASK_ARTIFACT_MODEL_HTTP_TIMEOUT_MS",
        "QQ_TASK_DEPLOY_COMMAND",
        "QQ_TASK_DEPLOY_TIMEOUT_MS",
        "QQ_TASK_DEPLOY_HEALTH_COMMAND",
        "QQ_TASK_DEPLOY_HEALTH_TIMEOUT_MS"
    ) -Label "task agent env example"
    Assert-ContainsText -File ".\scripts\install-linux.sh" -Needles @(
        "QQ_TASK_TIMEZONE=Asia/Shanghai",
        "# QQ_TASK_MODEL_PARSER_COMMAND=",
        "QQ_TASK_MODEL_PARSER_MODEL=gpt-5.4",
        "QQ_TASK_MODEL_PARSER_MODE=responses",
        "QQ_TASK_MODEL_PARSER_TIMEOUT_MS=8000",
        "QQ_TASK_MODEL_PARSER_HTTP_TIMEOUT_MS=30000",
        "# QQ_TASK_FILE_MODIFIER_COMMAND=",
        "# QQ_TASK_SCRIPT_GENERATOR_COMMAND=",
        "QQ_TASK_ARTIFACT_MODEL=gpt-5.4",
        "QQ_TASK_ARTIFACT_MODEL_MODE=responses",
        "QQ_TASK_ARTIFACT_MODEL_HTTP_TIMEOUT_MS=60000",
        "# QQ_TASK_DEPLOY_COMMAND=",
        "QQ_TASK_DEPLOY_TIMEOUT_MS=300000",
        "# QQ_TASK_DEPLOY_HEALTH_COMMAND=",
        "CHATBOT_QQ_EVIDENCE_MAX_CHARS=12000",
        "CHATBOT_QQ_JSONL_SHARD_MAX_BYTES=2097152"
    ) -Label "beginner install task and memory env"
    Assert-ContainsText -File ".\deploy\linux\onebot-group-proxy.service" -Needles @(
        "EnvironmentFile=-/etc/chatbot-qq.env",
        "ExecStart=/usr/bin/env npm run onebot-proxy"
    ) -Label "onebot proxy service"
    $global:LASTEXITCODE = 0
}

if (-not $SkipPackageDryRun) {
    Run-Checked "deployment package dry-run" {
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-napcat-server.ps1 -DryRun
    }
}

if (-not $SkipCcSwitchCheck) {
    $ccSwitchDb = Join-Path $env:USERPROFILE ".cc-switch\cc-switch.db"
    if (Test-Path -LiteralPath $ccSwitchDb) {
        Run-Checked "cc-switch balance dry-run" {
            powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-server-keys-from-ccswitch.ps1 -Force -DryRun -MinBalance $MinBalance
        }
    } else {
        Step "cc-switch balance dry-run"
        Write-Warning "Skipped: cc-switch database not found at $ccSwitchDb"
    }
}

Step "readiness summary"
Write-Host "OK: local deploy readiness checks passed."
Write-Host "No server files were changed and no QQ services were restarted."
Write-Host "When intentionally publishing a batch, run scripts\deploy-napcat-server.ps1, then restart only QQ services and run scripts\check-napcat-server.ps1."

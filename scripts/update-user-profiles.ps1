param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$Workspace = "",
    [switch]$All,
    [switch]$Groups,
    [switch]$Users,
    [int]$LookbackHours = $(if ($env:CHATBOT_QQ_PROFILE_UPDATE_LOOKBACK_HOURS) { [int]$env:CHATBOT_QQ_PROFILE_UPDATE_LOOKBACK_HOURS } else { 72 }),
    [string]$Model = $(if ($env:CHATBOT_QQ_PROFILE_UPDATE_MODEL) { $env:CHATBOT_QQ_PROFILE_UPDATE_MODEL } else { "gpt-5.5" }),
    [string]$ReasoningEffort = $(if ($env:CHATBOT_QQ_PROFILE_UPDATE_REASONING_EFFORT) { $env:CHATBOT_QQ_PROFILE_UPDATE_REASONING_EFFORT } else { "medium" }),
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $env:OPENAI_API_KEY -and $env:QQ_OPENTOKEN_API_KEY) {
    $env:OPENAI_API_KEY = $env:QQ_OPENTOKEN_API_KEY
}
if (-not $env:OPENAI_BASE_URL -and $env:QQ_OPENTOKEN_BASE_URL) {
    $env:OPENAI_BASE_URL = $env:QQ_OPENTOKEN_BASE_URL
}

function Resolve-WorkspaceList {
    param([string]$RootPath, [string]$OneWorkspace, [bool]$UseAll, [bool]$UseGroups, [bool]$UseUsers)

    if ($OneWorkspace) {
        return @((Resolve-Path -LiteralPath $OneWorkspace).Path)
    }

    if (-not ($UseAll -or $UseGroups -or $UseUsers)) {
        throw "Use -Workspace <path>, -Groups, -Users, or -All."
    }

    $items = @()
    $bases = @()
    if ($UseAll -or $UseGroups) {
        $bases += "groups"
    }
    if ($UseAll -or $UseUsers) {
        $bases += "users"
    }
    foreach ($base in $bases) {
        $dir = Join-Path $RootPath $base
        if (Test-Path -LiteralPath $dir -PathType Container) {
            $items += Get-ChildItem -LiteralPath $dir -Directory | ForEach-Object { $_.FullName }
        }
    }
    return $items
}

function Get-RecentChatFiles {
    param([string]$WorkspacePath, [int]$Hours)

    $memoryDir = Join-Path $WorkspacePath "memory"
    if (!(Test-Path -LiteralPath $memoryDir -PathType Container)) {
        return @()
    }
    $cutoff = (Get-Date).AddHours(-1 * [Math]::Max(1, $Hours))
    return @(Get-ChildItem -LiteralPath $memoryDir -Filter "chat-*.jsonl" -File |
        Where-Object { $_.LastWriteTime -ge $cutoff } |
        Sort-Object LastWriteTime)
}

function Get-LatestProfileUpdate {
    param([string]$WorkspacePath)

    $profileDir = Join-Path $WorkspacePath "memory\profile-updates"
    if (!(Test-Path -LiteralPath $profileDir -PathType Container)) {
        return $null
    }
    return Get-ChildItem -LiteralPath $profileDir -Filter "*.md" -File |
        Where-Object { $_.Name -notmatch "-last-message\.md$" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Has-NewChatSinceProfileUpdate {
    param([array]$ChatFiles, [object]$LatestProfileUpdate)

    if ($null -eq $LatestProfileUpdate) {
        return $true
    }
    foreach ($file in $ChatFiles) {
        if ($file.LastWriteTime -gt $LatestProfileUpdate.LastWriteTime) {
            return $true
        }
    }
    return $false
}

function Invoke-ProfileUpdater {
    param([string]$WorkspacePath, [array]$ChatFiles)

    $promptPath = Join-Path $PSScriptRoot "profile-updater-prompt.md"
    if (!(Test-Path -LiteralPath $promptPath -PathType Leaf)) {
        throw "prompt missing: $promptPath"
    }

    $profileDir = Join-Path $WorkspacePath "memory\profile-updates"
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $evidenceRel = "memory/profile-updates/$stamp-evidence.md"
    $evidencePath = Join-Path $WorkspacePath $evidenceRel
    $sourceMapRel = "memory/profile-updates/$stamp-source-map.jsonl"
    $sourceMapPath = Join-Path $WorkspacePath $sourceMapRel
    $lastMessagePath = Join-Path $profileDir "$stamp-last-message.md"
    $eventLogPath = Join-Path $profileDir "$stamp-events.log"

    if (-not $DryRun) {
        & node (Join-Path $PSScriptRoot "build-profile-update-packet.js") `
            --workspace $WorkspacePath `
            --lookback-hours $LookbackHours `
            --output $evidencePath `
            --source-map-output $sourceMapPath | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "profile evidence packet generation failed for $WorkspacePath"
        }
    }

    $prompt = (Get-Content -Raw -LiteralPath $promptPath) + @"

Run context:

- Workspace: $WorkspacePath
- Lookback hours: $LookbackHours
- Evidence packet: $evidenceRel
- Source map for manual debugging only: $sourceMapRel
- Run note target: memory/profile-updates/$stamp.md

Use the evidence packet as the only chat evidence for this run. Do not read raw memory/chat-*.jsonl files unless the user explicitly asks for forensic debugging.
"@

    if ($DryRun) {
        Write-Output "dry-run: would update $WorkspacePath from $($ChatFiles.Count) chat file(s)"
        return
    }

    $args = @(
        "exec",
        "--ephemeral",
        "--disable", "memories",
        "-C", $WorkspacePath,
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m", $Model,
        "-c", "model_reasoning_effort=`"$ReasoningEffort`"",
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

    $eventOutput | Set-Content -LiteralPath $eventLogPath -Encoding UTF8
    if ($exitCode -ne 0) {
        throw "profile update failed for ${WorkspacePath}: codex exit $exitCode; log: $eventLogPath"
    }

    if (Test-Path -LiteralPath $lastMessagePath -PathType Leaf) {
        $last = (Get-Content -Raw -LiteralPath $lastMessagePath).Trim()
        Write-Output $last
    } else {
        Write-Output "profile update complete: $WorkspacePath"
    }
}

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$workspaces = Resolve-WorkspaceList -RootPath $rootPath -OneWorkspace $Workspace -UseAll ([bool]$All) -UseGroups ([bool]$Groups) -UseUsers ([bool]$Users)
$updated = 0
$skipped = 0

foreach ($item in $workspaces) {
    $chatFiles = Get-RecentChatFiles -WorkspacePath $item -Hours $LookbackHours
    if ($chatFiles.Count -eq 0) {
        Write-Output "skip: no recent chat files in $item"
        $skipped += 1
        continue
    }
    $latestUpdate = Get-LatestProfileUpdate -WorkspacePath $item
    if (-not $Force -and -not (Has-NewChatSinceProfileUpdate -ChatFiles $chatFiles -LatestProfileUpdate $latestUpdate)) {
        Write-Output "skip: no new chat since last profile update in $item"
        $skipped += 1
        continue
    }
    Invoke-ProfileUpdater -WorkspacePath $item -ChatFiles $chatFiles
    $updated += 1
}

Write-Output "profile updater done: updated=$updated skipped=$skipped model=$Model reasoning=$ReasoningEffort lookback_hours=$LookbackHours"

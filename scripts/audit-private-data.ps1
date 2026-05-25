param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$RulesPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "configs\private-data-audit-rules.json"),
    [ValidateSet("Publish", "Live")]
    [string]$Scope = "Publish",
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$rules = Get-Content -LiteralPath $RulesPath -Raw | ConvertFrom-Json

function Assert-RuleConfig($Config) {
    $ids = New-Object System.Collections.Generic.HashSet[string]
    foreach ($item in @($Config.allowed_findings)) {
        if ($null -eq $item.id -or -not ($item.id -is [string]) -or [string]::IsNullOrWhiteSpace($item.id)) {
            throw "allowed finding rules must define an id"
        }
        if (-not $ids.Add([string]$item.id)) {
            throw "allowed finding rule id must be unique: $($item.id)"
        }
        if (-not $item.PSObject.Properties.Match("max_matches").Count -or $null -eq $item.max_matches) {
            throw "allowed finding rule $($item.id) must define max_matches between 0 and 100"
        }
        if (-not (Test-JsonInteger $item.max_matches)) {
            throw "allowed finding rule $($item.id) must define max_matches between 0 and 100"
        }
        $maxMatches = [int]$item.max_matches
        if ($maxMatches -lt 0 -or $maxMatches -gt 100) {
            throw "allowed finding rule $($item.id) must define max_matches between 0 and 100"
        }
        if ([string]$item.type -ieq "secret token") {
            throw "private-data audit rules must not allow secret token findings"
        }
        foreach ($pattern in @($item.path_patterns)) {
            Assert-AllowedPathPattern $pattern
        }
    }
}

function Test-JsonInteger($Value) {
    if ($Value -is [bool] -or $Value -is [string]) {
        return $false
    }
    if ($Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or $Value -is [int] -or $Value -is [uint32] -or $Value -is [long] -or $Value -is [uint64]) {
        return $true
    }
    if ($Value -is [decimal] -or $Value -is [double] -or $Value -is [single]) {
        return ([double]$Value % 1) -eq 0
    }
    return $false
}

function Assert-AllowedPathPattern($Pattern) {
    $text = [string]$Pattern
    if ([string]::IsNullOrWhiteSpace($text) -or -not $text.StartsWith("^")) {
        throw "allowed finding path pattern must be anchored: $text"
    }
    if ($text -match '^\^?\.?\*\.?\*?\$?$' -or $text -in @("^", "^.*", "^.*$")) {
        throw "allowed finding path pattern is too broad: $text"
    }
    $broadSentinels = @(
        "source.js",
        "configs/cc-connect.napcat.local.toml",
        "groups/sandbox/AGENTS.md",
        "scripts/run-local.cmd"
    )
    foreach ($sample in $broadSentinels) {
        if ($sample -match $text) {
            throw "allowed finding path pattern matches broad sentinel paths: $text"
        }
    }
}

Assert-RuleConfig $rules

function Get-RelativePath($Base, $Path) {
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    if ($pathFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $pathFull.Substring($baseFull.Length).TrimStart('\')
    }
    return $pathFull
}

function Normalize-RelativePath($Path) {
    return $Path -replace '\\', '/'
}

function Is-Excluded($Path) {
    $relative = Normalize-RelativePath (Get-RelativePath $Root $Path)
    $name = [System.IO.Path]::GetFileName($Path)
    $extension = [System.IO.Path]::GetExtension($Path)
    foreach ($dir in @($rules.common_exclude_dirs)) {
        if ($relative -eq $dir -or $relative.StartsWith("$dir/")) {
            return $true
        }
    }
    if ($Scope -eq "Publish") {
        foreach ($dir in @($rules.publish_exclude_dirs)) {
            if ($relative -eq $dir -or $relative.StartsWith("$dir/")) {
                return $true
            }
        }
        foreach ($pattern in @($rules.publish_exclude_path_patterns)) {
            if ($relative -match $pattern) {
                return $true
            }
        }
        if (@($rules.publish_exclude_file_names) -contains $name) {
            return $true
        }
        if (@($rules.publish_exclude_extensions) -contains $extension.ToLowerInvariant()) {
            return $true
        }
        foreach ($pattern in @($rules.publish_exclude_file_name_patterns)) {
            if ($name -match $pattern) {
                return $true
            }
        }
    }
    return $false
}

function Is-AllowedFinding($Relative, $Value, $Name) {
    return Get-AllowedFindingRule $Relative $Name
}

function Get-AllowedFindingRule($Relative, $Name) {
    $relativeNormalized = Normalize-RelativePath $Relative
    foreach ($item in @($rules.allowed_findings)) {
        if ($item.type -ne $Name) {
            continue
        }
        foreach ($pattern in @($item.path_patterns)) {
            if ($relativeNormalized -match $pattern) {
                return $item
            }
        }
    }
    return $null
}

function New-AllowedSummary($Rules) {
    $summary = @{}
    foreach ($item in @($Rules.allowed_findings)) {
        $summary[[string]$item.id] = [ordered]@{
            id = [string]$item.id
            type = [string]$item.type
            max_matches = [int]$item.max_matches
            matches = 0
            files = New-Object System.Collections.Generic.HashSet[string]
        }
    }
    return $summary
}

function Add-AllowedHit($Summary, $Rule, $Relative) {
    $id = [string]$Rule.id
    if (-not $Summary.ContainsKey($id)) {
        $Summary[$id] = [ordered]@{
            id = $id
            type = [string]$Rule.type
            max_matches = [int]$Rule.max_matches
            matches = 0
            files = New-Object System.Collections.Generic.HashSet[string]
        }
    }
    $Summary[$id].matches += 1
    [void]$Summary[$id].files.Add((Normalize-RelativePath $Relative))
}

function Add-AllowedBudgetFindings($Summary, $Findings) {
    foreach ($item in $Summary.Values) {
        if ($item.matches -gt $item.max_matches) {
            $Findings.Add([ordered]@{
                file = "configs/private-data-audit-rules.json"
                line = 1
                type = "allowed finding budget"
                allowed_example = $false
                severity = "blocking"
                allowed_rule = $item.id
                sample = "$($item.id): $($item.matches)/$($item.max_matches)"
            }) | Out-Null
        }
    }
}

function Format-AllowedSummary($Summary) {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($item in $Summary.Values) {
        $items.Add([ordered]@{
            id = $item.id
            type = $item.type
            max_matches = $item.max_matches
            matches = $item.matches
            files = @($item.files | Sort-Object)
        }) | Out-Null
    }
    return @($items.ToArray())
}

$findings = New-Object System.Collections.Generic.List[object]
$allowedSummary = New-AllowedSummary $rules
$files = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { -not (Is-Excluded $_.FullName) } |
    Where-Object { $_.Length -lt $rules.max_file_bytes }

foreach ($file in $files) {
    if (@($rules.forbidden_file_names) -contains $file.Name) {
        $relative = Get-RelativePath $Root $file.FullName
        $allowed = ($Scope -eq "Live")
        $findings.Add([ordered]@{
            file = $relative
            line = 1
            type = "forbidden local file"
            allowed_example = $allowed
            severity = if ($allowed) { "warning" } else { "blocking" }
            sample = $file.Name
        }) | Out-Null
    }
}

foreach ($file in $files) {
    $relative = Get-RelativePath $Root $file.FullName
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { continue }
    foreach ($pattern in @($rules.patterns)) {
        foreach ($match in [regex]::Matches($text, $pattern.regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
            $value = $match.Value
            $allowedRule = Is-AllowedFinding $relative $value $pattern.name
            $allowed = ($null -ne $allowedRule)
            $liveWarning = (-not $allowed -and $Scope -eq "Live" -and @($rules.live_warning_types) -contains $pattern.name)
            if ($allowed) {
                Add-AllowedHit $allowedSummary $allowedRule $relative
            }
            $line = ($text.Substring(0, $match.Index) -split "`n").Count
            $findings.Add([ordered]@{
                file = $relative
                line = $line
                type = $pattern.name
                allowed_example = ($allowed -or $liveWarning)
                severity = if ($allowed -or $liveWarning) { "warning" } else { "blocking" }
                allowed_rule = if ($allowed) { [string]$allowedRule.id } else { $null }
                sample = ($value.Substring(0, [Math]::Min(10, $value.Length)) + "***")
            }) | Out-Null
        }
    }
}

Add-AllowedBudgetFindings $allowedSummary $findings
$blocking = @($findings | Where-Object { -not $_.allowed_example })
$result = [ordered]@{
    ok = ($blocking.Count -eq 0)
    root = $Root
    scope = $Scope
    checked_files = @($files).Count
    findings = @($findings.ToArray())
    warnings = @($findings | Where-Object { $_.allowed_example })
    blocking = @($blocking)
    allowed_summary = @(Format-AllowedSummary $allowedSummary)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
} else {
    if ($blocking.Count -eq 0) {
        Write-Host "OK private-data audit passed. checked_files=$($result.checked_files)"
    } else {
        Write-Host "FAIL private-data audit found blocking findings:"
        foreach ($item in $blocking) {
            Write-Host "- $($item.file):$($item.line) $($item.type)"
        }
    }
    if ($result.warnings.Count -gt 0) {
        Write-Host "WARN private-data audit non-blocking findings:"
        foreach ($item in $result.warnings) {
            Write-Host "- $($item.file):$($item.line) $($item.type)"
        }
    }
    if ($result.allowed_summary.Count -gt 0) {
        Write-Host "ALLOW private-data audit allowed findings:"
        foreach ($item in $result.allowed_summary) {
            Write-Host "- $($item.id) $($item.type): $($item.matches)/$($item.max_matches) matches in $(@($item.files).Count) files"
        }
    }
}

if ($blocking.Count -gt 0) {
    exit 1
}

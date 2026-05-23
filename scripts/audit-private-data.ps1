param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$excludeDirs = @(".git", "node_modules", "tmp", "backup", "tools", ".cc-connect")
$allowedNumericExamples = @("100000001", "100000002", "200000001", "200000002", "200000003", "200000004")
$patterns = @(
    @{ name = "secret token"; regex = '(sk-[A-Za-z0-9_\-]{20,}|access[_-]?token\s*[:=]\s*["'']?[A-Za-z0-9_\-\.]{16,}|app(secret)?\s*[:=]\s*["'']?[A-Za-z0-9_\-]{12,})' },
    @{ name = "local config"; regex = '(NapCat\.json|onebot11_[A-Za-z0-9_\-]+\.json)' },
    @{ name = "runtime memory"; regex = '(memory[\\/].*chat-\d{4}-\d{2}-\d{2}\.jsonl|members[\\/]\d+\.md|users[\\/]\d+)' },
    @{ name = "numeric qq id"; regex = '\b\d{6,12}\b' }
)

function Get-RelativePath($Base, $Path) {
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    if ($pathFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $pathFull.Substring($baseFull.Length).TrimStart('\')
    }
    return $pathFull
}

function Is-Excluded($Path) {
    $relative = Get-RelativePath $Root $Path
    foreach ($dir in $excludeDirs) {
        if ($relative -eq $dir -or $relative.StartsWith("$dir\")) {
            return $true
        }
    }
    return $false
}

function Is-AllowedFinding($Relative, $Value, $Name) {
    if ($Name -eq "numeric qq id" -and $allowedNumericExamples -contains $Value) {
        return $true
    }
    if ($Name -eq "numeric qq id" -and $Value -in @("100000", "120000", "180000", "600000", "900000")) {
        return $true
    }
    if ($Name -eq "numeric qq id" -and $Relative -match '^(scripts\\test\.ps1|scripts\\test-onebot-proxy-units\.js)$') {
        return $true
    }
    if ($Name -eq "runtime memory" -and $Relative -match '^(configs\\.*\.example\.toml|docs\\|deploy\\linux\\chatbot-qq\.env\.example)') {
        return $true
    }
    if ($Relative -match '^docs\\' -and $Value -match '^\d+$' -and $allowedNumericExamples -contains $Value) {
        return $true
    }
    if ($Value -in @("600000", "900000")) {
        return $true
    }
    if ($Relative -eq "scripts\audit-private-data.ps1") {
        return $true
    }
    return $false
}

$findings = New-Object System.Collections.Generic.List[object]
$files = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { -not (Is-Excluded $_.FullName) } |
    Where-Object { $_.Length -lt 2MB }

$forbiddenNames = @("cc-connect.napcat.local.toml", ".env", "NapCat.json")
foreach ($file in $files) {
    if ($forbiddenNames -contains $file.Name) {
        $relative = Get-RelativePath $Root $file.FullName
        $findings.Add([ordered]@{
            file = $relative
            line = 1
            type = "forbidden local file"
            allowed_example = $false
            sample = $file.Name
        }) | Out-Null
    }
}

foreach ($file in $files) {
    $relative = Get-RelativePath $Root $file.FullName
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { continue }
    foreach ($pattern in $patterns) {
        foreach ($match in [regex]::Matches($text, $pattern.regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
            $value = $match.Value
            $allowed = Is-AllowedFinding $relative $value $pattern.name
            $line = ($text.Substring(0, $match.Index) -split "`n").Count
            $findings.Add([ordered]@{
                file = $relative
                line = $line
                type = $pattern.name
                allowed_example = $allowed
                sample = ($value.Substring(0, [Math]::Min(10, $value.Length)) + "***")
            }) | Out-Null
        }
    }
}

$blocking = @($findings | Where-Object { -not $_.allowed_example })
$result = [ordered]@{
    ok = ($blocking.Count -eq 0)
    root = $Root
    checked_files = @($files).Count
    findings = @($findings.ToArray())
    blocking = @($blocking)
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
}

if ($blocking.Count -gt 0) {
    exit 1
}

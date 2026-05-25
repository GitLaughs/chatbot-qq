param(
    [Parameter(Mandatory = $true)][string]$TextPath,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Title = "QQ Bot",
    [int]$Width = 1200
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$text = Get-Content -LiteralPath $TextPath -Raw -Encoding UTF8
$fontFamily = New-Object System.Drawing.FontFamily("Microsoft YaHei")
$titleFont = New-Object System.Drawing.Font($fontFamily, 26, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = New-Object System.Drawing.Font($fontFamily, 23, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$monoFont = New-Object System.Drawing.Font("Consolas", 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$outer = 22
$pad = 48
$headerHeight = 0
$lineGap = 10
$minHeight = 420
$maxHeight = [Math]::Max(480, [int]($env:ONEBOT_RENDER_MAX_HEIGHT -as [int]))
if ($maxHeight -le 480) {
    $maxHeight = 680
}
$maxTextWidth = $Width - ($outer + $pad) * 2
$lines = New-Object System.Collections.Generic.List[string]

foreach ($rawLine in ($text -split "`r?`n")) {
    $line = $rawLine.TrimEnd()
    if ($line.Length -eq 0) {
        $lines.Add("")
        continue
    }
    $current = ""
    foreach ($ch in $line.ToCharArray()) {
        $candidate = $current + $ch
        $bmp = New-Object System.Drawing.Bitmap(1, 1)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $size = $g.MeasureString($candidate, $bodyFont)
        $g.Dispose()
        $bmp.Dispose()
        if ($size.Width -gt $maxTextWidth -and $current.Length -gt 0) {
            $lines.Add($current)
            $current = [string]$ch
        }
        else {
            $current = $candidate
        }
    }
    if ($current.Length -gt 0) {
        $lines.Add($current)
    }
}

function Get-LineHeight([string]$Line) {
    if ($Line.Length -eq 0) {
        return 20
    }
    return 32 + $lineGap
}

$contentHeightLimit = $maxHeight - (($outer + $pad) * 2)
$pages = New-Object System.Collections.Generic.List[object]
$page = New-Object System.Collections.Generic.List[string]
$pageHeight = 0
foreach ($line in $lines) {
    $lineHeight = Get-LineHeight $line
    if (($page.Count -gt 0) -and (($pageHeight + $lineHeight) -gt $contentHeightLimit)) {
        $pages.Add($page.ToArray())
        $page = New-Object System.Collections.Generic.List[string]
        $pageHeight = 0
    }
    $page.Add($line)
    $pageHeight += $lineHeight
}
if ($page.Count -gt 0) {
    $pages.Add($page.ToArray())
}
if ($pages.Count -eq 0) {
    $pages.Add(@(""))
}

$outDir = Split-Path -Parent $OutPath
$outBase = [System.IO.Path]::GetFileNameWithoutExtension($OutPath)
$outExt = [System.IO.Path]::GetExtension($OutPath)
if ([string]::IsNullOrWhiteSpace($outExt)) {
    $outExt = ".png"
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$inkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(23, 32, 51))
$mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(91, 107, 130))
$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(41, 128, 228))
$codeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(237, 242, 247))
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(207, 217, 232), 2)

for ($pageIndex = 0; $pageIndex -lt $pages.Count; $pageIndex++) {
    $pageLines = $pages[$pageIndex]
    $height = $outer + $pad
    foreach ($line in $pageLines) {
        $height += Get-LineHeight $line
    }
    $height += $outer + $pad
    $height = [Math]::Min([Math]::Max($height, $minHeight), $maxHeight)

    $pagePath = $OutPath
    if ($pageIndex -gt 0) {
        $pagePath = Join-Path $outDir "$outBase-$($pageIndex + 1)$outExt"
    }

    $bmpOut = New-Object System.Drawing.Bitmap($Width, $height)
    $gOut = [System.Drawing.Graphics]::FromImage($bmpOut)
    $gOut.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gOut.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $gOut.Clear([System.Drawing.Color]::FromArgb(244, 247, 251))

    $cardRect = New-Object System.Drawing.Rectangle($outer, $outer, ($Width - $outer * 2), ($height - $outer * 2))
    $gOut.FillRectangle([System.Drawing.Brushes]::White, $cardRect)
    $gOut.DrawRectangle($borderPen, $cardRect)
    $contentX = $outer + $pad

    $y = $outer + $pad
    foreach ($line in $pageLines) {
        if ($line.Length -eq 0) {
            $y += 20
            continue
        }
        if (($line.StartsWith("    ")) -or ($line.StartsWith("Code:"))) {
            $rect = New-Object System.Drawing.RectangleF(($contentX - 10), ($y - 4), ($maxTextWidth + 20), 34)
            $gOut.FillRectangle($codeBrush, $rect)
            $gOut.DrawString($line, $monoFont, $inkBrush, $contentX, $y)
        }
        elseif ($line.StartsWith("[Title]")) {
            $gOut.DrawString($line, $titleFont, $inkBrush, $contentX, $y)
            $y += 6
        }
        else {
            $gOut.DrawString($line, $bodyFont, $inkBrush, $contentX, $y)
        }
        $y += Get-LineHeight $line
    }

    $bmpOut.Save($pagePath, [System.Drawing.Imaging.ImageFormat]::Png)

    $gOut.Dispose()
    $bmpOut.Dispose()
}
$fontFamily.Dispose()
$titleFont.Dispose()
$bodyFont.Dispose()
$monoFont.Dispose()
$inkBrush.Dispose()
$mutedBrush.Dispose()
$accentBrush.Dispose()
$codeBrush.Dispose()
$borderPen.Dispose()

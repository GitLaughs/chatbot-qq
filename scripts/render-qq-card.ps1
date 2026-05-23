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
$titleFont = New-Object System.Drawing.Font($fontFamily, 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = New-Object System.Drawing.Font($fontFamily, 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$monoFont = New-Object System.Drawing.Font("Consolas", 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$pad = 44
$lineGap = 10
$maxTextWidth = $Width - $pad * 2
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

$height = $pad + 54 + 24
foreach ($line in $lines) {
    $height += $(if ($line.Length -eq 0) { 20 } else { 32 }) + $lineGap
}
$height += $pad
$height = [Math]::Min([Math]::Max($height, 420), 6000)

$bmpOut = New-Object System.Drawing.Bitmap($Width, $height)
$gOut = [System.Drawing.Graphics]::FromImage($bmpOut)
$gOut.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gOut.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$gOut.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))

$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(248, 250, 252))
$inkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 32, 44))
$mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(99, 115, 129))
$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 119, 255))
$codeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(237, 242, 247))
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 219, 230), 2)

$cardRect = New-Object System.Drawing.Rectangle(20, 20, ($Width - 40), ($height - 40))
$gOut.FillRectangle([System.Drawing.Brushes]::White, $cardRect)
$gOut.DrawRectangle($borderPen, $cardRect)
$gOut.FillRectangle($accentBrush, 20, 20, 8, $height - 40)
$gOut.DrawString($Title, $titleFont, $inkBrush, $pad, $pad)
$gOut.DrawString((Get-Date -Format "yyyy-MM-dd HH:mm"), $bodyFont, $mutedBrush, $pad, $pad + 34)

$y = $pad + 90
foreach ($line in $lines) {
    if ($y -gt $height - $pad - 40) {
        $gOut.DrawString("Content is too long and has been truncated. See local_files for the full copy.", $bodyFont, $mutedBrush, $pad, $y)
        break
    }
    if ($line.Length -eq 0) {
        $y += 20
        continue
    }
    if ($line.StartsWith("    ") -or $line.StartsWith("Code:")) {
        $rect = New-Object System.Drawing.RectangleF(($pad - 10), ($y - 4), ($maxTextWidth + 20), 34)
        $gOut.FillRectangle($codeBrush, $rect)
        $gOut.DrawString($line, $monoFont, $inkBrush, $pad, $y)
    }
    elseif ($line.StartsWith("[Title]")) {
        $gOut.DrawString($line, $titleFont, $inkBrush, $pad, $y)
        $y += 6
    }
    else {
        $gOut.DrawString($line, $bodyFont, $inkBrush, $pad, $y)
    }
    $y += 32 + $lineGap
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutPath) | Out-Null
$bmpOut.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

$gOut.Dispose()
$bmpOut.Dispose()
$fontFamily.Dispose()
$titleFont.Dispose()
$bodyFont.Dispose()
$monoFont.Dispose()
$bgBrush.Dispose()
$inkBrush.Dispose()
$mutedBrush.Dispose()
$accentBrush.Dispose()
$codeBrush.Dispose()
$borderPen.Dispose()

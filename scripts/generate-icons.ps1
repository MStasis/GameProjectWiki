$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeIconMethods {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
}
"@

$root = Split-Path -Parent $PSScriptRoot

function New-RoundedPath([System.Drawing.RectangleF]$rectangle, [float]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc($rectangle.X, $rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($rectangle.Right - $diameter, $rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($rectangle.Right - $diameter, $rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($rectangle.X, $rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-WikiIcon([int]$size, [bool]$transparentBackground = $false, [bool]$roundBackground = $false) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    if (-not $transparentBackground) {
        $bounds = New-Object System.Drawing.RectangleF 0, 0, $size, $size
        $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
            $bounds, `
            ([System.Drawing.ColorTranslator]::FromHtml("#07111d")), `
            ([System.Drawing.ColorTranslator]::FromHtml("#1a0c2b")), `
            135
        if ($roundBackground) {
            $ellipseBounds = New-Object System.Drawing.RectangleF ($size * 0.02), ($size * 0.02), ($size * 0.96), ($size * 0.96)
            $graphics.FillEllipse($background, $ellipseBounds)
        } else {
            $rounded = New-RoundedPath (New-Object System.Drawing.RectangleF ($size * 0.02), ($size * 0.02), ($size * 0.96), ($size * 0.96)) ($size * 0.18)
            $graphics.FillPath($background, $rounded)
            $rounded.Dispose()
        }
        $background.Dispose()

        $gridPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(20, 102, 236, 255)), ([Math]::Max(1, $size * 0.004))
        for ($position = [int]($size * 0.18); $position -lt $size * 0.9; $position += [int]([Math]::Max(8, $size * 0.14))) {
            $graphics.DrawLine($gridPen, $position, $size * 0.12, $position, $size * 0.88)
            $graphics.DrawLine($gridPen, $size * 0.12, $position, $size * 0.88, $position)
        }
        $gridPen.Dispose()
    }

    $center = $size / 2
    $orbitPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 91, 231, 255)), ([Math]::Max(2, $size * 0.026))
    $orbitPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $orbitPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawEllipse($orbitPen, $size * 0.19, $size * 0.34, $size * 0.62, $size * 0.32)
    $graphics.TranslateTransform($center, $center)
    $graphics.RotateTransform(-58)
    $graphics.TranslateTransform(-$center, -$center)
    $graphics.DrawEllipse($orbitPen, $size * 0.19, $size * 0.34, $size * 0.62, $size * 0.32)
    $graphics.ResetTransform()
    $orbitPen.Dispose()

    $anomalyPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(170, 188, 96, 255)), ([Math]::Max(2, $size * 0.018))
    $graphics.DrawArc($anomalyPen, $size * 0.27, $size * 0.27, $size * 0.46, $size * 0.46, 214, 236)
    $anomalyPen.Dispose()

    $diamond = @(
        (New-Object System.Drawing.PointF $center, ($size * 0.31)),
        (New-Object System.Drawing.PointF ($size * 0.69), $center),
        (New-Object System.Drawing.PointF $center, ($size * 0.69)),
        (New-Object System.Drawing.PointF ($size * 0.31), $center)
    )
    $coreBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        (New-Object System.Drawing.RectangleF ($size * 0.31), ($size * 0.31), ($size * 0.38), ($size * 0.38)), `
        ([System.Drawing.ColorTranslator]::FromHtml("#9a5cff")), `
        ([System.Drawing.ColorTranslator]::FromHtml("#32e6ff")), `
        90
    $graphics.FillPolygon($coreBrush, $diamond)
    $coreBrush.Dispose()

    $riftPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(245, 238, 252, 255)), ([Math]::Max(2, $size * 0.026))
    $riftPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $riftPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLines($riftPen, @(
        (New-Object System.Drawing.PointF ($size * 0.53), ($size * 0.37)),
        (New-Object System.Drawing.PointF ($size * 0.47), ($size * 0.48)),
        (New-Object System.Drawing.PointF ($size * 0.53), ($size * 0.55)),
        (New-Object System.Drawing.PointF ($size * 0.47), ($size * 0.64))
    ))
    $riftPen.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function Save-Png([System.Drawing.Bitmap]$bitmap, [string]$path) {
    $directory = Split-Path -Parent $path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

$buildDirectory = Join-Path $root "build"
$publicIconDirectory = Join-Path $root "public\icons"
New-Item -ItemType Directory -Force -Path $buildDirectory, $publicIconDirectory | Out-Null

foreach ($size in @(192, 512)) {
    $icon = New-WikiIcon $size
    Save-Png $icon (Join-Path $publicIconDirectory "icon-$size.png")
    $icon.Dispose()
}
$maskable = New-WikiIcon 512
Save-Png $maskable (Join-Path $publicIconDirectory "icon-maskable-512.png")
Save-Png $maskable (Join-Path $buildDirectory "icon.png")
$maskable.Dispose()

$icoBitmap = New-WikiIcon 256
$iconHandle = $icoBitmap.GetHicon()
try {
    $windowsIcon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $stream = [System.IO.File]::Create((Join-Path $buildDirectory "icon.ico"))
    try { $windowsIcon.Save($stream) } finally { $stream.Dispose(); $windowsIcon.Dispose() }
} finally {
    [NativeIconMethods]::DestroyIcon($iconHandle) | Out-Null
    $icoBitmap.Dispose()
}

$densitySizes = @{ "mdpi" = 48; "hdpi" = 72; "xhdpi" = 96; "xxhdpi" = 144; "xxxhdpi" = 192 }
foreach ($density in $densitySizes.Keys) {
    $directory = Join-Path $root "android\app\src\main\res\mipmap-$density"
    $launcher = New-WikiIcon $densitySizes[$density]
    Save-Png $launcher (Join-Path $directory "ic_launcher.png")
    $launcher.Dispose()
    $round = New-WikiIcon $densitySizes[$density] $false $true
    Save-Png $round (Join-Path $directory "ic_launcher_round.png")
    $round.Dispose()
    $foregroundSize = [int]($densitySizes[$density] * 2.25)
    $foreground = New-WikiIcon $foregroundSize $true
    Save-Png $foreground (Join-Path $directory "ic_launcher_foreground.png")
    $foreground.Dispose()
}

Get-ChildItem -Path (Join-Path $root "android\app\src\main\res") -Recurse -File -Filter "splash.png" | ForEach-Object {
    $existing = [System.Drawing.Image]::FromFile($_.FullName)
    $width = $existing.Width
    $height = $existing.Height
    $existing.Dispose()
    $splash = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($splash)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $bounds = New-Object System.Drawing.RectangleF 0, 0, $width, $height
    $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
        $bounds, `
        ([System.Drawing.ColorTranslator]::FromHtml("#050a12")), `
        ([System.Drawing.ColorTranslator]::FromHtml("#160a25")), `
        120
    $graphics.FillRectangle($background, $bounds)
    $background.Dispose()
    $markSize = [int]([Math]::Min($width, $height) * 0.3)
    $mark = New-WikiIcon $markSize
    $graphics.DrawImage($mark, [int](($width - $markSize) / 2), [int](($height - $markSize) / 2), $markSize, $markSize)
    $mark.Dispose()
    $graphics.Dispose()
    Save-Png $splash $_.FullName
    $splash.Dispose()
}

Write-Output "Generated PWA, Windows, and Android icons."

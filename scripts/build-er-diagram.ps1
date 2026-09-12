# build-er-diagram.ps1
#   Renders scripts/er-diagram-data.json into a standalone SVG diagram.
#
#   All Japanese text lives in the JSON so that this file stays pure ASCII
#   (Windows PowerShell 5.1 reads BOM-less UTF-8 .ps1 files as ANSI).
#
#   Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-er-diagram.ps1
#
#   Routing: every connector travels only through the vertical gutters between
#   columns and, for edges spanning two or more columns, along a horizontal lane
#   above the boxes. No line is ever drawn across a box.

[CmdletBinding()]
param(
    [string]$DataPath,
    [string]$Out
)

$ErrorActionPreference = 'Stop'

function Esc([string]$s) {
    return ($s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;')
}
function N([double]$v) { return [string][math]::Round($v, 1) }

$here = Split-Path $MyInvocation.MyCommand.Path -Parent
$root = Split-Path $here -Parent
if (-not $DataPath) { $DataPath = Join-Path $here 'er-diagram-data.json' }

$json = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8
$data = $json | ConvertFrom-Json

if (-not $Out) { $Out = Join-Path $root ($data.output -replace '/', '\') }

$L        = $data.layout
$boxW     = [double]$L.boxW
$boxH     = [double]$L.boxH
$colGap   = [double]$L.colGap
$rowGap   = [double]$L.rowGap
$left     = [double]$L.left
$top      = [double]$L.top
$groupGap = [double]$L.groupGap
$colPitch = $boxW + $colGap
$rowPitch = $boxH + $rowGap

# ---------------------------------------------------------------- place boxes
$box     = @{}
$labels  = New-Object System.Collections.ArrayList
$maxCol  = 0
foreach ($g in $data.groups) { if ([int]$g.col -gt $maxCol) { $maxCol = [int]$g.col } }

$bottom = $top
for ($c = 0; $c -le $maxCol; $c++) {
    $x = $left + $c * $colPitch
    $y = $top
    foreach ($g in $data.groups) {
        if ([int]$g.col -ne $c) { continue }
        [void]$labels.Add([pscustomobject]@{ x = $x; y = $y - 12; text = $g.title; color = $g.color })
        foreach ($t in $g.tables) {
            $box[$t[0]] = [pscustomobject]@{
                name = $t[0]; jp = $t[1]; col = $c; x = $x; y = $y; color = $g.color
            }
            $y += $rowPitch
        }
        $y += $groupGap
    }
    if ($y -gt $bottom) { $bottom = $y }
}

$noteTop  = $bottom + 14
$canvasW  = $left + $maxCol * $colPitch + $boxW + $left
$canvasH  = $noteTop + 26 * ($data.notes.Count + 1) + 40

# --------------------------------------------------------------- route edges
function Get-GutterX([int]$g) { return $left + $g * $colPitch + $boxW + $colGap / 2.0 }

$gutterUse = @{}
function Get-Stagger([double]$gx) {
    $k = [string][math]::Round($gx)
    if (-not $gutterUse.ContainsKey($k)) { $gutterUse[$k] = 0 }
    $i = $gutterUse[$k]
    $gutterUse[$k] = $i + 1
    return (($i % 7) - 3) * 7.0
}

$laneTop   = [double]$L.laneTop
$laneStep  = [double]$L.laneStep
$laneCount = [int]$L.laneCount
$laneIdx   = 0

$paths = New-Object System.Collections.ArrayList

foreach ($e in $data.edges) {
    $a = $box[$e.f]; $b = $box[$e.t]
    if (-not $a -or -not $b) { Write-Warning "unknown table in edge: $($e.f) -> $($e.t)"; continue }

    $ay = $a.y + $boxH / 2.0
    $by = $b.y + $boxH / 2.0
    $d  = $b.col - $a.col

    if ($d -eq 0) {
        $base = $left + $a.col * $colPitch - $colGap / 2.0
        $gx = $base + (Get-Stagger $base)
        $pts = @(@($a.x, $ay), @($gx, $ay), @($gx, $by), @($b.x, $by))
    }
    elseif ($d -eq 1) {
        $base = Get-GutterX $a.col
        $gx = $base + (Get-Stagger $base)
        $pts = @(@(($a.x + $boxW), $ay), @($gx, $ay), @($gx, $by), @($b.x, $by))
    }
    elseif ($d -eq -1) {
        $base = Get-GutterX $b.col
        $gx = $base + (Get-Stagger $base)
        $pts = @(@($a.x, $ay), @($gx, $ay), @($gx, $by), @(($b.x + $boxW), $by))
    }
    else {
        $lane = $laneTop - ($laneIdx % $laneCount) * $laneStep
        $laneIdx++
        if ($d -gt 0) {
            $bA = Get-GutterX $a.col
            $bB = Get-GutterX ($b.col - 1)
            $x1 = $a.x + $boxW; $x2 = $b.x
        } else {
            $bA = Get-GutterX ($a.col - 1)
            $bB = Get-GutterX $b.col
            $x1 = $a.x; $x2 = $b.x + $boxW
        }
        $gA = $bA + (Get-Stagger $bA)
        $gB = $bB + (Get-Stagger $bB)
        $pts = @(@($x1, $ay), @($gA, $ay), @($gA, $lane), @($gB, $lane), @($gB, $by), @($x2, $by))
    }

    $seg = @()
    for ($i = 0; $i -lt $pts.Count; $i++) {
        if ($i -eq 0) { $seg += ("M {0} {1}" -f (N $pts[$i][0]), (N $pts[$i][1])) }
        else          { $seg += ("L {0} {1}" -f (N $pts[$i][0]), (N $pts[$i][1])) }
    }

    $isOwn = $false
    if ($e.own) { $isOwn = $true }
    [void]$paths.Add([pscustomobject]@{
        d = ($seg -join ' '); own = $isOwn; pts = $pts; from = $e.f; to = $e.t
    })
}

# ---- verify: no connector segment may cross a box -------------------------
$hits = 0
foreach ($p in $paths) {
    for ($i = 0; $i -lt $p.pts.Count - 1; $i++) {
        $sx = [double]$p.pts[$i][0];   $sy = [double]$p.pts[$i][1]
        $ex = [double]$p.pts[$i+1][0]; $ey = [double]$p.pts[$i+1][1]
        $loX = [math]::Min($sx, $ex) + 2; $hiX = [math]::Max($sx, $ex) - 2
        $loY = [math]::Min($sy, $ey) + 2; $hiY = [math]::Max($sy, $ey) - 2
        foreach ($k in $box.Keys) {
            $t = $box[$k]
            $bx1 = $t.x + 1; $bx2 = $t.x + $boxW - 1
            $by1 = $t.y + 1; $by2 = $t.y + $boxH - 1
            if ($loX -le $bx2 -and $hiX -ge $bx1 -and $loY -le $by2 -and $hiY -ge $by1) {
                Write-Warning ("connector {0} -> {1} crosses box {2}" -f $p.from, $p.to, $t.name)
                $hits++
            }
        }
    }
}

# --------------------------------------------------------------------- render
$fontJp   = "'Yu Gothic UI','Yu Gothic','Hiragino Kaku Gothic ProN','Meiryo',sans-serif"
$fontMono = "'Consolas','Courier New',monospace"

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("<?xml version=`"1.0`" encoding=`"UTF-8`"?>")
[void]$sb.AppendLine("<svg xmlns=`"http://www.w3.org/2000/svg`" width=`"$(N $canvasW)`" height=`"$(N $canvasH)`" viewBox=`"0 0 $(N $canvasW) $(N $canvasH)`" font-family=`"$fontJp`">")
[void]$sb.AppendLine("  <defs>")
[void]$sb.AppendLine("    <marker id=`"arw`" viewBox=`"0 0 10 10`" refX=`"9`" refY=`"5`" markerWidth=`"7`" markerHeight=`"7`" orient=`"auto-start-reverse`">")
[void]$sb.AppendLine("      <path d=`"M 0 1 L 9 5 L 0 9 z`" fill=`"#8C98A4`"/>")
[void]$sb.AppendLine("    </marker>")
[void]$sb.AppendLine("    <marker id=`"arwOwn`" viewBox=`"0 0 10 10`" refX=`"9`" refY=`"5`" markerWidth=`"7`" markerHeight=`"7`" orient=`"auto-start-reverse`">")
[void]$sb.AppendLine("      <path d=`"M 0 1 L 9 5 L 0 9 z`" fill=`"#4A5765`"/>")
[void]$sb.AppendLine("    </marker>")
[void]$sb.AppendLine("  </defs>")
[void]$sb.AppendLine("  <rect x=`"0`" y=`"0`" width=`"$(N $canvasW)`" height=`"$(N $canvasH)`" fill=`"#FFFFFF`"/>")

# title
[void]$sb.AppendLine("  <text x=`"$(N $left)`" y=`"52`" font-size=`"23`" font-weight=`"700`" fill=`"#1A2430`">$(Esc $data.title)</text>")
[void]$sb.AppendLine("  <text x=`"$(N $left)`" y=`"76`" font-size=`"13`" fill=`"#6B7885`">$(Esc $data.subtitle)</text>")
[void]$sb.AppendLine("  <line x1=`"$(N $left)`" y1=`"92`" x2=`"$(N ($canvasW - $left))`" y2=`"92`" stroke=`"#DCE0DE`" stroke-width=`"1`"/>")

# connectors first, so boxes sit on top
[void]$sb.AppendLine("  <g fill=`"none`">")
foreach ($p in $paths) {
    if ($p.own) {
        [void]$sb.AppendLine("    <path d=`"$($p.d)`" stroke=`"#4A5765`" stroke-width=`"1.6`" marker-end=`"url(#arwOwn)`"/>")
    } else {
        [void]$sb.AppendLine("    <path d=`"$($p.d)`" stroke=`"#B6BEC6`" stroke-width=`"1`" marker-end=`"url(#arw)`"/>")
    }
}
[void]$sb.AppendLine("  </g>")

# group captions
foreach ($lb in $labels) {
    [void]$sb.AppendLine("  <text x=`"$(N $lb.x)`" y=`"$(N $lb.y)`" font-size=`"12`" font-weight=`"700`" letter-spacing=`"1.5`" fill=`"$($lb.color)`">$(Esc $lb.text)</text>")
}

# boxes
foreach ($k in ($box.Keys | Sort-Object)) {
    $t = $box[$k]
    [void]$sb.AppendLine("  <g>")
    [void]$sb.AppendLine("    <rect x=`"$(N $t.x)`" y=`"$(N $t.y)`" width=`"$(N $boxW)`" height=`"$(N $boxH)`" fill=`"#FFFFFF`" stroke=`"$($t.color)`" stroke-opacity=`"0.45`" stroke-width=`"1`"/>")
    [void]$sb.AppendLine("    <rect x=`"$(N $t.x)`" y=`"$(N $t.y)`" width=`"4`" height=`"$(N $boxH)`" fill=`"$($t.color)`"/>")
    [void]$sb.AppendLine("    <text x=`"$(N ($t.x + 14))`" y=`"$(N ($t.y + 20))`" font-size=`"13.5`" font-weight=`"700`" fill=`"#1A2430`">$(Esc $t.jp)</text>")
    [void]$sb.AppendLine("    <text x=`"$(N ($t.x + 14))`" y=`"$(N ($t.y + 37))`" font-size=`"10.5`" font-family=`"$fontMono`" fill=`"#78848F`">$(Esc $t.name)</text>")
    [void]$sb.AppendLine("  </g>")
}

# notes
$ny = $noteTop + 22
[void]$sb.AppendLine("  <line x1=`"$(N $left)`" y1=`"$(N $noteTop)`" x2=`"$(N ($canvasW - $left))`" y2=`"$(N $noteTop)`" stroke=`"#DCE0DE`" stroke-width=`"1`"/>")
foreach ($n in $data.notes) {
    [void]$sb.AppendLine("  <text x=`"$(N $left)`" y=`"$(N $ny)`" font-size=`"12.5`" fill=`"#5C6874`">$(Esc $n)</text>")
    $ny += 24
}

[void]$sb.AppendLine("</svg>")

$dir = Split-Path $Out -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("tables : {0}" -f $box.Count)
Write-Output ("edges  : {0}" -f $paths.Count)
Write-Output ("canvas : {0} x {1}" -f (N $canvasW), (N $canvasH))
Write-Output ("output : {0}" -f $Out)

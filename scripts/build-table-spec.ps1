# build-table-spec.ps1
#   Produces the Markdown source for the client-facing table specification
#   from three inputs:
#
#     docs/02-schema.sql            the authoritative schema
#     scripts/er-diagram-data.json  Japanese table names + chapter grouping
#     scripts/table-spec-ja.json    Japanese column names, wording, intro text
#
#   This file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
#   BOM-less UTF-8 .ps1 as ANSI, so every Japanese string lives in the JSON.
#
#   Usage:
#     powershell -ExecutionPolicy Bypass -File scripts\build-table-spec.ps1

[CmdletBinding()]
param([string]$Out)

$ErrorActionPreference = 'Stop'
$here = Split-Path $MyInvocation.MyCommand.Path -Parent
$root = Split-Path $here -Parent

. (Join-Path $here 'parse-schema.ps1')

$schema = Read-Schema (Join-Path $root 'docs\02-schema.sql')
$er     = (Get-Content -LiteralPath (Join-Path $here 'er-diagram-data.json') -Raw -Encoding UTF8) | ConvertFrom-Json
$ja     = (Get-Content -LiteralPath (Join-Path $here 'table-spec-ja.json')   -Raw -Encoding UTF8) | ConvertFrom-Json
$LB     = $ja.labels

if (-not $Out) { $Out = Join-Path $root ($ja.outputMarkdown -replace '/', '\') }

# ---- lookups ---------------------------------------------------------------
$tableJa    = @{}
foreach ($g in $er.groups) { foreach ($t in $g.tables) { $tableJa[$t[0]] = $t[1] } }

$colJa = @{}
foreach ($p in $ja.columns.PSObject.Properties)   { $colJa[$p.Name] = $p.Value }
$colOv = @{}
foreach ($p in $ja.overrides.PSObject.Properties) { $colOv[$p.Name] = $p.Value }
$typeJa = @{}
foreach ($p in $ja.types.PSObject.Properties)     { $typeJa[$p.Name] = $p.Value }
$noteOv = @{}
foreach ($p in $ja.noteOverrides.PSObject.Properties) { $noteOv[$p.Name] = $p.Value }
$chapIntro = @{}
foreach ($p in $ja.chapterIntros.PSObject.Properties) { $chapIntro[$p.Name] = $p.Value }

function Ja-Column([string]$tbl, [string]$col) {
    $k = "$tbl.$col"
    if ($colOv.ContainsKey($k))   { return $colOv[$k] }
    if ($colJa.ContainsKey($col)) { return $colJa[$col] }
    return $col
}

function Ja-Type([string]$t) {
    if ($typeJa.ContainsKey($t)) { return $typeJa[$t] }
    if ($t -match '^(?i)VARCHAR\((\d+)\)$') { return ($LB.charFmt -f $Matches[1]) }
    if ($t -match '^(?i)NUMERIC\(')         { return $LB.numeric }
    return $t
}

function Clean-Note([string]$s, [string]$jaName) {
    if (-not $s) { return '' }
    foreach ($p in $LB.stripPatterns) { $s = $s -replace $p, '' }
    foreach ($r in $LB.replacements)  { $s = $s.Replace($r[0], $r[1]) }
    $s = ($s -replace '\|', '/').Trim()

    if ($LB.dropNotes -contains $s) { return '' }
    if ($jaName) {
        # a note that only repeats the item name adds nothing
        if ($s -eq $jaName) { return '' }
        $prefix = $jaName + $LB.period
        if ($s.StartsWith($prefix)) { $s = $s.Substring($prefix.Length).Trim() }
    }
    return $s
}

# ---- build -----------------------------------------------------------------
$md = New-Object System.Collections.ArrayList
function W([string]$s) { [void]$md.Add($s) }

W ('# ' + $LB.chapter1)
W ''
W $ja.intro.purpose
W ''
W ('## ' + $LB.howtoHead)
W ''
foreach ($h in $ja.intro.howto) { W ('- ' + $h) }
W ''

$chapTables = @{}
foreach ($ch in $ja.chapterOrder) {
    $list = New-Object System.Collections.ArrayList
    foreach ($g in $er.groups) {
        if ($g.title -ne $ch) { continue }
        foreach ($t in $g.tables) { [void]$list.Add($t[0]) }
    }
    $chapTables[$ch] = $list
}

W ('## ' + $LB.overviewHead)
W ''
W ($LB.overviewIntro -f $schema.Tables.Count)
W ''
W $LB.overviewHeader
W '|---|---|---|'
foreach ($ch in $ja.chapterOrder) {
    $names = @()
    foreach ($t in $chapTables[$ch]) { $names += $tableJa[$t] }
    $head = (($names | Select-Object -First 4) -join $LB.joiner)
    if ($names.Count -gt 4) { $head += $LB.etc }
    W ('| ' + $ch + ' | ' + $chapTables[$ch].Count + ' | ' + $head + ' |')
}
W ''

# ---- chapters --------------------------------------------------------------
$chapNo   = 2
$colTotal = 0
foreach ($ch in $ja.chapterOrder) {

    W ('# ' + $chapNo + '. ' + $ch)
    W ''
    if ($chapIntro.ContainsKey($ch)) {
        foreach ($line in $chapIntro[$ch]) { W $line; W '' }
    }

    $secNo = 1
    foreach ($tn in $chapTables[$ch]) {

        if (-not $schema.Tables.Contains($tn)) { Write-Warning "not in schema: $tn"; continue }
        $cols = $schema.Tables[$tn]
        $colTotal += $cols.Count

        W ('## ' + $chapNo + '.' + $secNo + ' ' + $tableJa[$tn] + $LB.nameOpen + $tn + $LB.nameClose)
        W ''
        if ($schema.TableComments.ContainsKey($tn)) {
            $tc = Clean-Note $schema.TableComments[$tn] ''
            if ($tc) { W $tc; W '' }
        }

        W $LB.colHeader
        W '|---|---|---|---|---|'
        foreach ($c in $cols) {

            $req = ''
            if ($c.notNull) { $req = $LB.required }

            $jaName = Ja-Column $tn $c.name
            $note   = Clean-Note $c.note $jaName

            if ($c.identity) {
                if ($note) { $note = $LB.identity + $LB.period + $note } else { $note = $LB.identity }
            }
            elseif ($c.generated) {
                if ($note) { $note = $LB.generated + $LB.period + $note } else { $note = $LB.generated }
            }
            elseif ($c.ref) {
                $refJa = $c.ref
                if ($tableJa.ContainsKey($c.ref)) { $refJa = $tableJa[$c.ref] }
                $link = ($LB.refFmt -f $refJa)
                if ($note) { $note = $link + $LB.period + $note } else { $note = $link }
            }

            if ($c.default -and -not $c.ref -and -not $c.identity -and -not $c.generated) {
                $d = $c.default
                if ($d -match '(?i)^(true|false)$') {
                    $dv = $LB.boolNo
                    if ($d -match '(?i)true') { $dv = $LB.boolYes }
                    if ($note) { $note = $note + ($LB.defaultSuffix -f $dv) } else { $note = ($LB.defaultFmt -f $dv) }
                }
                elseif ($d -notmatch '(?i)now\(\)') {
                    $dd = $d.Trim("'")
                    if ($note) { $note = $note + ($LB.defaultSuffix -f $dd) } else { $note = ($LB.defaultFmt -f $dd) }
                }
            }

            $ovKey = "$tn.$($c.name)"
            if ($noteOv.ContainsKey($ovKey)) { $note = $noteOv[$ovKey] }

            W ('| ' + $jaName + ' | ' + $c.name + ' | ' + (Ja-Type $c.type) + ' | ' + $req + ' | ' + $note + ' |')
        }
        W ''
        $secNo++
    }
    $chapNo++
}

$text = ($md -join "`r`n")
$dir  = Split-Path $Out -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("tables   : {0}" -f $schema.Tables.Count)
Write-Output ("columns  : {0}" -f $colTotal)
Write-Output ("chapters : {0}" -f $ja.chapterOrder.Count)
Write-Output ("markdown : {0}" -f $Out)

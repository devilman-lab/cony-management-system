# parse-schema.ps1
#   Extracts table and column definitions from docs/02-schema.sql.
#
#   This file stays pure ASCII (Windows PowerShell 5.1 reads BOM-less UTF-8
#   .ps1 files as ANSI, which mangles Japanese source). It is dot-sourced by
#   build-table-spec.ps1 and can also be run directly to dump an inventory.
#
#   Usage (inventory of every distinct column name, for building the JA map):
#     powershell -ExecutionPolicy Bypass -File scripts\parse-schema.ps1 -Inventory

[CmdletBinding()]
param(
    [string]$SqlPath,
    [switch]$Inventory,
    [string]$InventoryOut
)

function Read-Schema([string]$path) {

    $text  = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $lines = $text -split "`r?`n"

    $tables    = New-Object System.Collections.Specialized.OrderedDictionary
    $tblComm   = @{}
    $colComm   = @{}

    $depth     = 0
    $inString  = $false
    $curTable  = $null
    $defBuf    = New-Object System.Text.StringBuilder
    $pending   = New-Object System.Collections.ArrayList   # leading -- comments
    $flatBuf   = New-Object System.Text.StringBuilder      # depth-0 statement text

    foreach ($raw in $lines) {

        $code    = ''
        $comment = ''

        # split code / trailing "--" comment, honouring single-quoted strings
        for ($i = 0; $i -lt $raw.Length; $i++) {
            $ch = $raw[$i]
            if ($inString) {
                $code += $ch
                if ($ch -eq "'") { $inString = $false }
                continue
            }
            if ($ch -eq "'") { $inString = $true; $code += $ch; continue }
            if ($ch -eq '-' -and $i + 1 -lt $raw.Length -and $raw[$i + 1] -eq '-') {
                $comment = $raw.Substring($i + 2).Trim()
                break
            }
            $code += $ch
        }

        if (-not $curTable) {
            # ---- outside a CREATE TABLE block -------------------------------
            [void]$flatBuf.Append(' ').Append($code)
            $flat = $flatBuf.ToString()

            if ($flat -match '(?is)CREATE\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(') {
                $curTable = $Matches[1]
                $tables[$curTable] = New-Object System.Collections.ArrayList
                $depth = 1
                [void]$defBuf.Clear()
                [void]$pending.Clear()
                # anything after the opening paren on this same line
                $after = $flat.Substring($flat.IndexOf('(', $flat.IndexOf($curTable)) + 1)
                [void]$flatBuf.Clear()
                $code = $after
            }
            else {
                if ($flat -match "(?is)COMMENT\s+ON\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+'((?:[^']|'')*)'") {
                    $tblComm[$Matches[1]] = ($Matches[2] -replace "''", "'")
                    [void]$flatBuf.Clear()
                }
                elseif ($flat -match "(?is)COMMENT\s+ON\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+IS\s+((?:'(?:[^']|'')*'\s*\|?\|?\s*)+)") {
                    $key = $Matches[1] + '.' + $Matches[2]
                    $val = ''
                    foreach ($m in [regex]::Matches($Matches[3], "'((?:[^']|'')*)'")) {
                        $val += ($m.Groups[1].Value -replace "''", "'")
                    }
                    $colComm[$key] = $val
                    [void]$flatBuf.Clear()
                }
                elseif ($flat -match ';\s*$') { [void]$flatBuf.Clear() }
                if (-not $curTable) {
                    if ($comment -and $flatBuf.Length -eq 0) { }
                    continue
                }
            }
        }

        # ---- inside a CREATE TABLE block ------------------------------------
        if ($curTable) {
            if ($code.Trim() -eq '' -and $comment) { [void]$pending.Add($comment); continue }

            $emitted = $false
            for ($i = 0; $i -lt $code.Length; $i++) {
                $ch = $code[$i]
                if ($inString) { [void]$defBuf.Append($ch); if ($ch -eq "'") { $inString = $false }; continue }
                if ($ch -eq "'") { $inString = $true; [void]$defBuf.Append($ch); continue }

                if ($ch -eq '(') { $depth++; [void]$defBuf.Append($ch); continue }
                if ($ch -eq ')') {
                    $depth--
                    if ($depth -eq 0) {
                        $d = $defBuf.ToString().Trim()
                        if ($d) { if (Add-Def $tables[$curTable] $d $pending) { $emitted = $true } }
                        [void]$defBuf.Clear(); [void]$pending.Clear()
                        $curTable = $null
                        [void]$flatBuf.Clear()
                        break
                    }
                    [void]$defBuf.Append($ch); continue
                }
                if ($ch -eq ',' -and $depth -eq 1) {
                    $d = $defBuf.ToString().Trim()
                    if ($d) { if (Add-Def $tables[$curTable] $d $pending) { $emitted = $true } }
                    [void]$defBuf.Clear(); [void]$pending.Clear()
                    continue
                }
                [void]$defBuf.Append($ch)
            }

            if ($comment) {
                if ($emitted -and $curTable -and $tables[$curTable].Count -gt 0) {
                    $last = $tables[$curTable][$tables[$curTable].Count - 1]
                    if ($last.note) { $last.note = $last.note + ' ' + $comment } else { $last.note = $comment }
                } elseif ($comment -and $curTable) {
                    [void]$pending.Add($comment)
                }
            }
        }
    }

    # attach COMMENT ON results
    foreach ($tn in @($tables.Keys)) {
        foreach ($c in $tables[$tn]) {
            $k = $tn + '.' + $c.name
            if ($colComm.ContainsKey($k)) { $c.note = $colComm[$k] }
        }
    }

    return [pscustomobject]@{ Tables = $tables; TableComments = $tblComm }
}

function Add-Def($list, [string]$def, $pending) {

    $one = ($def -replace '\s+', ' ').Trim()
    if ($one -match '(?i)^(CONSTRAINT|UNIQUE|PRIMARY\s+KEY|CHECK|FOREIGN\s+KEY|EXCLUDE)\b') { return $false }
    if ($one -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$') { return $false }

    $name = $Matches[1]
    $rest = $Matches[2]

    $type = ''
    if ($rest -match '^([A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)') { $type = ($Matches[1] -replace '\s+', '') }

    $isPk  = ($rest -match '(?i)\bPRIMARY\s+KEY\b')
    $isId  = ($rest -match '(?i)GENERATED\s+ALWAYS\s+AS\s+IDENTITY')
    $isGen = ($rest -match '(?i)GENERATED\s+ALWAYS\s+AS\s*\(') -and -not $isId
    $notNull = ($rest -match '(?i)\bNOT\s+NULL\b') -or $isPk -or $isId

    $ref = ''
    if ($rest -match '(?i)REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)') { $ref = $Matches[1] }

    $def2 = ''
    if ($rest -match "(?i)\bDEFAULT\s+([^,]*?)(?:\s+(?:NOT\s+NULL|REFERENCES|CHECK|UNIQUE|PRIMARY)\b|$)") {
        $def2 = $Matches[1].Trim()
    }

    $note = ''
    if ($pending -and $pending.Count -gt 0) { $note = ($pending -join ' ') }

    [void]$list.Add([pscustomobject]@{
        name = $name; type = $type; notNull = $notNull; pk = $isPk; identity = $isId
        generated = $isGen; ref = $ref; default = $def2; note = $note
    })
    return $true
}

# ------------------------------------------------------------------ standalone
if ($MyInvocation.InvocationName -ne '.') {
    $here = Split-Path $MyInvocation.MyCommand.Path -Parent
    $root = Split-Path $here -Parent
    if (-not $SqlPath) { $SqlPath = Join-Path $root 'docs\02-schema.sql' }

    $r = Read-Schema $SqlPath
    Write-Output ("tables  : {0}" -f $r.Tables.Count)
    $total = 0
    foreach ($k in $r.Tables.Keys) { $total += $r.Tables[$k].Count }
    Write-Output ("columns : {0}" -f $total)

    if ($Inventory) {
        if (-not $InventoryOut) { $InventoryOut = Join-Path $here 'schema-inventory.txt' }
        $agg = @{}
        foreach ($tn in $r.Tables.Keys) {
            foreach ($c in $r.Tables[$tn]) {
                if (-not $agg.ContainsKey($c.name)) {
                    $agg[$c.name] = [pscustomobject]@{ n = 0; type = $c.type; note = ''; tables = @() }
                }
                $a = $agg[$c.name]
                $a.n++
                $a.tables += $tn
                if (-not $a.note -and $c.note) { $a.note = $c.note }
            }
        }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.AppendLine("# distinct columns: " + $agg.Count)
        foreach ($k in ($agg.Keys | Sort-Object)) {
            $a = $agg[$k]
            $tl = if ($a.n -le 3) { ($a.tables -join ',') } else { ($a.tables[0..2] -join ',') + ',+' + ($a.n - 3) }
            [void]$sb.AppendLine(("{0}`t{1}`t{2}`t{3}`t{4}" -f $k, $a.n, $a.type, $tl, $a.note))
        }
        [System.IO.File]::WriteAllText($InventoryOut, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
        Write-Output ("inventory: {0}  ({1} distinct)" -f $InventoryOut, $agg.Count)
    }
}

# generate-db-types.ps1
#   Generates backend/src/db/schema.ts (Kysely table interfaces) from
#   docs/02-schema.sql, so the TypeScript types can never drift from the
#   database definition. Re-run this whenever 02-schema.sql changes.
#
#   ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1
#   as ANSI. Japanese text in the output comes from the parsed SQL at runtime.
#
#   Usage:
#     powershell -ExecutionPolicy Bypass -File scripts\generate-db-types.ps1

[CmdletBinding()]
param([string]$Out)

$ErrorActionPreference = 'Stop'
$here = Split-Path $MyInvocation.MyCommand.Path -Parent
$root = Split-Path $here -Parent

. (Join-Path $here 'parse-schema.ps1')

$schema = Read-Schema (Join-Path $root 'docs\02-schema.sql')
if (-not $Out) { $Out = Join-Path $root 'backend\src\db\schema.ts' }

function To-Pascal([string]$s) {
    ($s -split '_' | ForEach-Object {
        if ($_.Length -eq 0) { '' } else { $_.Substring(0,1).ToUpper() + $_.Substring(1) }
    }) -join ''
}

# SQL type -> TypeScript type.
#   numeric stays a string: node-postgres returns NUMERIC as text, and money
#   must never pass through a float. Amount arithmetic is done in SQL.
#   date also stays a string (YYYY-MM-DD) to avoid timezone drift.
function To-Ts([string]$t) {
    switch -Regex ($t) {
        '^(?i)BIGINT$'       { return 'number' }
        '^(?i)INTEGER$'      { return 'number' }
        '^(?i)SMALLINT$'     { return 'number' }
        '^(?i)BOOLEAN$'      { return 'boolean' }
        '^(?i)TEXT$'         { return 'string' }
        '^(?i)VARCHAR'       { return 'string' }
        '^(?i)DATE$'         { return 'string' }
        '^(?i)TIMESTAMPTZ$'  { return 'Date' }
        '^(?i)JSONB$'        { return 'unknown' }
        '^(?i)NUMERIC'       { return 'string' }
        '^money_amt$'        { return 'string' }
        '^qty_num$'          { return 'string' }
        '^tax_rate$'         { return 'string' }
        default              { return 'unknown' }
    }
}

function Esc-Comment([string]$s) {
    if (-not $s) { return '' }
    return ($s -replace '\*/', '* /' -replace '[\r\n]+', ' ').Trim()
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('// ---------------------------------------------------------------------------')
[void]$sb.AppendLine('// AUTO-GENERATED - DO NOT EDIT BY HAND')
[void]$sb.AppendLine('//')
[void]$sb.AppendLine('// Source : docs/02-schema.sql')
[void]$sb.AppendLine('// Command: powershell -ExecutionPolicy Bypass -File scripts\generate-db-types.ps1')
[void]$sb.AppendLine('//')
[void]$sb.AppendLine('// Type mapping notes')
[void]$sb.AppendLine('//   NUMERIC / money_amt / qty_num / tax_rate -> string')
[void]$sb.AppendLine('//     node-postgres returns NUMERIC as text. Keeping it as a string means an')
[void]$sb.AppendLine('//     amount can never silently pass through a float. Do the arithmetic in SQL.')
[void]$sb.AppendLine('//   DATE -> string (YYYY-MM-DD), TIMESTAMPTZ -> Date')
[void]$sb.AppendLine('//     A bare date has no timezone, so it must not become a Date object.')
[void]$sb.AppendLine('//   BIGINT -> number')
[void]$sb.AppendLine('//     src/db/database.module.ts registers an int8 parser. Safe for row ids.')
[void]$sb.AppendLine('// ---------------------------------------------------------------------------')
[void]$sb.AppendLine('')
[void]$sb.AppendLine("import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';")
[void]$sb.AppendLine('')
[void]$sb.AppendLine('/** A column the database always computes. Never written from the application. */')
[void]$sb.AppendLine('type Computed<T> = ColumnType<T, never, never>;')
[void]$sb.AppendLine('')

$tableNames = @()
foreach ($tn in $schema.Tables.Keys) {
    $tableNames += $tn
    $pas  = To-Pascal $tn
    $cols = $schema.Tables[$tn]

    $tc = Esc-Comment $schema.TableComments[$tn]
    if ($tc) {
        [void]$sb.AppendLine('/** ' + $tc + ' */')
    }
    [void]$sb.AppendLine('export interface ' + $pas + 'Table {')

    foreach ($c in $cols) {
        $ts = To-Ts $c.type
        $nullable = -not $c.notNull

        if ($c.generated) {
            $inner = $ts; if ($nullable) { $inner = $ts + ' | null' }
            $decl = 'Computed<' + $inner + '>'
        }
        elseif ($c.identity) {
            $decl = 'Generated<' + $ts + '>'
        }
        elseif ($c.default) {
            $inner = $ts; if ($nullable) { $inner = $ts + ' | null' }
            $decl = 'Generated<' + $inner + '>'
        }
        elseif ($nullable) {
            $decl = $ts + ' | null'
        }
        else {
            $decl = $ts
        }

        $note = Esc-Comment $c.note
        $bits = @()
        if ($c.ref)     { $bits += ('-> ' + $c.ref) }
        if ($c.type)    { $bits += $c.type }
        $meta = ($bits -join ' / ')
        if ($note) { $line = '  /** ' + $note + '  [' + $meta + '] */' }
        else       { $line = '  /** [' + $meta + '] */' }
        [void]$sb.AppendLine($line)
        [void]$sb.AppendLine('  ' + $c.name + ': ' + $decl + ';')
    }

    [void]$sb.AppendLine('}')
    [void]$sb.AppendLine('export type ' + $pas + ' = Selectable<' + $pas + 'Table>;')
    [void]$sb.AppendLine('export type New' + $pas + ' = Insertable<' + $pas + 'Table>;')
    [void]$sb.AppendLine('export type ' + $pas + 'Update = Updateable<' + $pas + 'Table>;')
    [void]$sb.AppendLine('')
}

[void]$sb.AppendLine('/** Every table in the cony schema. Passed to Kysely as its database type. */')
[void]$sb.AppendLine('export interface DB {')
foreach ($tn in ($tableNames | Sort-Object)) {
    [void]$sb.AppendLine('  ' + $tn + ': ' + (To-Pascal $tn) + 'Table;')
}
[void]$sb.AppendLine('}')

$dir = Split-Path $Out -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

$colCount = 0
foreach ($k in $schema.Tables.Keys) { $colCount += $schema.Tables[$k].Count }
Write-Output ("tables  : {0}" -f $schema.Tables.Count)
Write-Output ("columns : {0}" -f $colCount)
Write-Output ("output  : {0}" -f $Out)

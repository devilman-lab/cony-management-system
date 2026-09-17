<#
  実装済みの API 経路を、コントローラの実物から数え上げる
  ------------------------------------------------------------------
  API 仕様書の付録（経路一覧）は手で書き写すとすぐ実物とずれるため、
  ソースから作る。デコレータの並びだけを見ており、TypeScript は解釈しない。

  1つのハンドラに付く装飾子は、前のハンドラの宣言行と、そのハンドラ自身の
  宣言行との間にある。@Public() は @Get() の前に書かれることもあるため、
  「次の装飾子が来たら確定」ではなく「宣言行が来たら確定」で区切る。

    powershell -ExecutionPolicy Bypass -File scripts\list-api-routes.ps1
    powershell -ExecutionPolicy Bypass -File scripts\list-api-routes.ps1 -AsMarkdown
#>
[CmdletBinding()]
param(
  [switch] $AsMarkdown
)

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$src  = Join-Path $root 'backend\src'

$routes = New-Object System.Collections.ArrayList

function New-Block { @{ method = ''; path = ''; permission = '' } }

foreach ($file in (Get-ChildItem -Path $src -Recurse -Filter '*.controller.ts' | Sort-Object FullName)) {
  $lines  = [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8)
  $prefix = ''
  $block  = New-Block

  foreach ($line in $lines) {

    if ($line -match "^\s*@Controller\(") {
      if ($line -match "^\s*@Controller\(\s*'([^']*)'\s*\)") { $prefix = $Matches[1] } else { $prefix = '' }
      continue
    }

    if ($line -match "^\s*@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)") {
      $tail = $Matches[2]
      # @Controller() のように接頭辞がないものがあるため、空の区切りは落とす
      $parts = @('api', $prefix, $tail) | Where-Object { $_ -ne '' -and $null -ne $_ }
      $block.method = $Matches[1].ToUpper()
      $block.path   = '/' + ($parts -join '/')
      continue
    }

    if ($line -match "@RequirePermission\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)") {
      $block.permission = $Matches[1] + ':' + $Matches[2]
      continue
    }
    if ($line -match '@Public\(\)') { $block.permission = '(public)'; continue }

    # 装飾子でもコメントでもない行が来たら、そこがハンドラの宣言行
    if ($line -match '^\s*@') { continue }
    if ($line -match '^\s*(/\*|\*|//)') { continue }
    if ($line -match '^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\(' -and $block.method -ne '') {
      [void]$routes.Add([pscustomobject]@{
        method     = $block.method
        path       = $block.path
        permission = if ($block.permission) { $block.permission } else { '(login)' }
        file       = $file.Name
      })
      $block = New-Block
    }
  }
}

if ($AsMarkdown) {
  Write-Output '| メソッド | 経路 | 必要な権限 |'
  Write-Output '|---|---|---|'
  foreach ($r in $routes) {
    $perm = switch ($r.permission) {
      '(public)' { 'ログイン不要' }
      '(login)'  { 'ログインのみ' }
      default    { $r.permission }
    }
    Write-Output ('| {0} | {1} | {2} |' -f $r.method, $r.path, $perm)
  }
} else {
  foreach ($r in $routes) {
    Write-Output ("{0}`t{1}`t{2}`t{3}" -f $r.method, $r.path, $r.permission, $r.file)
  }
}

Write-Output ''
Write-Output ('total: {0} routes' -f $routes.Count)

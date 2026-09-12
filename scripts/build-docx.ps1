<#
  Markdown から提出用 Word 文書を作る
  ------------------------------------------------------------------
  既存の要件定義書（v1.1.docx）をひな形として使い、書式（見出し・表・
  フッタ・余白）をそのまま引き継いだうえで、本文だけを差し替えます。

  対応している記法
    # / ## / ###      見出し1／2／3
    | a | b |         表（2行目が |---| の区切り行。1行目を見出し行として扱う）
    ```               等幅の枠（図やコード。改行をそのまま保つ）
    **太字**          太字
    ---               無視する
    <PAGEBREAK>       改ページ

  使い方
    powershell -ExecutionPolicy Bypass -File scripts\build-docx.ps1 `
      -Markdown "docs\提出用\販売管理システム_要件定義書_v2.0.md" `
      -Template "docs\提出用\販売管理システム_要件定義書_v1.1.docx" `
      -Output   "docs\提出用\販売管理システム_要件定義書_v2.0.docx" `
      -Title    "販売管理システム要件定義書" `
      -Client   "株式会社コニー 様" `
      -Version  "第2.0版　2026年9月8日" `
      -Author   "渡辺（TechStudio）"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string] $Markdown,
  [Parameter(Mandatory=$true)][string] $Template,
  [Parameter(Mandatory=$true)][string] $Output,
  [string] $Title   = "販売管理システム要件定義書",
  [string] $Client  = "株式会社コニー 様",
  [string] $Version = "",
  [string] $Author  = "渡辺（TechStudio）"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')
}

# **太字** を含む1行を、複数の run に分解する
function Runs([string]$text, [string]$extraRpr = '') {
  $sb = New-Object System.Text.StringBuilder
  foreach ($part in ([regex]::Split($text, '(\*\*[^*]+\*\*)'))) {
    if ($part -eq '') { continue }
    if ($part -match '^\*\*(.+)\*\*$') {
      [void]$sb.Append('<w:r><w:rPr><w:b/>' + $extraRpr + '</w:rPr><w:t xml:space="preserve">' + (Esc $Matches[1]) + '</w:t></w:r>')
    } else {
      $rpr = if ($extraRpr) { '<w:rPr>' + $extraRpr + '</w:rPr>' } else { '' }
      [void]$sb.Append('<w:r>' + $rpr + '<w:t xml:space="preserve">' + (Esc $part) + '</w:t></w:r>')
    }
  }
  $sb.ToString()
}

function Para([string]$text) {
  '<w:p><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>' + (Runs $text) + '</w:p>'
}

# 見出し。Heading1 は styles.xml 側で改ページと青い罫線が定義されている。
function Heading([int]$level, [string]$text, [bool]$noPageBreak = $false) {
  $pb = if ($level -eq 1 -and $noPageBreak) { '<w:pageBreakBefore w:val="0"/>' } else { '' }
  '<w:p><w:pPr><w:pStyle w:val="Heading' + $level + '"/>' + $pb + '</w:pPr>' + (Runs $text) + '</w:p>'
}

# 目次の1行。右端にドットリーダー付きのタブを置き、Word が更新するとページ番号が入る。
function TocLine([int]$level, [string]$text, [string]$inner = '') {
  '<w:p><w:pPr><w:pStyle w:val="TOC' + $level + '"/>' +
  '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9628"/></w:tabs>' +
  '<w:rPr><w:noProof/></w:rPr></w:pPr>' + $inner + (Runs $text) + '</w:p>'
}

# 等幅の枠（図・レイアウトの説明用）
function MonoBlock([string[]]$lines) {
  $rpr = '<w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic"/><w:sz w:val="16"/><w:szCs w:val="16"/>'
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<w:p><w:pPr><w:spacing w:before="60" w:after="120" w:line="240" w:lineRule="auto"/><w:pBdr>')
  [void]$sb.Append('<w:top w:val="single" w:sz="4" w:space="4" w:color="C0C0C0"/><w:left w:val="single" w:sz="4" w:space="4" w:color="C0C0C0"/>')
  [void]$sb.Append('<w:bottom w:val="single" w:sz="4" w:space="4" w:color="C0C0C0"/><w:right w:val="single" w:sz="4" w:space="4" w:color="C0C0C0"/></w:pBdr>')
  [void]$sb.Append('<w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/></w:pPr>')
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -gt 0) { [void]$sb.Append('<w:r><w:rPr>' + $rpr + '</w:rPr><w:br/></w:r>') }
    [void]$sb.Append('<w:r><w:rPr>' + $rpr + '</w:rPr><w:t xml:space="preserve">' + (Esc $lines[$i]) + '</w:t></w:r>')
  }
  [void]$sb.Append('</w:p>')
  $sb.ToString()
}

function Table([string[][]]$rows) {
  $total   = 9628
  $colCnt  = $rows[0].Count
  $widths  = @()
  if     ($colCnt -eq 2) { $widths = @(3274, 6354) }
  elseif ($colCnt -eq 5) { $widths = @(1950, 2050, 1100, 700, 3828) }   # テーブル定義書：項目／列名／型／必須／説明
  else {
    $w = [int][Math]::Floor($total / $colCnt)
    for ($i = 0; $i -lt $colCnt; $i++) { $widths += $w }
    $widths[0] += $total - ($w * $colCnt)
  }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>')
  foreach ($e in @('top','left','bottom','right','insideH','insideV')) {
    [void]$sb.Append('<w:' + $e + ' w:val="single" w:sz="4" w:space="0" w:color="808080"/>')
  }
  [void]$sb.Append('</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar>')
  [void]$sb.Append('<w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/>')
  [void]$sb.Append('</w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>')
  foreach ($w in $widths) { [void]$sb.Append('<w:gridCol w:w="' + $w + '"/>') }
  [void]$sb.Append('</w:tblGrid>')

  for ($r = 0; $r -lt $rows.Count; $r++) {
    $isHeader = ($r -eq 0)
    [void]$sb.Append('<w:tr>')
    if ($isHeader) { [void]$sb.Append('<w:trPr><w:tblHeader/></w:trPr>') }
    for ($c = 0; $c -lt $colCnt; $c++) {
      $cell = if ($c -lt $rows[$r].Count) { $rows[$r][$c] } else { '' }
      [void]$sb.Append('<w:tc><w:tcPr><w:tcW w:w="' + $widths[$c] + '" w:type="dxa"/>')
      if ($isHeader) { [void]$sb.Append('<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>') }
      [void]$sb.Append('</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr>')
      $rpr = if ($isHeader) { '<w:b/><w:sz w:val="18"/><w:szCs w:val="18"/>' } else { '<w:sz w:val="18"/><w:szCs w:val="18"/>' }
      [void]$sb.Append((Runs $cell $rpr))
      [void]$sb.Append('</w:p></w:tc>')
    }
    [void]$sb.Append('</w:tr>')
  }
  [void]$sb.Append('</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>')
  $sb.ToString()
}

# --- Markdown を読む -------------------------------------------------------
$mdLines = [System.IO.File]::ReadAllText((Resolve-Path $Markdown), [System.Text.Encoding]::UTF8) -split "`r?`n"

$body    = New-Object System.Text.StringBuilder
$tocList = New-Object System.Collections.ArrayList
$i = 0
while ($i -lt $mdLines.Count) {
  $line = $mdLines[$i]

  if ($line -match '^\s*$')      { $i++; continue }
  if ($line -match '^---+\s*$')  { $i++; continue }

  if ($line -eq '<PAGEBREAK>') {
    [void]$body.Append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); $i++; continue
  }

  if ($line -match '^(#{1,3})\s+(.*)$') {
    $lv = $Matches[1].Length
    $tx = $Matches[2]
    [void]$body.Append((Heading $lv $tx))
    [void]$tocList.Add(@{ Level = $lv; Text = $tx })
    $i++; continue
  }

  if ($line -match '^```') {
    $buf = @()
    $i++
    while ($i -lt $mdLines.Count -and $mdLines[$i] -notmatch '^```') { $buf += $mdLines[$i]; $i++ }
    $i++
    [void]$body.Append((MonoBlock $buf))
    continue
  }

  if ($line -match '^\s*\|') {
    $rows = @()
    while ($i -lt $mdLines.Count -and $mdLines[$i] -match '^\s*\|') {
      $raw = $mdLines[$i].Trim()
      if ($raw -notmatch '^\|[\s\-:|]+\|$') {
        $cells = $raw.Trim('|') -split '\|' | ForEach-Object { $_.Trim() }
        $rows += ,@($cells)
      }
      $i++
    }
    if ($rows.Count -gt 0) { [void]$body.Append((Table $rows)) }
    continue
  }

  [void]$body.Append((Para $line))
  $i++
}

# --- 表紙と目次 ------------------------------------------------------------
$cover = '<w:p><w:pPr><w:spacing w:before="3600" w:after="240"/><w:jc w:val="center"/></w:pPr>' +
         '<w:r><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>' +
         '<w:t xml:space="preserve">' + (Esc $Title) + '</w:t></w:r></w:p>' +
         '<w:p><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr>' +
         '<w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">' + (Esc $Client) + '</w:t></w:r></w:p>' +
         '<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="center"/></w:pPr>' +
         '<w:r><w:t xml:space="preserve">' + (Esc $Version) + '</w:t></w:r></w:p>' +
         '<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="center"/></w:pPr>' +
         '<w:r><w:t xml:space="preserve">' + (Esc $Author) + '</w:t></w:r></w:p>'

# 目次は表紙と同じページに置く（v1.1 と同じ体裁）。
# TOC フィールドに dirty="true" を付けておくと、Word で開いたときにページ番号つきで
# 自動更新される。更新されない環境でも、下の一覧がそのまま表示される。
$tocSection = (Heading 1 '目次' $true)
$fieldBegin = '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
              '<w:r><w:instrText xml:space="preserve"> TOC \o "1-3" \h \z \u </w:instrText></w:r>' +
              '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
for ($k = 0; $k -lt $tocList.Count; $k++) {
  $e = $tocList[$k]
  $inner = if ($k -eq 0) { $fieldBegin } else { '' }
  $tocSection += (TocLine $e.Level $e.Text $inner)
}
$tocSection += '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>' +
               '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

$sectPr = '<w:sectPr><w:footerReference w:type="default" r:id="rId6"/><w:pgSz w:w="11906" w:h="16838"/>' +
          '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
          '<w:cols w:space="720"/><w:docGrid w:linePitch="240"/></w:sectPr>'

# --- ひな形の document.xml を差し替える ------------------------------------
$tplPath = (Resolve-Path $Template).Path
$work    = Join-Path ([System.IO.Path]::GetTempPath()) ('docxbuild_' + [Guid]::NewGuid().ToString('N'))
[System.IO.Compression.ZipFile]::ExtractToDirectory($tplPath, $work)

$docPath = Join-Path $work 'word\document.xml'
$orig    = [System.IO.File]::ReadAllText($docPath, [System.Text.Encoding]::UTF8)
$header  = $orig.Substring(0, $orig.IndexOf('<w:body>') + '<w:body>'.Length)

$newXml = $header + $cover + $tocSection + $body.ToString() + $sectPr + '</w:body></w:document>'
[System.IO.File]::WriteAllText($docPath, $newXml, (New-Object System.Text.UTF8Encoding($false)))

$outPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path (Get-Location) $Output }
if (Test-Path $outPath) { Remove-Item -Force $outPath }

# ZipFile::CreateFromDirectory は .NET Framework ではエントリ名に "\" を書き込む。
# ZIP／OPC の規格はいずれも "/" と定めているため、自前で詰め直す。
# また [Content_Types].xml は先頭に置く（OPC の慣例）。
$zip = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $all   = Get-ChildItem -LiteralPath $work -Recurse -File
  $first = $all | Where-Object { $_.Name -eq '[Content_Types].xml' }
  $rest  = $all | Where-Object { $_.Name -ne '[Content_Types].xml' }
  foreach ($f in (@($first) + @($rest))) {
    if (-not $f) { continue }
    $rel = $f.FullName.Substring($work.Length).TrimStart('\','/') -replace '\\', '/'
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $dst = $entry.Open()
    $src = [System.IO.File]::OpenRead($f.FullName)
    try { $src.CopyTo($dst) } finally { $src.Dispose(); $dst.Dispose() }
  }
} finally { $zip.Dispose() }

Remove-Item -Recurse -Force $work

$size = (Get-Item $outPath).Length
Write-Output ("作成しました: {0}  ({1:N0} bytes)" -f $outPath, $size)
Write-Output ""
Write-Output "目次は TOC フィールドです。Word で開くとページ番号つきで自動更新されます。"
Write-Output "PDF が必要な場合は、Word で開いて［名前を付けて保存］→ PDF を選んでください"
Write-Output "（この操作で目次のページ番号も確定します）。"

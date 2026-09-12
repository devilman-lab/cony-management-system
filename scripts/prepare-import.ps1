<#
  外部データ取込の前処理
  ------------------------------------------------------------------
  受領した2種類のCSVを、PostgreSQL の \copy でそのまま読める形に整えます。

    1. OMS 受注CSV（例：OS_beautyjapan_20260901_170556.csv）
         Shift-JIS(CP932) → UTF-8 に変換します。中身は変更しません。

    2. Amazon 月次トランザクションレポート（例：2026AugMonthlyTransaction.csv）
         先頭にある説明文（9行）を取り除き、見出し行から始まるファイルにします。

    3. 販社の発注CSV（ビックカメラ／ラベルヴィ／白鳩／コネクト）
         文字コードを UTF-8 に揃え、列数と JAN の桁数を点検します。
         JAN が Excel 保存によって指数表記（4.57349E+12）に壊れている場合は警告します。

  使い方
    powershell -ExecutionPolicy Bypass -File scripts\prepare-import.ps1 `
      -OmsCsv    "..\要件\OS_beautyjapan_20260901_170556.csv" `
      -AmazonCsv "..\要件\2026AugMonthlyTransaction (1).csv" `
      -PartnerCsv "..\要件\追加\★ビックカメラ取り込み.csv","..\要件\追加\★白鳩取り込み.csv" `
      -OutDir    ".\work"

  出力
    <OutDir>\oms_orders_utf8.csv
    <OutDir>\amazon_transactions_utf8.csv
    <OutDir>\partner_<元のファイル名>_utf8.csv
#>
[CmdletBinding()]
param(
  [string]   $OmsCsv,
  [string]   $AmazonCsv,
  [string[]] $PartnerCsv,
  [string]   $OutDir = ".\work"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# --- 1. OMS 受注CSV：Shift-JIS → UTF-8 ------------------------------------
if ($OmsCsv) {
  if (-not (Test-Path $OmsCsv)) { throw "OMS CSV が見つかりません: $OmsCsv" }

  $cp932 = [System.Text.Encoding]::GetEncoding(932)
  $text  = $cp932.GetString([System.IO.File]::ReadAllBytes($OmsCsv))

  # 見出し行が想定どおりか確認する（列の並びが変わると取込がずれるため）
  $header = ($text -split "`r?`n")[0]
  $cols   = ($header -split ',').Count
  if ($cols -ne 63) {
    Write-Warning "OMS CSV の列数が $cols です（想定 63）。05-import-validation.sql の定義を見直してください。"
  }
  if ($header -notmatch '受注ルート') {
    Write-Warning "OMS CSV の1列目が「受注ルート」ではありません。文字コードの判定を確認してください。"
  }

  $dest = Join-Path $OutDir 'oms_orders_utf8.csv'
  [System.IO.File]::WriteAllText($dest, $text, $utf8NoBom)

  # 備考欄に改行を含む注文があるため、明細件数は物理行数と一致しない。
  $rows = ($text | ConvertFrom-Csv).Count
  Write-Output ("OMS 受注CSV    : {0} 列 / 明細 {1} 件  →  {2}" -f $cols, $rows, $dest)
}

# --- 2. Amazon レポート：先頭の説明文を除去 --------------------------------
if ($AmazonCsv) {
  if (-not (Test-Path $AmazonCsv)) { throw "Amazon CSV が見つかりません: $AmazonCsv" }

  $lines = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($AmazonCsv)) -split "`r?`n"

  # 見出し行（"日付/時間" から始まる行）を探す。行数は月によって変わりうる。
  $headerIndex = -1
  for ($i = 0; $i -lt [Math]::Min($lines.Count, 40); $i++) {
    if ($lines[$i] -match '^"?日付/時間"?,') { $headerIndex = $i; break }
  }
  if ($headerIndex -lt 0) { throw "Amazon CSV の見出し行（日付/時間）が見つかりません: $AmazonCsv" }

  $body = ($lines[$headerIndex..($lines.Count - 1)]) -join "`n"
  $dest = Join-Path $OutDir 'amazon_transactions_utf8.csv'
  [System.IO.File]::WriteAllText($dest, $body, $utf8NoBom)

  $cols = (($lines[$headerIndex] -split ',').Count)
  $rows = ($lines[($headerIndex + 1)..($lines.Count - 1)] | Where-Object { $_ -ne '' }).Count
  Write-Output ("Amazon レポート : {0} 列 / {1} 行（説明文 {2} 行を除去）  →  {3}" -f $cols, $rows, $headerIndex, $dest)
}

# --- 3. 販社の発注CSV：文字コードを揃え、列数とJANを点検 --------------------
if ($PartnerCsv) {
  # powershell.exe -File 経由で呼ぶと配列がカンマ区切りの1要素になるため、必要なら分解する
  $PartnerCsv = @($PartnerCsv | ForEach-Object {
    if ((Test-Path $_) -or ($_ -notmatch ',')) { $_ } else { $_ -split ',' }
  }) | Where-Object { $_ -ne '' }

  # 取込テンプレート（docs\03-seed-data.sql の登録内容と一致させること）
  $templates = @(
    @{ Match = 'ビックカメラ'; Code = 'BIC';        Columns = 36; JanIndex = 21; SkuKey = '商品コード' }
    @{ Match = 'ラベルヴィ';   Code = 'LABELLEVIE'; Columns = 26; JanIndex = 12; SkuKey = '商品品番'   }
    @{ Match = '白鳩';         Code = 'SHIRAHATO';  Columns = 29; JanIndex = 15; SkuKey = 'JANCD'      }
    @{ Match = 'コネクト';     Code = 'CONNECT';    Columns = 10; JanIndex = -1; SkuKey = '商品コード' }
  )

  foreach ($file in $PartnerCsv) {
    if (-not (Test-Path $file)) { throw "販社CSV が見つかりません: $file" }
    $leaf  = Split-Path $file -Leaf
    $bytes = [System.IO.File]::ReadAllBytes($file)

    # UTF-8 として解釈できれば UTF-8、できなければ Shift-JIS とみなす
    $isUtf8 = $false
    try {
      $strict = [System.Text.Encoding]::GetEncoding('utf-8',
                  [System.Text.EncoderFallback]::ExceptionFallback,
                  [System.Text.DecoderFallback]::ExceptionFallback)
      $null = $strict.GetString($bytes)
      $isUtf8 = $true
    } catch { $isUtf8 = $false }

    $text  = $(if ($isUtf8) { [System.Text.Encoding]::UTF8 } else { [System.Text.Encoding]::GetEncoding(932) }).GetString($bytes)
    $lines = ($text -split "`r?`n") | Where-Object { $_ -ne '' }

    $tpl = $templates | Where-Object { $leaf -like ('*' + $_.Match + '*') } | Select-Object -First 1
    $cols = ($lines[0] -split ',').Count
    $code = if ($tpl) { $tpl.Code } else { '（テンプレート未登録）' }

    Write-Output ("販社CSV [{0}] {1} : {2} 列 / 明細 {3} 件 / {4}" -f `
      $code, $leaf, $cols, ($lines.Count - 1), $(if ($isUtf8) { 'UTF-8' } else { 'Shift-JIS' }))

    if ($tpl) {
      if ($cols -ne $tpl.Columns) {
        Write-Warning ("  列数が {0} です（登録済みテンプレートは {1} 列）。書式が変わった可能性があります。" -f $cols, $tpl.Columns)
      }
      if ($tpl.JanIndex -ge 0) {
        # 引用符つきの列（"4,573,490,000,000.00" など）があるため、正式なCSV解析で取り出す
        $parsed = $text | ConvertFrom-Csv -Header (1..$cols | ForEach-Object { "c$_" })
        $jans   = $parsed | Select-Object -Skip 1 |
                  ForEach-Object { $_.("c" + ($tpl.JanIndex + 1)) }

        # 正常なJANは、空白と引用符を除いて13桁の数字ちょうど
        $valid  = @($jans | Where-Object { ($_ -replace '[\s"]', '') -match '^\d{13}$' })
        # 壊れ方は2通り確認されている
        #   指数表記   4.57349E+12      … Excel 保存
        #   桁区切り   4,573,490,000,000.00 … 上記を Google スプレッドシートに取り込んだもの
        # どちらも下位の桁が失われており、書式を戻しても復元できない
        $broken = @($jans | Where-Object {
                    ($_ -match 'E\+') -or ($_ -match '^[\d,]+\.\d+$') -or ($_ -match ',\d{3}') })

        if ($broken.Count -gt 0) {
          $form = if ($broken[0] -match 'E\+') { '指数表記' } else { '桁区切りの数値' }
          $msg  = "  JAN {0} 件中 {1} 件が{2}に壊れています（例 {3}）。元の13桁は復元できません。" -f `
                  $jans.Count, $broken.Count, $form, ($broken | Select-Object -First 1)
          if ($tpl.SkuKey -eq 'JANCD') {
            Write-Warning ($msg + " この販社は商品コード列がなくJANで引き当てるため、このままでは取り込めません。")
          } else {
            Write-Warning ($msg + " 商品コード（{0}）で引き当てるため取込は可能です。" -f $tpl.SkuKey)
          }
        } elseif ($valid.Count -eq $jans.Count) {
          Write-Output ("  JAN {0} 件すべて13桁で正常です。" -f $valid.Count)
        } else {
          Write-Warning ("  JAN {0} 件のうち 13桁でないものが {1} 件あります。" -f `
                         $jans.Count, ($jans.Count - $valid.Count))
        }
      }

      # 機種依存文字（№ ① ③ など）が変換で失われていないか
      $mojibake = ($text.ToCharArray() | Where-Object { $_ -eq [char]0xFFFD }).Count
      if ($mojibake -gt 0) {
        Write-Warning ("  変換できなかった文字が {0} 箇所あります（№ ① ③ などの機種依存文字）。" -f $mojibake)
      }
    }

    $dest = Join-Path $OutDir ('partner_' + [System.IO.Path]::GetFileNameWithoutExtension($leaf) + '_utf8.csv')
    [System.IO.File]::WriteAllText($dest, $text, $utf8NoBom)
  }
}

Write-Output ""
Write-Output "次の手順: psql で docs\05-import-validation.sql を実行してください。"

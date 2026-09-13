<#
  バックエンドの通し確認

  使い捨ての PostgreSQL を別ポートに立て、02→03→04 を流し、
  ビルドした API を起動して主要な経路を叩き、最後に片付ける。
  開発中の cony_dev には一切触れない。

    powershell -ExecutionPolicy Bypass -File scripts\smoke-backend.ps1

  前提: PostgreSQL 17 と Node が入っていること。
#>
[CmdletBinding()]
param(
  [int]$PgPort  = 55432,
  [int]$ApiPort = 3011,
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$PG   = 'C:\Program Files\PostgreSQL\17\bin'
$work = Join-Path $env:TEMP 'cony-smoke'
$data = Join-Path $work 'pgdata'
$pass = 'SmokeTest123456'

$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')
$env:PGCLIENTENCODING = 'UTF8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# psql は NOTICE も stderr に出す。PowerShell から直接呼ぶと、その1行ごとに
# NativeCommandError が作られて例外になってしまうため、cmd を挟んで受け取る。
function Invoke-Psql {
  param([string]$File, [string]$Command)
  $base = '"{0}\psql.exe" -h localhost -p {1} -U postgres -d cony_test -q -v ON_ERROR_STOP=1' -f $PG, $PgPort
  $line = if ($File) { '{0} -f "{1}" 2>&1' -f $base, $File } else { '{0} -c "{1}" 2>&1' -f $base, $Command }
  $out  = cmd /c $line
  [pscustomobject]@{ code = $LASTEXITCODE; text = ($out -join "`n") }
}

$script:ok = 0
$script:ng = 0
function Check([string]$label, [scriptblock]$body) {
  try {
    $r = & $body
    if ($r -eq $false) { $script:ng++; Write-Host ("  NG  " + $label) -ForegroundColor Red }
    else               { $script:ok++; Write-Host ("  OK  " + $label) -ForegroundColor Green }
  } catch {
    $script:ng++
    Write-Host ("  NG  " + $label + "  -> " + $_.Exception.Message) -ForegroundColor Red
  }
}
function StatusOf([scriptblock]$body) {
  try { & $body | Out-Null; return 200 } catch { return $_.Exception.Response.StatusCode.value__ }
}

# JSON の配列を取ってくる。
#   Invoke-RestMethod は配列を「1個のオブジェクト」として出すため、
#   @(Invoke-RestMethod ...) と書くと Object[1]{Object[20]} の入れ子になる。
#   いったん変数に受けてから @() で包むと、この入れ子にならない。
function GetList($url, $headers = $H) {
  $r = Invoke-RestMethod $url -Headers $headers
  ,(@($r))
}

# ファイルをそのままのバイト列で受け取る。
#   Invoke-WebRequest は Content-Type が text/* だと文字列に直してしまい、
#   しかも charset がないと ISO-8859-1 として読むため日本語が壊れる。
#   いったんファイルに落とせば、送られてきたバイト列をそのまま見られる。
function GetFileBytes($url, $headers = $H) {
  $tmp = Join-Path $env:TEMP ('cony-dl-' + [guid]::NewGuid().ToString('N'))
  Invoke-WebRequest $url -Headers $headers -UseBasicParsing -OutFile $tmp | Out-Null
  $bytes = [System.IO.File]::ReadAllBytes($tmp)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  ,$bytes
}

function Cleanup {
  $pidFile = Join-Path $work 'api.pid'
  if (Test-Path $pidFile) {
    $p = (Get-Content $pidFile -Raw).Trim()
    if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
  $pgPidFile = Join-Path $work 'pg.pid'
  if (Test-Path $pgPidFile) {
    $q = (Get-Content $pgPidFile -Raw).Trim()
    if ($q) { Stop-Process -Id $q -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 800
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}

Write-Host '=== 1. 使い捨てデータベースを用意 ===' -ForegroundColor Cyan
Cleanup
New-Item -ItemType Directory -Force -Path $data | Out-Null
& "$PG\initdb.exe" -D $data -U postgres -A trust -E UTF8 --locale=C | Out-Null
# pg_ctl はコンソールを掴んだまま返らないことがあるため、postgres を直接起動する
$pgProc = Start-Process -FilePath "$PG\postgres.exe" `
  -ArgumentList @('-D', "`"$data`"", '-p', "$PgPort", '-c', 'listen_addresses=localhost') `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput "$work\pg.log" -RedirectStandardError "$work\pg.err"
$pgProc.Id | Out-File (Join-Path $work 'pg.pid') -Encoding ascii
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Test-NetConnection -ComputerName localhost -Port $PgPort -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
}
cmd /c ('"{0}\createdb.exe" -h localhost -p {1} -U postgres cony_test 2>&1' -f $PG, $PgPort) | Out-Null

Write-Host '=== 2. スキーマと初期データ、受入テスト ===' -ForegroundColor Cyan
Check '02-schema.sql'     { (Invoke-Psql -File (Join-Path $root 'docs\02-schema.sql')).code -eq 0 }
Check '03-seed-data.sql'  { (Invoke-Psql -File (Join-Path $root 'docs\03-seed-data.sql')).code -eq 0 }
Check '07-verify-objects' {
  $r = Invoke-Psql -File (Join-Path $root 'docs\07-verify-objects.sql')
  $r.code -eq 0 -and $r.text -notmatch '★NG'
}
Check '04-schema-tests 全件合格' {
  $r = Invoke-Psql -File (Join-Path $root 'docs\04-schema-tests.sql')
  $r.code -eq 0 -and $r.text -match '全件合格'
}

Write-Host '=== 3. API を起動 ===' -ForegroundColor Cyan
Push-Location (Join-Path $root 'backend')
try {
  npm run build 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm run build に失敗しました' }

  $env:NODE_ENV            = 'development'
  $env:PORT                = "$ApiPort"
  $env:DATABASE_URL        = "postgres://postgres@localhost:$PgPort/cony_test"
  $env:DB_SCHEMA           = 'cony'
  $env:DB_SSL              = 'false'
  $env:JWT_SECRET          = 'smoke-test-secret-value-that-is-long-enough-0123456789'
  $env:JWT_EXPIRES_SECONDS = '28800'
  $env:CORS_ORIGINS        = 'http://localhost:3000'

  npx ts-node -r tsconfig-paths/register src/cli/set-user-password.ts admin $pass 2>&1 | Out-Null

  $proc = Start-Process -FilePath 'node' -ArgumentList 'dist\main.js' -PassThru -NoNewWindow `
            -RedirectStandardOutput "$work\api.log" -RedirectStandardError "$work\api.err"
  $proc.Id | Out-File (Join-Path $work 'api.pid') -Encoding ascii
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 600
    if ((Test-NetConnection -ComputerName localhost -Port $ApiPort -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
  }
} finally { Pop-Location }

$B = "http://localhost:$ApiPort/api"

Write-Host '=== 4. 認証まわり ===' -ForegroundColor Cyan
Check '生存確認'                       { (Invoke-RestMethod "$B/health").status -eq 'ok' }
Check '接続先の照合（テーブル69）'      { $h = Invoke-RestMethod "$B/health/db"; $h.status -eq 'ok' -and $h.tables -eq 69 }
Check '未ログインは 401'               { (StatusOf { Invoke-RestMethod "$B/masters/partners" }) -eq 401 }
Check 'パスワード相違は 401'           { (StatusOf { Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' -Body '{"login_id":"admin","password":"wrong"}' }) -eq 401 }
Check '入力不備は 400'                 { (StatusOf { Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' -Body '{"login_id":""}' }) -eq 400 }

$login = Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
           -Body (@{ login_id = 'admin'; password = $pass } | ConvertTo-Json)
$H = @{ Authorization = "Bearer $($login.access_token)" }
Check '管理者は権限151件（機能30×操作5＋機微項目1）' { @($login.user.permissions).Count -eq 151 }

Invoke-Psql -Command "insert into cony.users (login_id, name, password_hash, is_active) values ('norole','no-role user','x',true) on conflict (login_id) do nothing" | Out-Null
Push-Location (Join-Path $root 'backend')
npx ts-node -r tsconfig-paths/register src/cli/set-user-password.ts norole $pass 2>&1 | Out-Null
Pop-Location
$noRole = Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
            -Body (@{ login_id = 'norole'; password = $pass } | ConvertTo-Json)
$HN = @{ Authorization = "Bearer $($noRole.access_token)" }
Check '権限のない利用者は 403'         { (StatusOf { Invoke-RestMethod "$B/masters/partners" -Headers $HN }) -eq 403 }
Check '権限がなくても /auth/me は通る' { (Invoke-RestMethod "$B/auth/me" -Headers $HN).user.login_id -eq 'norole' }

Write-Host '=== 5. マスタと在庫 ===' -ForegroundColor Cyan
Check '取引先一覧'                     { (Invoke-RestMethod "$B/masters/partners" -Headers $H).total -ge 3 }
Check '取引先の絞り込み（得意先）'     { $c = Invoke-RestMethod "$B/masters/partners?role=customer" -Headers $H; $c.items.Count -eq $c.total }
Check '取引先の日本語検索'             { (Invoke-RestMethod "$B/masters/partners?q=テスト" -Headers $H).total -ge 1 }
Check 'ページング'                     { $p = Invoke-RestMethod "$B/masters/partners?limit=2&offset=0" -Headers $H; @($p.items).Count -le 2 }
Check '範囲外の limit は 400'          { (StatusOf { Invoke-RestMethod "$B/masters/partners?limit=999" -Headers $H }) -eq 400 }
Check '存在しないIDは 404'             { (StatusOf { Invoke-RestMethod "$B/masters/partners/999999" -Headers $H }) -eq 404 }
Check '商品一覧'                       { (Invoke-RestMethod "$B/masters/products" -Headers $H).total -ge 1 }
Check 'SKU を JAN で検索'              { (GetList "$B/masters/skus?q=4900000000011").Count -ge 1 }
Check '在庫表'                         { (Invoke-RestMethod "$B/inventory/stocks" -Headers $H).total -ge 1 }
Check '有効在庫＝実在庫−引当済' {
  $st = Invoke-RestMethod "$B/inventory/stocks" -Headers $H
  $bad = $st.items | Where-Object { [decimal]$_.qty_available -ne ([decimal]$_.qty_on_hand - [decimal]$_.qty_allocated) }
  @($bad).Count -eq 0
}
Check '管理者には原価が返る' {
  $r = Invoke-RestMethod "$B/masters/products" -Headers $H
  $r.items[0].PSObject.Properties.Name -contains 'cost_price'
}

Write-Host '=== 6. 閲覧者に見せる範囲 ===' -ForegroundColor Cyan
Invoke-Psql -Command "insert into cony.users (login_id, name, password_hash, is_active) values ('viewer1','viewer','x',true) on conflict (login_id) do nothing" | Out-Null
Invoke-Psql -Command "insert into cony.user_roles (user_id, role_id) select u.id, r.id from cony.users u, cony.roles r where u.login_id='viewer1' and r.code='VIEWER' on conflict do nothing" | Out-Null
Push-Location (Join-Path $root 'backend')
npx ts-node -r tsconfig-paths/register src/cli/set-user-password.ts viewer1 $pass 2>&1 | Out-Null
Pop-Location
$viewer = Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
            -Body (@{ login_id = 'viewer1'; password = $pass } | ConvertTo-Json)
$HV = @{ Authorization = "Bearer $($viewer.access_token)" }

Check '閲覧者は商品マスタを開ける'   { (Invoke-RestMethod "$B/masters/products" -Headers $HV).total -ge 1 }
Check '閲覧者に原価は返らない' {
  $r = Invoke-RestMethod "$B/masters/products" -Headers $HV
  -not ($r.items[0].PSObject.Properties.Name -contains 'cost_price')
}
Check '閲覧者は商品1件でも原価が返らない' {
  $r = Invoke-RestMethod "$B/masters/products" -Headers $HV
  $d = Invoke-RestMethod "$B/masters/products/$($r.items[0].id)" -Headers $HV
  -not ($d.PSObject.Properties.Name -contains 'cost_price')
}
Check '閲覧者は在庫表も見られる'     { (Invoke-RestMethod "$B/inventory/stocks" -Headers $HV).total -ge 1 }
Check '閲覧者は機微項目権限を持たない' { -not ($viewer.user.permissions -contains 'SENSITIVE:view') }

# ---------------------------------------------------------------------------
Write-Host '=== 7. 受注から出荷確定まで（在庫の動き） ===' -ForegroundColor Cyan

function StockOf([string]$skuCode) {
  $r = Invoke-RestMethod "$B/inventory/stocks?q=$skuCode" -Headers $H
  $row = $r.items | Where-Object { $_.sku_code -eq $skuCode } | Select-Object -First 1
  [pscustomobject]@{
    on_hand   = [decimal]$row.qty_on_hand
    allocated = [decimal]$row.qty_allocated
    available = [decimal]$row.qty_available
  }
}

$partner  = (Invoke-RestMethod "$B/masters/partners?q=P001" -Headers $H).items[0]
$dest     = (Invoke-RestMethod "$B/masters/partners/$($partner.id)/delivery-destinations" -Headers $H)[0]
$category = (Invoke-RestMethod "$B/masters/sales-categories" -Headers $H)[0]
$sku      = (Invoke-RestMethod "$B/masters/skus?q=FT1196-0306-100" -Headers $H)[0]
$setSku   = (Invoke-RestMethod "$B/masters/skus?q=FT1198-11606-200" -Headers $H)[0]
$today    = (Get-Date).ToString('yyyy-MM-dd')

# Windows PowerShell 5.1 は文字列のボディを ISO-8859-1 で送るため、日本語が化ける。
# UTF-8 のバイト列にしてから渡す。
function PostJson($url, $body) {
  $json  = $body | ConvertTo-Json -Depth 6
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Invoke-RestMethod $url -Method Post -Headers $H -ContentType 'application/json; charset=utf-8' -Body $bytes
}
function NewOrder($body) { PostJson "$B/orders" $body }

Check '卸の受注で納品先なしは 400' {
  (StatusOf {
    NewOrder @{ order_type='卸'; partner_id=$partner.id; sales_category_id=$category.id; order_date=$today
                lines=@(@{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='x'; qty='1'; unit_price='100' }) }
  }) -eq 400
}
Check '商品行でSKUなしは 400' {
  (StatusOf {
    NewOrder @{ order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
                sales_category_id=$category.id; order_date=$today
                lines=@(@{ line_no=1; line_type='商品'; item_name='x'; qty='1'; unit_price='100' }) }
  }) -eq 400
}

$before = StockOf 'FT1196-0306-100'
$order = NewOrder @{
  order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
  sales_category_id=$category.id; order_date=$today; ship_date=$today
  lines=@(
    @{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='滑らかシームレスエアーHOT'; qty='20'; unit_price='3500' }
    @{ line_no=2; line_type='送料'; item_name='送料'; qty='1'; unit_price='800' }
  )
}
Check '受注番号が採番される（SO+年月+連番）' { $order.order_no -match '^SO\d{6}\d{5}$' }
Check '受注登録では在庫が動かない' {
  $s = StockOf 'FT1196-0306-100'
  $s.on_hand -eq $before.on_hand -and $s.allocated -eq $before.allocated
}
Check '受注明細の金額が qty×単価' {
  $d = Invoke-RestMethod "$B/orders/$($order.id)" -Headers $H
  [decimal]($d.lines | Where-Object { $_.line_no -eq 1 }).amount -eq 70000
}
Check '送料行は引当対象にならない' {
  $d = Invoke-RestMethod "$B/orders/$($order.id)" -Headers $H
  ($d.lines | Where-Object { $_.line_no -eq 2 }).is_stock_target -eq $false
}

$instr = Invoke-RestMethod "$B/orders/$($order.id)/shipping-instruction" -Method Post -Headers $H
Check '出荷指示で引当済が増え、実在庫は動かない' {
  $s = StockOf 'FT1196-0306-100'
  $s.on_hand -eq $before.on_hand -and $s.allocated -eq ($before.allocated + 20) -and $s.available -eq ($before.available - 20)
}
Check '出荷指示番号は受注番号と同じ' { $instr.shipment_no -eq $order.order_no }
Check '受注の状態が出荷指示済になる' { (Invoke-RestMethod "$B/orders/$($order.id)" -Headers $H).status -eq '出荷指示済' }
Check '二重の出荷指示は 409' { (StatusOf { Invoke-RestMethod "$B/orders/$($order.id)/shipping-instruction" -Method Post -Headers $H }) -eq 409 }

Invoke-RestMethod "$B/orders/$($order.id)/shipping-instruction" -Method Delete -Headers $H | Out-Null
Check '引当解除で有効在庫が戻り、実在庫は不変' {
  $s = StockOf 'FT1196-0306-100'
  $s.on_hand -eq $before.on_hand -and $s.allocated -eq $before.allocated -and $s.available -eq $before.available
}
Check '解除後は未確定に戻る' { (Invoke-RestMethod "$B/orders/$($order.id)" -Headers $H).status -eq '未確定' }

$instr2 = Invoke-RestMethod "$B/orders/$($order.id)/shipping-instruction" -Method Post -Headers $H
$confirm = PostJson "$B/shipments/$($instr2.shipment_id)/confirm" @{ ship_date = $today }
Check '出荷確定で初めて実在庫が減る' {
  $s = StockOf 'FT1196-0306-100'
  $s.on_hand -eq ($before.on_hand - 20) -and $s.allocated -eq $before.allocated -and $s.available -eq ($before.available - 20)
}
Check '出荷明細が作られる'   { $confirm.lines -ge 1 }
Check '受注が出荷済になる'   { (Invoke-RestMethod "$B/orders/$($order.id)" -Headers $H).status -eq '出荷済' }
Check '出荷済は引当解除できない' { (StatusOf { Invoke-RestMethod "$B/orders/$($order.id)/shipping-instruction" -Method Delete -Headers $H }) -eq 409 }
Check '出荷済の二重確定は 409'   { (StatusOf { Invoke-RestMethod "$B/shipments/$($instr2.shipment_id)/confirm" -Method Post -Headers $H -ContentType 'application/json' -Body '{}' }) -eq 409 }

Write-Host '=== 8. セット商品・在庫不足・サンプル出荷 ===' -ForegroundColor Cyan
$compBefore = StockOf 'FT1198-0204-100'
$setOrder = NewOrder @{
  order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
  sales_category_id=$category.id; order_date=$today
  lines=@(@{ line_no=1; line_type='セット商品'; sku_id=$setSku.sku_id; item_name='2枚組'; qty='3'; unit_price='7000' })
}
Invoke-RestMethod "$B/orders/$($setOrder.id)/shipping-instruction" -Method Post -Headers $H | Out-Null
Check 'セットは構成品から引き落とす（3セット×2＝6）' {
  $s = StockOf 'FT1198-0204-100'
  $s.allocated -eq ($compBefore.allocated + 6) -and $s.on_hand -eq $compBefore.on_hand
}

$bigOrder = NewOrder @{
  order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
  sales_category_id=$category.id; order_date=$today
  lines=@(@{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='大量'; qty='99999'; unit_price='1' })
}
Check '在庫不足の出荷指示は 409' {
  (StatusOf { Invoke-RestMethod "$B/orders/$($bigOrder.id)/shipping-instruction" -Method Post -Headers $H }) -eq 409
}
Check '在庫不足でも在庫は動かない（途中で押さえたまま残らない）' {
  $s = StockOf 'FT1196-0306-100'
  $s.allocated -eq $before.allocated
}

$sample = NewOrder @{
  order_type='サンプル'; partner_id=$partner.id; sales_category_id=$category.id; order_date=$today
  direct_name='サンプル送付先'
  lines=@(@{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='サンプル品'; qty='1'; unit_price='0' })
}
Check 'サンプル出荷は売上計上しない' {
  (Invoke-RestMethod "$B/orders/$($sample.id)" -Headers $H).is_billable -eq $false
}
$sampleBefore = StockOf 'FT1196-0306-100'
Invoke-RestMethod "$B/orders/$($sample.id)/shipping-instruction" -Method Post -Headers $H | Out-Null
Check 'サンプル出荷でも在庫は押さえる' {
  (StockOf 'FT1196-0306-100').allocated -eq ($sampleBefore.allocated + 1)
}

Check '入出荷履歴に引当・解除・出荷が残る' {
  $m = Invoke-RestMethod "$B/inventory/stocks/movements?limit=200" -Headers $H
  $types = $m.items | ForEach-Object { $_.movement_type } | Sort-Object -Unique
  ($types -contains '引当') -and ($types -contains '引当解除') -and ($types -contains '出荷')
}
Check '入出荷履歴の種別で絞り込める' {
  $m = Invoke-RestMethod "$B/inventory/stocks/movements?movement_type=出荷" -Headers $H
  $m.total -ge 1 -and (@($m.items | Where-Object { $_.movement_type -ne '出荷' }).Count -eq 0)
}
Check '出荷指示済の受注は取り消せない' {
  (StatusOf { Invoke-RestMethod "$B/orders/$($setOrder.id)/cancel" -Method Post -Headers $H }) -eq 409
}
Check '未確定の受注は取り消せる' {
  (Invoke-RestMethod "$B/orders/$($bigOrder.id)/cancel" -Method Post -Headers $H).status -eq '取消'
}

# ---------------------------------------------------------------------------
Write-Host '=== 9. 入荷登録 ===' -ForegroundColor Cyan
$warehouse = (Invoke-RestMethod "$B/masters/warehouses" -Headers $H)[0]
$newSku    = (Invoke-RestMethod "$B/masters/skus?q=CS2420-0000-100" -Headers $H)[0]

$beforeReceipt = StockOf 'FT1196-0306-100'
$receipt = PostJson "$B/inventory/receipts" @{
  warehouse_id=$warehouse.id; planned_date=$today
  lines=@(
    @{ line_no=1; sku_id=$sku.sku_id;    qty='30' }
    @{ line_no=2; sku_id=$newSku.sku_id; qty='12' }   # 在庫表にまだ無い商品
  )
}
Check '入荷番号が採番される（RC+年月+連番）' { $receipt.receipt_no -match '^RC\d{6}\d{5}$' }
Check '入荷登録だけでは在庫が増えない' { (StockOf 'FT1196-0306-100').on_hand -eq $beforeReceipt.on_hand }

$received = PostJson "$B/inventory/receipts/$($receipt.id)/receive" @{ received_date = $today }
Check '入荷確定で実在庫が増える' { (StockOf 'FT1196-0306-100').on_hand -eq ($beforeReceipt.on_hand + 30) }
Check '在庫表に無い商品は入荷で自動的に現れる' {
  $s = Invoke-RestMethod "$B/inventory/stocks?q=CS2420-0000-100" -Headers $H
  $s.total -ge 1 -and [decimal]$s.items[0].qty_on_hand -eq 12
}
Check '二重の入荷確定は 409' {
  (StatusOf { PostJson "$B/inventory/receipts/$($receipt.id)/receive" @{} }) -eq 409
}
Check '入荷履歴が残る' {
  (Invoke-RestMethod "$B/inventory/stocks/movements?movement_type=入荷" -Headers $H).total -ge 2
}

Write-Host '=== 10. 返品と再生 ===' -ForegroundColor Cyan
$beforeReturn = StockOf 'FT1196-0306-100'
$ret = PostJson "$B/returns" @{
  return_type='販社返品'; partner_id=$partner.id; warehouse_id=$warehouse.id; return_date=$today
  lines=@(@{ line_no=1; sku_id=$sku.sku_id; qty='5'; unit_price='3500' })
}
Check '返品番号が採番される（RT+年月+連番）' { $ret.return_no -match '^RT\d{6}\d{5}$' }
Check '返品額が数量×単価で入る' {
  [decimal](Invoke-RestMethod "$B/returns/$($ret.id)" -Headers $H).return_amount -eq 17500
}
Check '受付だけでは在庫が動かない' { (StockOf 'FT1196-0306-100').on_hand -eq $beforeReturn.on_hand }

$retDetail = Invoke-RestMethod "$B/returns/$($ret.id)" -Headers $H
Check '良品＋不良が返品数を超えると 400' {
  (StatusOf {
    PostJson "$B/returns/$($ret.id)/inspect" @{ lines=@(@{ return_line_id=$retDetail.lines[0].id; good_qty='4'; defective_qty='4' }) }
  }) -eq 400
}
PostJson "$B/returns/$($ret.id)/inspect" @{ lines=@(@{ return_line_id=$retDetail.lines[0].id; good_qty='3'; defective_qty='2' }) } | Out-Null
Check '検品で良品3個が在庫に戻る' { (StockOf 'FT1196-0306-100').on_hand -eq ($beforeReturn.on_hand + 3) }
Check '不良2個は不良在庫に入る' {
  $s = Invoke-RestMethod "$B/inventory/stocks?q=FT1196-0306-100" -Headers $H
  $bad = $s.items | Where-Object { $_.quality_name -eq '不良' }
  @($bad).Count -eq 1 -and [decimal]$bad[0].qty_on_hand -eq 2
}
Check '検品済の返品は再検品できない' {
  (StatusOf { PostJson "$B/returns/$($ret.id)/inspect" @{ lines=@(@{ return_line_id=$retDetail.lines[0].id; good_qty='1'; defective_qty='0' }) } }) -eq 409
}

Write-Host '=== 11. 在庫調整 ===' -ForegroundColor Cyan
$beforeAdj = StockOf 'FT1196-0306-100'
$adj = PostJson "$B/inventory/adjustments" @{
  warehouse_id=$warehouse.id; adjustment_date=$today; reason_code='STOCKTAKE'; note='棚卸'
  lines=@(
    @{ line_no=1; sku_id=$sku.sku_id; qty='-4' }
    @{ line_no=2; sku_id=$sku.sku_id; qty='2'; from_quality='GOOD'; to_quality='DEFECTIVE' }
  )
}
Check '調整番号が採番される（AJ+年月+連番）' { $adj.adjustment_no -match '^AJ\d{6}\d{5}$' }
Check '減算と品質振替が実在庫に反映される（-4 と -2）' {
  (StockOf 'FT1196-0306-100').on_hand -eq ($beforeAdj.on_hand - 6)
}
Check '振替先の不良在庫が増える' {
  $s = Invoke-RestMethod "$B/inventory/stocks?q=FT1196-0306-100" -Headers $H
  $bad = $s.items | Where-Object { $_.quality_name -eq '不良' }
  [decimal]$bad[0].qty_on_hand -eq 4
}
Check '増減 0 の明細は 400' {
  (StatusOf {
    PostJson "$B/inventory/adjustments" @{ warehouse_id=$warehouse.id; adjustment_date=$today; reason_code='STOCKTAKE'
      lines=@(@{ line_no=1; sku_id=$sku.sku_id; qty='0' }) }
  }) -eq 400
}
Check '未登録の調整理由は 400' {
  (StatusOf {
    PostJson "$B/inventory/adjustments" @{ warehouse_id=$warehouse.id; adjustment_date=$today; reason_code='NOPE'
      lines=@(@{ line_no=1; sku_id=$sku.sku_id; qty='1' }) }
  }) -eq 400
}
Check '押さえてある分を下回る減算は 400' {
  $s = StockOf 'FT1196-0306-100'
  (StatusOf {
    PostJson "$B/inventory/adjustments" @{ warehouse_id=$warehouse.id; adjustment_date=$today; reason_code='LOSS'
      lines=@(@{ line_no=1; sku_id=$sku.sku_id; qty=('-' + [string]($s.on_hand + 1)) }) }
  }) -eq 400
}
Check '調整一覧に出る' { (Invoke-RestMethod "$B/inventory/adjustments" -Headers $H).total -ge 1 }

Write-Host '=== 12. 取引先別確保数 ===' -ForegroundColor Cyan
$resv = PostJson "$B/inventory/reservations" @{
  partner_id=$partner.id; sales_category_id=$category.id; sku_id=$sku.sku_id
  period_from=$today; period_to=$today; reserved_qty='40'
}
Check '確保数を登録できる' { [decimal]$resv.reserved_qty -eq 40 }
Check '残数が計算される' {
  $r = Invoke-RestMethod "$B/inventory/reservations?on=$today" -Headers $H
  [decimal]$r.items[0].remaining_qty -eq 40
}
Check '同じ取引先・カテゴリー・商品・期間の重複は 500 で弾かれる' {
  (StatusOf {
    PostJson "$B/inventory/reservations" @{ partner_id=$partner.id; sales_category_id=$category.id; sku_id=$sku.sku_id
      period_from=$today; period_to=$today; reserved_qty='10' }
  }) -ge 400
}
Check '期間が逆転していると 400 と日本語で返る' {
  try {
    PostJson "$B/inventory/reservations" @{ partner_id=$partner.id; sales_category_id=$category.id; sku_id=$newSku.sku_id
      period_from='2026-12-31'; period_to='2026-01-01'; reserved_qty='1' } | Out-Null
    $false
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    $code -eq 400 -and $_.ErrorDetails.Message -match '開始日が終了日より後'
  }
}

# ---------------------------------------------------------------------------
Write-Host '=== 13. 締め処理と請求書 ===' -ForegroundColor Cyan
$month = (Get-Date).ToString('yyyy-MM')

$closing = PostJson "$B/billing/closings" @{ target_month=$month; partner_id=$partner.id }
Check '締め処理が動く' { $closing.closed -eq 1 }
$inv = $closing.invoices[0]
Check '請求番号が採番される（IV+年月+連番）' { $inv.invoice_no -match '^IV\d{6}\d{4}$' }
Check '締め期間が月末締めで1日〜末日になる' {
  $inv.period_from -eq ($month + '-01') -and $inv.period_to -match "^$month-\d{2}$"
}
Check '出荷済みの金額が集計される（20×3500＝70,000）' { [decimal]$inv.shipment_amount -eq 70000 }
Check '返品がマイナスで反映される（5×3500＝17,500）' { [decimal]$inv.return_amount -eq 17500 }

$invoiceId = ($inv.id)
$invDetail = Invoke-RestMethod "$B/billing/invoices/$invoiceId" -Headers $H
Check '税率別内訳が作られる' { @($invDetail.tax_summaries).Count -ge 1 }
Check '消費税が税率別に切り捨てで計算される' {
  $t = $invDetail.tax_summaries | Where-Object { [decimal]$_.tax_rate -eq 10 } | Select-Object -First 1
  $expected = [Math]::Floor([decimal]$t.taxable_base * 0.10)
  [decimal]$t.tax_amount -eq $expected
}
Check '請求額＝明細合計＋消費税' {
  $lineSum = ($invDetail.lines | ForEach-Object { [decimal]$_.amount } | Measure-Object -Sum).Sum
  $taxSum  = ($invDetail.tax_summaries | ForEach-Object { [decimal]$_.tax_amount } | Measure-Object -Sum).Sum
  [decimal]$invDetail.current_invoice_amount -eq ($lineSum + $taxSum)
}
Check 'サンプル出荷は請求に入らない' {
  # サンプルは出荷確定していないうえ is_billable=false。出荷明細の合計と一致すること
  [decimal]$invDetail.shipment_amount -eq 70000
}
Check '売掛残高一覧に12項目が並ぶ' {
  $ar = Invoke-RestMethod "$B/billing/ar-balances?partner_id=$($partner.id)" -Headers $H
  $names = $ar.items[0].PSObject.Properties.Name
  ($names -contains 'prev_invoice_balance') -and ($names -contains 'carryover_balance') -and
  ($names -contains 'unposted_10') -and ($names -contains 'adjust_8') -and ($names -contains 'current_balance')
}

Write-Host '=== 14. 入金と消込 ===' -ForegroundColor Cyan
$receipt2 = PostJson "$B/billing/cash-receipts" @{
  partner_id=$partner.id; receipt_date=$today; amount='50000'; invoice_id=$invoiceId; applied_amount='50000'
}
Check '入金を請求に消し込める' { [decimal]$receipt2.applied_amount -eq 50000 }
Check '未消込額が計算される' {
  $r = PostJson "$B/billing/cash-receipts" @{ partner_id=$partner.id; receipt_date=$today; amount='10000'; applied_amount='0' }
  $list = Invoke-RestMethod "$B/billing/cash-receipts?partner_id=$($partner.id)" -Headers $H
  [decimal]($list.items | Where-Object { $_.id -eq $r.id } | Select-Object -First 1).unapplied_amount -eq 10000
}
Check '消込額が入金額を超えると 400' {
  (StatusOf { PostJson "$B/billing/cash-receipts" @{ partner_id=$partner.id; receipt_date=$today; amount='100'; applied_amount='200' } }) -eq 400
}
Check '他社の請求には消し込めない' {
  $other = (Invoke-RestMethod "$B/masters/partners?q=AMZN" -Headers $H).items[0]
  (StatusOf { PostJson "$B/billing/cash-receipts" @{ partner_id=$other.id; receipt_date=$today; amount='100'; invoice_id=$invoiceId } }) -eq 400
}

Check '発行できる' { (PostJson "$B/billing/invoices/$invoiceId/issue" @{}).status -eq '発行済' }
Check '発行済は二重発行できない' { (StatusOf { PostJson "$B/billing/invoices/$invoiceId/issue" @{} }) -eq 409 }
Check '発行済は締め直せない' {
  (StatusOf { PostJson "$B/billing/closings" @{ target_month=$month; partner_id=$partner.id } }) -eq 409
}

Write-Host '=== 15. ロイヤリティ計算 ===' -ForegroundColor Cyan
# 04 のテストデータで、支払先LIC1・ブランドLXに 5%、販売先P002 は対象外の規定が入っている
$royalty = PostJson "$B/billing/royalties/calculate" @{ target_month=$month }
Check 'ロイヤリティ計算が動く' { $royalty.payees -ge 1 }
$calc = $royalty.calculations[0]
Check '計算のもとになった金額が入る' { [decimal]$calc.total_base_amount -ne 0 }
Check '出荷金額×5%で計算される' {
  # 出荷 70,000 − 返品 17,500 ＝ 52,500 に 5% ＝ 2,625
  [decimal]$calc.total_base_amount -eq 52500 -and [decimal]$calc.total_amount -eq 2625
}
$calcDetail = Invoke-RestMethod "$B/billing/royalties/$($calc.id)" -Headers $H
Check '販売先別の内訳が出る' { @($calcDetail.by_customer).Count -ge 1 }
Check '返品がマイナス行として入る' {
  @($calcDetail.lines | Where-Object { [decimal]$_.royalty_amount -lt 0 }).Count -ge 1
}
Check 'どの規定が当たったかが残る' {
  @($calcDetail.lines | Where-Object { $_.rate -ne $null }).Count -ge 1
}
Check '確定できる' { (PostJson "$B/billing/royalties/$($calc.id)/confirm" @{}).status -eq '確定' }
Check '確定後は再計算できない' {
  (StatusOf { PostJson "$B/billing/royalties/calculate" @{ target_month=$month } }) -eq 409
}

# ---------------------------------------------------------------------------
Write-Host '=== 16. 仕入・経費と買掛 ===' -ForegroundColor Cyan
$supplier = (Invoke-RestMethod "$B/masters/partners?role=supplier" -Headers $H).items |
              Where-Object { $_.partner_code -eq 'S001' } | Select-Object -First 1
$prod = (Invoke-RestMethod "$B/masters/products" -Headers $H).items[0]

$purchase = PostJson "$B/purchases" @{
  division='仕入'; supplier_partner_id=$supplier.id; purchase_date=$today
  lines=@(@{ line_no=1; item_name='生地'; qty='100'; unit_cost='250' })
}
Check '仕入番号が採番される（PU+年月+連番）' { $purchase.purchase_no -match '^PU\d{6}\d{5}$' }
Check '仕入合計が数量×単価' { [decimal]$purchase.total_amount -eq 25000 }

$expense = PostJson "$B/purchases" @{
  division='経費'; supplier_partner_id=$supplier.id; purchase_date=$today
  lines=@(
    @{ line_no=1; item_name='撮影費'; qty='1'; unit_cost='80000'; target_product_id=$prod.id }
    @{ line_no=2; item_name='広告費'; qty='1'; unit_cost='120000'; target_product_id=$prod.id }
  )
}
Check '経費を商品（品番）単位で登録できる' { [decimal]$expense.total_amount -eq 200000 }
Check '経費の明細に品番が残る' {
  $d = Invoke-RestMethod "$B/purchases/$($expense.id)" -Headers $H
  $d.lines[0].target_product_code -eq $prod.product_code
}
Check '商品別の経費集計が出る' {
  $agg = Invoke-RestMethod "$B/purchases/expense-by-product" -Headers $H
  $row = $agg | Where-Object { $_.product_code -eq $prod.product_code } | Select-Object -First 1
  [decimal]$row.amount -eq 200000
}
Check '区分で絞り込める' {
  (Invoke-RestMethod "$B/purchases?division=経費" -Headers $H).total -ge 1
}

PostJson "$B/payments" @{ partner_id=$supplier.id; payment_date=$today; amount='25000'; purchase_id=$purchase.id } | Out-Null
Check '買掛残高一覧が出る' {
  $ap = Invoke-RestMethod "$B/ap-balances?from=$month-01&to=$today" -Headers $H
  $row = $ap | Where-Object { $_.partner_code -eq 'S001' } | Select-Object -First 1
  [decimal]$row.purchase_amount -eq 225000 -and [decimal]$row.payment_amount -eq 25000
}
Check '他社の仕入には消し込めない' {
  (StatusOf { PostJson "$B/payments" @{ partner_id=$partner.id; payment_date=$today; amount='100'; purchase_id=$purchase.id } }) -eq 400
}

Write-Host '=== 17. 入出金処理 ===' -ForegroundColor Cyan
$cash = PostJson "$B/cash-transactions" @{
  division='出金'; target_month=$month; transaction_date=$today; partner_id=$supplier.id
  transfer_amount='100000'; bill_amount1='50000'; bill_due_date1=$today
  offset_amount='20000'; check_amount='10000'; collection_amount='5000'
  overseas_usd='30000'; overseas_cny='15000'; cash_amount='2000'
}
Check '入出金番号が採番される（8桁）' { $cash.cash_transaction_no -match '^\d{8}$' }
Check '手形・相殺・小切手・集金・海外送金の合計が出る' {
  # 100000+50000+20000+10000+5000+30000+15000+2000 = 232,000
  [decimal]$cash.amount -eq 232000
}
Check '入出金一覧に内訳が並ぶ' {
  $list = Invoke-RestMethod "$B/cash-transactions?target_month=$month" -Headers $H
  $row = $list | Where-Object { $_.id -eq $cash.id } | Select-Object -First 1
  [decimal]$row.bill_amount1 -eq 50000 -and [decimal]$row.overseas_cny -eq 15000
}

# ---------------------------------------------------------------------------
Write-Host '=== 18. 販社CSVの取り込み（貴社から受領した実ファイル） ===' -ForegroundColor Cyan
$csvDir = Join-Path (Split-Path $root -Parent) '要件\追加'

function ImportCsv([string]$templateCode, [string]$fileName, [bool]$dryRun) {
  $path = Join-Path $csvDir $fileName
  $b64  = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path))
  PostJson "$B/imports/partner-orders" @{
    template_code = $templateCode; file_name = $fileName; content_base64 = $b64; dry_run = $dryRun
  }
}

if (-not (Test-Path $csvDir)) {
  Write-Host '  -- 実CSVが見つからないため、この節はとばします' -ForegroundColor Yellow
} else {
  # まずは読めるかどうかだけ（登録しない）
  $dry = ImportCsv 'SHIRAHATO' '★白鳩取り込み.csv' $true
  Check '白鳩CSVを読める（Shift-JIS）' { $dry.total_rows -ge 1 }
  Check '白鳩は全行読める（JANの末尾空白を吸収）' { $dry.error_rows -eq 0 }
  Check '読み取りだけでは登録されない' { $dry.created_orders -eq 0 }

  $dryBic = ImportCsv 'BIC' '★ビックカメラ取り込み.csv' $true
  Check 'ビックカメラCSVを読める（36列）' {
    if ($dryBic.error_rows -gt 0) { Write-Host ('      理由: ' + $dryBic.errors[0].reason) -ForegroundColor DarkYellow }
    $dryBic.total_rows -ge 1 -and $dryBic.error_rows -eq 0
  }
  Check 'ビックカメラは壊れたJANを警告にとどめ、取込は続く' {
    @($dryBic.warnings | Where-Object { $_ -match '指数表記' }).Count -ge 1
  }
  $dryLab = ImportCsv 'LABELLEVIE' '★ラベルヴィ取り込み.csv' $true
  Check 'ラベルヴィCSVを読める（26列）' {
    if ($dryLab.error_rows -gt 0) { Write-Host ('      理由: ' + $dryLab.errors[0].reason) -ForegroundColor DarkYellow }
    $dryLab.total_rows -ge 1 -and $dryLab.error_rows -eq 0
  }
  $dryCon = ImportCsv 'CONNECT' 'コネクト_インポート.csv' $true
  Check 'コネクトCSVを読める（10列・UTF-8）' {
    if ($dryCon.error_rows -gt 0) { Write-Host ('      理由: ' + $dryCon.errors[0].reason) -ForegroundColor DarkYellow }
    $dryCon.total_rows -ge 1 -and $dryCon.error_rows -eq 0
  }
  Check '白鳩はJANで引き当てるため警告が出ない' { @($dry.warnings).Count -eq 0 }

  Check '列数の違うテンプレートを当てると 400' {
    (StatusOf { ImportCsv 'CONNECT' '★白鳩取り込み.csv' $true }) -eq 400
  }
  Check '未登録のテンプレートは 404' {
    (StatusOf { ImportCsv 'NOPE' '★白鳩取り込み.csv' $true }) -eq 404
  }

  # マスタ未登録のまま取り込むと「要確認」で残る
  $real = ImportCsv 'SHIRAHATO' '★白鳩取り込み.csv' $false
  Check 'マスタ未登録でも元データは残る' { $real.total_rows -ge 1 }
  Check '取引先が無い分は要確認になる' {
    $statuses = @($real.orders | ForEach-Object { $_.status })
    if (@($statuses | Where-Object { $_ -match '要確認' }).Count -eq 0) {
      Write-Host ('      実際の状態: ' + ($statuses -join ' / ')) -ForegroundColor DarkYellow
    }
    @($statuses | Where-Object { $_ -match '要確認' }).Count -ge 1
  }
  Check '要確認の一覧に理由が出る' {
    $p = Invoke-RestMethod "$B/imports/pending" -Headers $H
    $p.items.Count -ge 1 -and $p.items[0].error_message -match 'ありません'
  }
  Check '取込履歴が残る' {
    $b = Invoke-RestMethod "$B/imports/batches?import_type=PARTNER_ORDER" -Headers $H
    $b.total -ge 1 -and $b.items[0].file_name -eq '★白鳩取り込み.csv'
  }
  Check '同じファイルを2回取り込んでも二重にならない' {
    $again = ImportCsv 'SHIRAHATO' '★白鳩取り込み.csv' $false
    $again.skipped_orders -ge 1 -and $again.created_orders -eq 0
  }
}

# ---------------------------------------------------------------------------
Write-Host '=== 19. 通販（OMS）受注CSVの取り込み ===' -ForegroundColor Cyan
$omsPath = Join-Path (Split-Path $root -Parent) '要件\OS_beautyjapan_20260901_170556.csv'

if (-not (Test-Path $omsPath)) {
  Write-Host '  -- 実CSVが見つからないため、この節はとばします' -ForegroundColor Yellow
} else {
  function ImportOms([bool]$dryRun) {
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($omsPath))
    PostJson "$B/imports/oms-orders" @{
      file_name = 'OS_beautyjapan_20260901_170556.csv'; content_base64 = $b64; dry_run = $dryRun
    }
  }

  $omsDry = ImportOms $true
  Check '通販CSVを読める（63列・Shift-JIS）' { $omsDry.total_lines -ge 1 }
  Check '明細203件・受注77件として読める' {
    if ($omsDry.total_lines -ne 203 -or $omsDry.orders -ne 77) {
      Write-Host ('      実測: 明細 ' + $omsDry.total_lines + ' 件 / 受注 ' + $omsDry.orders + ' 件') -ForegroundColor DarkYellow
    }
    $omsDry.total_lines -eq 203 -and $omsDry.orders -eq 77
  }
  Check '商品種別がすべて設計の許容値に収まる' {
    if (@($omsDry.warnings).Count -gt 0) { Write-Host ('      ' + $omsDry.warnings[0]) -ForegroundColor DarkYellow }
    @($omsDry.warnings).Count -eq 0
  }
  Check '受注ルート別の件数が出る' {
    ($omsDry.channels.PSObject.Properties | Measure-Object).Count -ge 1
  }
  Check '商品種別の内訳が出る（商品・セット商品・内訳商品・送料・非商品）' {
    $names = $omsDry.line_types.PSObject.Properties.Name
    ($names -contains '商品') -and ($names -contains '送料')
  }

  $oms = ImportOms $false
  Check '取り込むと受注として登録される' { $oms.created_orders -ge 1 }
  Check '出荷済みデータとして取り込まれる' {
    $o = Invoke-RestMethod "$B/orders?order_type=通販&status=出荷済" -Headers $H
    $o.total -ge 1
  }
  Check 'セット商品と内訳商品の親子が復元される' {
    $o = Invoke-RestMethod "$B/orders?order_type=通販&limit=200" -Headers $H
    $found = $false
    foreach ($row in $o.items) {
      $d = Invoke-RestMethod "$B/orders/$($row.id)" -Headers $H
      $child = $d.lines | Where-Object { $_.line_type -eq '内訳商品' -and $_.parent_line_no -ne $null } | Select-Object -First 1
      if ($child) { $found = $true; break }
    }
    $found
  }
  Check '送料・非商品の行は引当対象にならない' {
    $o = Invoke-RestMethod "$B/orders?order_type=通販&limit=200" -Headers $H
    $bad = 0
    foreach ($row in $o.items | Select-Object -First 30) {
      $d = Invoke-RestMethod "$B/orders/$($row.id)" -Headers $H
      $bad += @($d.lines | Where-Object { $_.line_type -in @('送料','非商品','セット商品') -and $_.is_stock_target -eq $true }).Count
    }
    $bad -eq 0
  }
  Check '同じCSVを再取込しても件数が増えない' {
    $before = (Invoke-RestMethod "$B/orders?order_type=通販&limit=1" -Headers $H).total
    $again  = ImportOms $false
    $after  = (Invoke-RestMethod "$B/orders?order_type=通販&limit=1" -Headers $H).total
    $again.skipped_orders -ge 1 -and $before -eq $after
  }
  Check '取込履歴に通販分が残る' {
    (Invoke-RestMethod "$B/imports/batches?import_type=OMS_ORDER" -Headers $H).total -ge 1
  }
}

# ---------------------------------------------------------------------------
Write-Host '=== 20. Amazon 決済レポートの取り込み ===' -ForegroundColor Cyan
$amzPath = Join-Path (Split-Path $root -Parent) '要件\2026AugMonthlyTransaction (1).csv'

if (-not (Test-Path $amzPath)) {
  Write-Host '  -- 実CSVが見つからないため、この節はとばします' -ForegroundColor Yellow
} else {
  function ImportAmazon([bool]$dryRun) {
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($amzPath))
    PostJson "$B/imports/amazon-transactions" @{
      file_name = '2026AugMonthlyTransaction.csv'; content_base64 = $b64; encoding = 'UTF8'; dry_run = $dryRun
    }
  }

  $amzDry = ImportAmazon $true
  Check '説明文の行数に関わらず見出し行を見つける' { $amzDry.header_row -eq 10 }
  Check '1,142行として読める' {
    if ($amzDry.total_rows -ne 1142) { Write-Host ('      実測: ' + $amzDry.total_rows + ' 行') -ForegroundColor DarkYellow }
    $amzDry.total_rows -eq 1142
  }
  Check 'トランザクションの種類が7種に分かれる' {
    ($amzDry.transaction_types.PSObject.Properties | Measure-Object).Count -eq 7
  }
  Check '種類ごとの振り分け先が決まっている' {
    if (@($amzDry.warnings).Count -gt 0) { Write-Host ('      ' + $amzDry.warnings[0]) -ForegroundColor DarkYellow }
    @($amzDry.warnings).Count -eq 0
  }
  Check '合計金額が 593,511 円' {
    if ([decimal]$amzDry.total_amount -ne 593511) { Write-Host ('      実測: ' + $amzDry.total_amount) -ForegroundColor DarkYellow }
    [decimal]$amzDry.total_amount -eq 593511
  }
  Check 'Amazon専用SKUの読み替え状況が分かる' {
    # 04 のテストデータで TO-GXZN-60W8 → CS2420-0000-100 を登録してある
    @($amzDry.unresolved_skus) -notcontains 'TO-GXZN-60W8'
  }

  $amz = ImportAmazon $false
  Check '取り込むと登録される' { $amz.inserted -ge 1000 }
  Check '種類ごとの集計が出る' {
    $s = Invoke-RestMethod "$B/analytics/amazon-summary" -Headers $H
    @($s.by_transaction_type).Count -ge 5
  }
  Check '注文の行が自社SKUに読み替わっている' {
    $s = Invoke-RestMethod "$B/analytics/amazon-summary" -Headers $H
    $row = $s.by_sku | Where-Object { $_.amazon_sku -eq 'TO-GXZN-60W8' } | Select-Object -First 1
    $row.sku_code -eq 'CS2420-0000-100'
  }
  Check '取込履歴にAmazon分が残る' {
    (Invoke-RestMethod "$B/imports/batches?import_type=AMAZON_TRANSACTION" -Headers $H).total -ge 1
  }
}

# ---------------------------------------------------------------------------
Write-Host '=== 21. 販売実績と汎用クエリ集計 ===' -ForegroundColor Cyan
Check '選べる軸と指標が返る' {
  $o = Invoke-RestMethod "$B/analytics/options" -Headers $H
  (@($o.dimensions) -contains '取引先') -and (@($o.measures) -contains '金額')
}
Check '取引先×商品で金額と数量を集計できる' {
  $r = PostJson "$B/analytics/sales" @{
    from = "$month-01"; to = $today; dimensions = @('取引先','商品'); measures = @('金額','数量')
  }
  @($r.rows).Count -ge 1
}
Check '月別の集計が出る' {
  $r = PostJson "$B/analytics/sales" @{
    from = "$month-01"; to = $today; dimensions = @('月'); measures = @('金額','件数')
  }
  @($r.rows).Count -ge 1
}
Check '軸を4つ以上にすると 400' {
  (StatusOf {
    PostJson "$B/analytics/sales" @{ from = "$month-01"; to = $today
      dimensions = @('月','取引先','商品','SKU'); measures = @('金額') }
  }) -eq 400
}
Check '一覧にない軸を指定すると 400' {
  (StatusOf {
    PostJson "$B/analytics/sales" @{ from = "$month-01"; to = $today
      dimensions = @('DROP TABLE'); measures = @('金額') }
  }) -eq 400
}
Check '集計条件を保存して呼び戻せる' {
  $saved = PostJson "$B/analytics/saved-queries" @{
    name = '取引先別の月次売上'; target = 'sales'; share_scope = 'shared'
    conditions = @{ dimensions = @('月','取引先'); measures = @('金額') }
  }
  $list = Invoke-RestMethod "$B/analytics/saved-queries" -Headers $H
  @($list | Where-Object { $_.id -eq $saved.id }).Count -eq 1
}

# ---------------------------------------------------------------------------
Write-Host '=== 22. マスタの登録・更新 ===' -ForegroundColor Cyan
function PatchJson($url, $body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6))
  Invoke-RestMethod $url -Method Patch -Headers $H -ContentType 'application/json; charset=utf-8' -Body $bytes
}

# 分類マスタ（10種を同じ経路で扱う）
$brand = PostJson "$B/masters/simple/brands" @{ code='NEWBRAND'; name='新ブランド'; sort_order=90 }
Check '分類マスタを登録できる（ブランド）' { $brand.code -eq 'NEWBRAND' }
Check '分類マスタを更新できる' {
  (PatchJson "$B/masters/simple/brands/$($brand.id)" @{ name='新ブランド（改）' }).name -eq '新ブランド（改）'
}
Check '分類マスタを無効にできる（物理削除しない）' {
  (PostJson "$B/masters/simple/brands/$($brand.id)/deactivate" @{}).is_active -eq $false
}
Check '無効にしたものは一覧から外れる' {
  $l = Invoke-RestMethod "$B/masters/simple/brands" -Headers $H
  @($l.items | Where-Object { $_.id -eq $brand.id }).Count -eq 0
}
Check '無効なものも含めて見られる' {
  $l = Invoke-RestMethod "$B/masters/simple/brands?include_inactive=true" -Headers $H
  @($l.items | Where-Object { $_.id -eq $brand.id }).Count -eq 1
}
Check '存在しない種類を指定すると 404' {
  (StatusOf { Invoke-RestMethod "$B/masters/simple/nosuch" -Headers $H }) -eq 404
}
Check 'カラー・サイズ・媒体なども同じ経路で登録できる' {
  $c = PostJson "$B/masters/simple/colors" @{ code='99'; name='テスト色' }
  $s = PostJson "$B/masters/simple/sizes"  @{ code='99'; name='テストサイズ' }
  $m = PostJson "$B/masters/simple/media"  @{ code='NET'; name='ネット' }
  $c.id -gt 0 -and $s.id -gt 0 -and $m.id -gt 0
}

# 取引先・納品先
$newPartner = PostJson "$B/masters/partners" @{
  partner_code='T900'; name1='新規取引先'; is_customer=$true; closing_day=20
  default_trade_type='買取'; postal_code='1000001'; tel='03-0000-0000'
}
Check '取引先を登録できる' { $newPartner.partner_code -eq 'T900' }
Check '締め日が20日なら締め期間は前月21日〜当月20日' {
  $r = PostJson "$B/billing/closings" @{ target_month=$month; partner_id=$newPartner.id }
  $r.invoices[0].period_to -match "^$month-20$"
}
Check '取引先を更新できる' {
  (PatchJson "$B/masters/partners/$($newPartner.id)" @{ short_name='新規' }).short_name -eq '新規'
}
Check '得意先でも仕入先でもない取引先は 400' {
  (StatusOf { PostJson "$B/masters/partners" @{ partner_code='T901'; name1='役割なし'; is_customer=$false; is_supplier=$false } }) -eq 400
}
Check '同じ取引先コードは 409' {
  (StatusOf { PostJson "$B/masters/partners" @{ partner_code='T900'; name1='重複'; is_customer=$true } }) -eq 409
}
$newDest = PostJson "$B/masters/delivery-destinations" @{
  partner_id=$newPartner.id; delivery_code='T900-01'; name='新規納品先'; default_warehouse_id=$warehouse.id
}
Check '納品先を登録できる' { $newDest.delivery_code -eq 'T900-01' }

# 商品・SKU・セット
$newProduct = PostJson "$B/masters/products" @{
  product_code='TEST-P1'; product_name='テスト商品'; cost_price='500'; tax_rate='10.00'
}
Check '商品を登録できる' { $newProduct.product_code -eq 'TEST-P1' }
$newSku1 = PostJson "$B/masters/skus" @{ product_id=$newProduct.id; sku_code='TEST-P1-0101-100'; jan='4901234567894' }
$newSku2 = PostJson "$B/masters/skus" @{ product_id=$newProduct.id; sku_code='TEST-P1-0102-100' }
Check 'SKUを登録できる' { $newSku1.sku_code -eq 'TEST-P1-0101-100' }
Check 'JANが13桁でないと 400' {
  (StatusOf { PostJson "$B/masters/skus" @{ product_id=$newProduct.id; sku_code='TEST-BAD'; jan='123' } }) -eq 400
}
$setProduct = PostJson "$B/masters/products" @{ product_code='TEST-SET'; product_name='テストセット'; is_set=$true }
$setSku2 = PostJson "$B/masters/skus" @{ product_id=$setProduct.id; sku_code='TEST-SET-0000-200' }
$newSet = PostJson "$B/masters/sets" @{
  sku_id=$setSku2.id
  components=@(@{ component_sku_id=$newSku1.id; qty='2' }, @{ component_sku_id=$newSku2.id; qty='1' })
}
Check 'セット構成を登録できる' { $newSet.components -eq 2 }
Check 'セット構成を照会できる' {
  $d = Invoke-RestMethod "$B/masters/sets/$($newSet.id)" -Headers $H
  @($d.components).Count -eq 2
}
Check 'セット構成は登録し直すと入れ替わる' {
  $again = PostJson "$B/masters/sets" @{ sku_id=$setSku2.id; components=@(@{ component_sku_id=$newSku1.id; qty='5' }) }
  $d = Invoke-RestMethod "$B/masters/sets/$($again.id)" -Headers $H
  @($d.components).Count -eq 1 -and [decimal]$d.components[0].qty -eq 5
}

# 得意先別商品・倉庫・仕入マスタ
$pp = PostJson "$B/masters/partner-products" @{
  partner_id=$newPartner.id; sku_id=$newSku1.id; partner_product_code='AMZ-TEST-1'; unit_price='3000'
}
Check '得意先別商品を登録できる（Amazon読み替えの元）' { $pp.partner_product_code -eq 'AMZ-TEST-1' }
Check '同じ取引先で専用コードが重複すると 409' {
  (StatusOf { PostJson "$B/masters/partner-products" @{ partner_id=$newPartner.id; sku_id=$newSku2.id; partner_product_code='AMZ-TEST-1' } }) -eq 409
}
$wh = PostJson "$B/masters/warehouses" @{ warehouse_code='0009'; short_name='テスト倉庫' }
Check '倉庫を登録できる' { $wh.warehouse_code -eq '0009' }
$pi = PostJson "$B/masters/purchase-items" @{ purchase_code='EXP-001'; item_name='撮影費'; unit_cost='80000' }
Check '仕入品目を登録できる' { $pi.purchase_code -eq 'EXP-001' }

# 汎用区分・システム設定
$newCode = PostJson "$B/masters/codes" @{ code_category_code='ADJUSTMENT_REASON'; code='TESTREASON'; name='テスト理由' }
Check '区分値を追加できる' { $newCode.code -eq 'TESTREASON' }
Check '追加した区分値がすぐ使える' {
  $a = PostJson "$B/inventory/adjustments" @{ warehouse_id=$warehouse.id; adjustment_date=$today; reason_code='TESTREASON'
    lines=@(@{ line_no=1; sku_id=$newSku1.id; qty='5' }) }
  $a.adjustment_no -match '^AJ'
}
Check '未登録のカテゴリーは 400' {
  (StatusOf { PostJson "$B/masters/codes" @{ code_category_code='NOPE'; code='X'; name='X' } }) -eq 400
}
Check 'システム設定を画面から変更できる' {
  (PatchJson "$B/masters/settings/SHIPPING_FEE_AMOUNT" @{ value_text='800' }).value_text -eq '800'
}
Check '変更した設定が一覧にも反映される' {
  $all = GetList "$B/masters/settings"
  $hit = @($all | Where-Object { $_.setting_key -eq 'SHIPPING_FEE_AMOUNT' })
  if ($hit.Count -ne 1) {
    Write-Host ('      設定 ' + $all.Count + ' 件中、該当 ' + $hit.Count + ' 件') -ForegroundColor DarkYellow
    return $false
  }
  [decimal]($hit[0].value_text) -eq 800
}
Check '数値設定に文字は入れられない' {
  (StatusOf { PatchJson "$B/masters/settings/SHIPPING_FEE_AMOUNT" @{ value_text='あいうえお' } }) -eq 400
}
Check '存在しない設定は 404' {
  (StatusOf { PatchJson "$B/masters/settings/NOPE" @{ value_text='1' } }) -eq 404
}

Write-Host '=== 23. ロイヤリティ規定の登録 ===' -ForegroundColor Cyan
$payee = PostJson "$B/masters/partners" @{ partner_code='LIC9'; name1='新ライセンサー'; is_supplier=$true }
$brandForRule = PostJson "$B/masters/simple/brands" @{ code='RULEBRAND'; name='規定用ブランド' }
$rule = PostJson "$B/masters/royalty-rules" @{
  payee_partner_id=$payee.id; brand_id=$brandForRule.id; calc_base='出荷'; rate='0.0300'; valid_from="$month-01"
}
Check 'ロイヤリティ規定を登録できる' { [decimal]$rule.rate -eq 0.03 }
Check '優先度が自動で計算される（ブランド指定=1）' { [int]$rule.scope_priority -eq 1 }
$excl = PostJson "$B/masters/royalty-rules" @{
  payee_partner_id=$payee.id; brand_id=$brandForRule.id; customer_partner_id=$newPartner.id
  is_excluded=$true; calc_base='出荷'; valid_from="$month-01"
}
Check '対象外の規定を登録できる' { $excl.is_excluded -eq $true }
Check '販売先を指定すると優先度が上がる（1+4=5）' { [int]$excl.scope_priority -eq 5 }
Check '対象外に料率を入れると 400' {
  (StatusOf { PostJson "$B/masters/royalty-rules" @{ payee_partner_id=$payee.id; brand_id=$brandForRule.id
    is_excluded=$true; rate='0.0100'; calc_base='出荷'; valid_from="$month-01" } }) -eq 400
}
Check '対象なのに料率も定額もないと 400' {
  (StatusOf { PostJson "$B/masters/royalty-rules" @{ payee_partner_id=$payee.id; brand_id=$brandForRule.id
    is_excluded=$false; calc_base='出荷'; valid_from="$month-01" } }) -eq 400
}
Check '同じ範囲・同じ開始日の二重登録は 409' {
  (StatusOf { PostJson "$B/masters/royalty-rules" @{ payee_partner_id=$payee.id; brand_id=$brandForRule.id
    calc_base='出荷'; rate='0.0500'; valid_from="$month-01" } }) -eq 409
}
Check '規定の一覧に支払先・販売先の名前が出る' {
  $l = Invoke-RestMethod "$B/masters/royalty-rules" -Headers $H
  $row = $l.items | Where-Object { $_.id -eq $excl.id } | Select-Object -First 1
  $row.payee_name -eq '新ライセンサー' -and $row.customer_name -eq '新規取引先'
}
Check '料率改定は新しい適用開始日で行を足す' {
  $next = PostJson "$B/masters/royalty-rules" @{ payee_partner_id=$payee.id; brand_id=$brandForRule.id
    calc_base='出荷'; rate='0.0400'; valid_from='2027-01-01' }
  [decimal]$next.rate -eq 0.04
}
Check '規定を無効にできる' {
  (PostJson "$B/masters/royalty-rules/$($rule.id)/deactivate" @{}).is_active -eq $false
}

Write-Host '=== 24. 受注の修正（ご要望⑨⑩） ===' -ForegroundColor Cyan
$editOrder = NewOrder @{
  order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
  sales_category_id=$category.id; order_date=$today
  lines=@(@{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='修正前'; qty='5'; unit_price='1000' })
}
Check 'ヘッダだけ直せる' {
  PatchJson "$B/orders/$($editOrder.id)" @{ shipping_remarks='急ぎ便で' } | Out-Null
  (Invoke-RestMethod "$B/orders/$($editOrder.id)" -Headers $H).shipping_remarks -eq '急ぎ便で'
}
Check '明細を入れ替えられる' {
  PatchJson "$B/orders/$($editOrder.id)" @{
    lines=@(
      @{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='修正後'; qty='8'; unit_price='1200' }
      @{ line_no=2; line_type='送料'; item_name='送料'; qty='1'; unit_price='500' }
    )
  } | Out-Null
  $d = Invoke-RestMethod "$B/orders/$($editOrder.id)" -Headers $H
  @($d.lines).Count -eq 2 -and [decimal]($d.lines | Where-Object { $_.line_no -eq 1 }).amount -eq 9600
}
Check '出荷指示後は修正できない' {
  Invoke-RestMethod "$B/orders/$($editOrder.id)/shipping-instruction" -Method Post -Headers $H | Out-Null
  (StatusOf { PatchJson "$B/orders/$($editOrder.id)" @{ shipping_remarks='後から' } }) -eq 409
}
Check '引当を解除すれば再び修正できる' {
  Invoke-RestMethod "$B/orders/$($editOrder.id)/shipping-instruction" -Method Delete -Headers $H | Out-Null
  (PatchJson "$B/orders/$($editOrder.id)" @{ shipping_remarks='解除後に修正' }).order_no -match '^SO'
}
Write-Host '=== 25. ユーザー・権限（M-17） ===' -ForegroundColor Cyan
function PutJson($url, $body, $headers = $H) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6))
  Invoke-RestMethod $url -Method Put -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
}

$roles = GetList "$B/admin/roles"
$roleAdmin  = $roles | Where-Object { $_.code -eq 'ADMIN' }
$roleViewer = $roles | Where-Object { $_.code -eq 'VIEWER' }
Check 'ロールが4種そろっている' { @($roles).Count -ge 4 -and $null -ne $roleAdmin }

Check '閲覧者はユーザー・権限画面に入れない' {
  (StatusOf { Invoke-RestMethod "$B/admin/users" -Headers $HV }) -eq 403
}
Check '管理者は利用者一覧を見られる' {
  (GetList "$B/admin/users").Count -ge 1
}

# 新しい利用者を、まずロールなしで作る
$newPass = 'Sumikko-2026!'
$staff = PostJson "$B/admin/users" @{
  login_id='staff1'; name='新任 太郎'; email='staff1@example.com'; password=$newPass; role_ids=@()
}
Check '利用者を登録できる' { $staff.login_id -eq 'staff1' -and @($staff.roles).Count -eq 0 }
Check 'パスワードが短いと断る' {
  (StatusOf { PostJson "$B/admin/users" @{ login_id='staff2'; name='短い'; password='abc'; role_ids=@() } }) -eq 400
}
Check 'ログインIDが重複すると断る' {
  (StatusOf { PostJson "$B/admin/users" @{ login_id='staff1'; name='重複'; password=$newPass; role_ids=@() } }) -eq 409
}

$staffLogin = Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
                -Body (@{ login_id='staff1'; password=$newPass } | ConvertTo-Json)
$HS = @{ Authorization = "Bearer $($staffLogin.access_token)" }
Check '登録した利用者でログインできる' { $staffLogin.access_token }
Check 'ロールがなければ何も通らない' {
  (StatusOf { Invoke-RestMethod "$B/masters/partners" -Headers $HS }) -eq 403
}

Check 'ロールを与えるとその場で通る（権限の記憶を捨てている）' {
  PutJson "$B/admin/users/$($staff.id)/roles" @{ role_ids=@($roleViewer.id) } | Out-Null
  $null -ne (Invoke-RestMethod "$B/masters/partners" -Headers $HS).items
}
Check 'ロールを外すとまた通らなくなる' {
  PutJson "$B/admin/users/$($staff.id)/roles" @{ role_ids=@() } | Out-Null
  (StatusOf { Invoke-RestMethod "$B/masters/partners" -Headers $HS }) -eq 403
}

Check 'パスワードを再設定できる' {
  PostJson "$B/admin/users/$($staff.id)/password" @{ password='Kirakira-2026!' } | Out-Null
  $r = Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
         -Body (@{ login_id='staff1'; password='Kirakira-2026!' } | ConvertTo-Json)
  [bool]$r.access_token
}
Check '無効にした利用者はログインできない' {
  PostJson "$B/admin/users/$($staff.id)/deactivate" @{} | Out-Null
  (StatusOf {
    Invoke-RestMethod "$B/auth/login" -Method Post -ContentType 'application/json' `
      -Body (@{ login_id='staff1'; password='Kirakira-2026!' } | ConvertTo-Json)
  }) -eq 401
}
Check '無効にした利用者は既定の一覧に出ない' {
  $active = (GetList "$B/admin/users")                          | Where-Object { $_.login_id -eq 'staff1' }
  $all    = (GetList "$B/admin/users?include_inactive=true")    | Where-Object { $_.login_id -eq 'staff1' }
  @($active).Count -eq 0 -and @($all).Count -eq 1
}

# 権限マトリクス
$matrix = Invoke-RestMethod "$B/admin/permission-matrix" -Headers $H
Check '権限マトリクスを取得できる（151項目）' { @($matrix.permissions).Count -eq 151 }
Check '管理者はすべての権限を持っている' {
  $adminId = $roleAdmin.id
  $missing = @($matrix.permissions | Where-Object { $matrix.granted."$($_.id)" -notcontains $adminId })
  $missing.Count -eq 0
}

$allPerms = GetList "$B/admin/permissions"
Check '管理者からユーザー・権限を外すことはできない' {
  $ids = @($allPerms | Where-Object { $_.function_id -ne 'M-17' } | ForEach-Object { $_.id })
  (StatusOf { PutJson "$B/admin/roles/$($roleAdmin.id)/permissions" @{ permission_ids=$ids } }) -eq 400
}
Check '最後の管理者は無効にできない' {
  $adminUser = (GetList "$B/admin/users") |
                 Where-Object { $_.login_id -eq 'admin' } | Select-Object -First 1
  (StatusOf { PostJson "$B/admin/users/$($adminUser.id)/deactivate" @{} }) -eq 400
}

Check 'ロールの権限を差し替えると閲覧者の見え方が変わる' {
  $only = @($allPerms | Where-Object { $_.function_id -eq 'M-01' -and $_.action -eq 'view' } |
             ForEach-Object { $_.id })
  PutJson "$B/admin/roles/$($roleViewer.id)/permissions" @{ permission_ids=$only } | Out-Null
  $partnersOk = (StatusOf { Invoke-RestMethod "$B/masters/partners" -Headers $HV }) -eq 200
  $productsNg = (StatusOf { Invoke-RestMethod "$B/masters/products" -Headers $HV }) -eq 403
  $partnersOk -and $productsNg
}

Check '監査ログを参照できる' {
  $log = Invoke-RestMethod "$B/admin/audit-logs?limit=5" -Headers $H
  $null -ne $log.total -and $log.limit -eq 5
}

Write-Host '=== 26. 帳票一括印刷（D-03） ===' -ForegroundColor Cyan
function GetPdf($url, $headers = $H) {
  $r = Invoke-WebRequest $url -Headers $headers -UseBasicParsing
  $b = $r.Content
  [pscustomobject]@{
    type  = [string]$r.Headers['Content-Type']
    size  = $b.Length
    magic = [System.Text.Encoding]::ASCII.GetString($b[0..3])
  }
}

$shipId  = 0
$shipId2 = 0
function NewInstructedShipment($name, $qty) {
  $o = NewOrder @{
    order_type='卸'; partner_id=$partner.id; delivery_destination_id=$dest.id
    sales_category_id=$category.id; order_date=$today
    lines=@(
      @{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name=$name; qty=$qty; unit_price='2000' }
      @{ line_no=2; line_type='送料'; item_name='送料'; qty='1'; unit_price='800' }
    )
  }
  $script:docOrderId = $o.id
  (Invoke-RestMethod "$B/orders/$($o.id)/shipping-instruction" -Method Post -Headers $H).shipment_id
}
$docOrderId = 0
Check '帳票の対象にする出荷指示を用意する' {
  $script:shipId  = NewInstructedShipment '帳票テスト品' '3'
  $script:shipId2 = NewInstructedShipment '帳票テスト品2' '2'
  $script:shipId -gt 0 -and $script:shipId2 -gt 0 -and $script:shipId -ne $script:shipId2
}

Check '出荷指示書がPDFで出る' {
  $p = GetPdf "$B/reports/shipping-instructions?shipment_ids=$shipId"
  $p.magic -eq '%PDF' -and $p.type -match 'application/pdf' -and $p.size -gt 1000
}
Check 'ピッキングリストがPDFで出る（セット展開後の引当を数える）' {
  $p = GetPdf "$B/reports/picking-list?shipment_ids=$shipId"
  $p.magic -eq '%PDF' -and $p.size -gt 1000
}
Check '納品書が4様式とも出る' {
  $forms = @('単価あり','単価あり2','上代あり','単価なし')
  $ng = 0
  foreach ($f in $forms) {
    $u = "$B/reports/delivery-notes?shipment_ids=$shipId&form=" + [uri]::EscapeDataString($f)
    if ((GetPdf $u).magic -ne '%PDF') { $ng++ }
  }
  $ng -eq 0
}
Check '様式を指定しなければ設定の既定様式で出る' {
  (GetPdf "$B/reports/delivery-notes?shipment_ids=$shipId").magic -eq '%PDF'
}
Check '知らない様式は断る' {
  (StatusOf { GetPdf "$B/reports/delivery-notes?shipment_ids=$shipId&form=xxx" }) -eq 400
}
Check '請求書がPDFで出る' {
  $p = GetPdf "$B/reports/invoices?invoice_ids=$invoiceId"
  $p.magic -eq '%PDF' -and $p.size -gt 1000
}
Check '複数の出荷を1つのPDFにまとめられる（1件1ページ）' {
  $p1 = GetPdf "$B/reports/shipping-instructions?shipment_ids=$shipId"
  $p2 = GetPdf "$B/reports/shipping-instructions?shipment_ids=$shipId,$shipId2"
  $p2.size -gt $p1.size
}
Check '誰がいつ出したかが帳票発行履歴に残る' {
  $r = Invoke-Psql -Command "select count(*) from cony.shipment_documents where shipment_id=$shipId and printed_by is not null and output_format='PDF'"
  $n = ($r.text -split "`n" | Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1)
  [int]$n.Trim() -ge 3
}
Check '出荷を選ばないと断る' {
  (StatusOf { GetPdf "$B/reports/shipping-instructions?shipment_ids=" }) -eq 400
}
Check 'ない出荷を指定すると 404' {
  (StatusOf { GetPdf "$B/reports/shipping-instructions?shipment_ids=999999" }) -eq 404
}
Check '印刷権限のない利用者は出せない' {
  (StatusOf { GetPdf "$B/reports/shipping-instructions?shipment_ids=$shipId" $HV }) -eq 403
}

Write-Host '=== 27. 郵便番号・同梱・請求の手入力・販売予定・JAN出力・添付 ===' -ForegroundColor Cyan

# --- 郵便番号（日本郵便 KEN_ALL の形の小さなファイルで確かめる） ---
$kenAll = @(
  '13101,"100  ","1000001","ﾄｳｷｮｳﾄ","ﾁﾖﾀﾞｸ","ﾁﾖﾀﾞ","東京都","千代田区","千代田",0,0,0,0,0,0'
  '13101,"100  ","1000005","ﾄｳｷｮｳﾄ","ﾁﾖﾀﾞｸ","ﾏﾙﾉｳﾁ","東京都","千代田区","丸の内",0,0,1,0,0,0'
  '13101,"100  ","1000005","ﾄｳｷｮｳﾄ","ﾁﾖﾀﾞｸ","ﾕｳﾗｸﾁｮｳ","東京都","千代田区","有楽町",0,0,1,0,0,0'
  '13101,"100  ","1008111","ﾄｳｷｮｳﾄ","ﾁﾖﾀﾞｸ","ｲｶﾆｹｲｻｲｶﾞﾅｲﾊﾞｱｲ","東京都","千代田区","以下に掲載がない場合",0,0,0,0,0,0'
) -join "`r`n"
$kenBytes = [System.Text.Encoding]::GetEncoding(932).GetBytes($kenAll)
Check '郵便番号（KEN_ALL）を取り込める' {
  $r = PostJson "$B/postal-codes/import" @{
    content_base64 = [Convert]::ToBase64String($kenBytes); encoding='CP932'; data_version='202609'
  }
  $r.inserted -ge 4
}
Check '郵便番号から住所を引ける' {
  $a = GetList "$B/postal-codes/1000001"
  $a.Count -eq 1 -and $a[0].prefecture -eq '東京都' -and $a[0].town -eq '千代田'
}
Check 'ハイフン付きでも引ける' { (GetList "$B/postal-codes/100-0001").Count -eq 1 }
Check '同じ郵便番号に複数の町域があれば全部返す' {
  $a = GetList "$B/postal-codes/1000005"
  $a.Count -eq 2 -and $a[0].is_multi_town -eq $true
}
Check '「以下に掲載がない場合」は町域なしにする' {
  (GetList "$B/postal-codes/1008111")[0].town -eq ''
}
Check '住所から郵便番号を逆引きできる' {
  (GetList "$B/postal-codes/search?q=丸の内").Count -ge 1
}
Check '7桁でない郵便番号は断る' {
  (StatusOf { Invoke-RestMethod "$B/postal-codes/12345" -Headers $H }) -eq 400
}
Check '取り込んだ版が設定に残る' {
  $v = (GetList "$B/masters/settings") | Where-Object { $_.setting_key -eq 'POSTAL_DATA_VERSION' }
  $v.value_text -eq '202609'
}

# --- 同梱 ---
Check '同じ得意先・納品先・倉庫なら同梱できる' {
  $r = PostJson "$B/shipments/consolidate" @{ shipment_ids=@($shipId2); into_shipment_id=$shipId }
  @($r.consolidated).Count -eq 1 -and $r.into_shipment_id -eq $shipId
}
Check '同梱された側はまとめ先を指す' {
  (Invoke-RestMethod "$B/shipments/$shipId2" -Headers $H).consolidated_to_shipment_id -eq $shipId
}
Check '得意先が違うと同梱できない' {
  $o = NewOrder @{
    order_type='卸'; partner_id=$newPartner.id; delivery_destination_id=$newDest.id
    sales_category_id=$category.id; order_date=$today
    lines=@(@{ line_no=1; line_type='商品'; sku_id=$sku.sku_id; item_name='別得意先'; qty='1'; unit_price='100' })
  }
  $s = (Invoke-RestMethod "$B/orders/$($o.id)/shipping-instruction" -Method Post -Headers $H).shipment_id
  (StatusOf { PostJson "$B/shipments/consolidate" @{ shipment_ids=@($s); into_shipment_id=$shipId } }) -eq 409
}
Check '同梱を解ける' {
  (Invoke-RestMethod "$B/shipments/$shipId2/consolidation" -Method Delete -Headers $H).consolidated_to_shipment_id -eq $null
}

# --- 請求の手入力欄（未計上・調整・手数料・送料） ---
$openInvoice = (PostJson "$B/billing/closings" @{ target_month=$month; partner_id=$newPartner.id }).invoices[0]
Check '未計上・調整・手数料を手入力できる' {
  $r = PatchJson "$B/billing/invoices/$($openInvoice.id)" @{
    unposted_10='1000'; adjust_8='-500'; fee_amount='300'; shipping_fee_amount='800'
  }
  [decimal]$r.unposted_10 -eq 1000 -and [decimal]$r.adjust_8 -eq -500
}
Check '手入力すると当月請求額が計算し直される' {
  $r = Invoke-RestMethod "$B/billing/invoices/$($openInvoice.id)" -Headers $H
  [decimal]$r.current_invoice_amount -ne 0 -and
    [decimal]$r.current_balance -eq ([decimal]$r.carryover_balance + [decimal]$r.current_invoice_amount)
}
Check '発行済の請求は手入力で直せない' {
  (StatusOf { PatchJson "$B/billing/invoices/$invoiceId" @{ fee_amount='100' } }) -eq 409
}

# --- 販売予定 ---
$plan = PostJson "$B/sales-schedules" @{
  partner_id=$partner.id; sku_id=$sku.sku_id; planned_sales_month='2026-11'
  planned_arrival_month='2026-10'; planned_qty='120'; note='秋物'
}
Check '販売予定を登録できる（年月だけで入れられる）' {
  $plan.planned_sales_month -eq '2026-11-01'
}
Check '販売予定を年月で絞って一覧できる' {
  $r = Invoke-RestMethod "$B/sales-schedules?month=2026-11" -Headers $H
  @($r.items | Where-Object { $_.id -eq $plan.id }).Count -eq 1
}
Check '販売予定を更新できる' {
  [decimal](PatchJson "$B/sales-schedules/$($plan.id)" @{ planned_qty='150' }).planned_qty -eq 150
}
Check '販売予定は削除できる（伝票ではないため）' {
  (Invoke-RestMethod "$B/sales-schedules/$($plan.id)" -Method Delete -Headers $H).deleted -eq $true
}

# --- JANコード出力 ---
Check 'JANコード一覧をExcelで開けるCSVで出せる' {
  $text = [System.Text.Encoding]::UTF8.GetString((GetFileBytes "$B/masters/skus/jan-export"))
  # JAN は Excel が数値に直さないよう "=""...""" の形で書き出している
  $text.Substring(0,1) -eq [char]0xFEFF -and $text -match 'SKUコード' -and
    $text.Contains('"=""4900000000011"""')
}

# --- 添付ファイル ---
$att = PostJson "$B/attachments" @{
  ref_table='sales_orders'; ref_id=$docOrderId; file_name='指示メモ.txt'
  content_base64=[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('こわれものです'))
  mime_type='text/plain'
}
Check '受注に添付できる' { $att.file_name -eq '指示メモ.txt' -and $att.byte_size -gt 0 }
Check '添付の一覧が出る' {
  (GetList "$B/attachments?ref_table=sales_orders&ref_id=$docOrderId").Count -ge 1
}
Check '添付の中身を取り出せる' {
  [System.Text.Encoding]::UTF8.GetString((GetFileBytes "$B/attachments/$($att.id)/content")) -eq 'こわれものです'
}
Check '知らない伝票種別には添付できない' {
  (StatusOf { PostJson "$B/attachments" @{ ref_table='users'; ref_id=1; file_name='x.txt'; content_base64='eA==' } }) -eq 400
}
Check 'ない伝票には添付できない' {
  (StatusOf { PostJson "$B/attachments" @{ ref_table='sales_orders'; ref_id=999999; file_name='x.txt'; content_base64='eA==' } }) -eq 400
}
Check '添付を消せる' {
  (Invoke-RestMethod "$B/attachments/$($att.id)" -Method Delete -Headers $H).deleted -eq $true
}

Write-Host ''
if ($script:ng -eq 0) {
  Write-Host ("すべて合格  {0} 項目" -f $script:ok) -ForegroundColor Green
} else {
  Write-Host ("合格 {0} / 不合格 {1}" -f $script:ok, $script:ng) -ForegroundColor Red
}

if ($KeepRunning) {
  Write-Host ("API は起動したままです: {0}  （片付けは -KeepRunning なしで再実行）" -f $B)
} else {
  Cleanup
  Write-Host '使い捨てデータベースと API を片付けました。'
}
exit $script:ng


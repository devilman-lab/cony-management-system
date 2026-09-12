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
Check 'SKU を JAN で検索'              { @(Invoke-RestMethod "$B/masters/skus?q=4900000000011" -Headers $H).Count -ge 1 }
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

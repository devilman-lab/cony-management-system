import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { sql } from 'kysely';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/guards';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { SIMPLE_MASTERS } from '../masters/masters-crud.service';

/**
 * 読めるテーブルと、読むのに要る権限（その画面の参照の権限）。
 *
 * **ここに載せたテーブルだけ**を読む。URL の :table はこの表の鍵と突き合わせるだけで、
 * 文字のまま SQL に渡ることはない。新しい編集画面に「登録日・更新日」を出すときはここに足す。
 */
const STAMP_TABLES: Record<string, string> = {
  partners: 'M-01',
  delivery_destinations: 'M-05',
  products: 'M-08',
  skus: 'M-09',
  set_headers: 'M-10',
  partner_products: 'M-11',
  warehouses: 'M-14',
  purchase_items: 'M-15',
  codes: 'M-16',
  ...Object.fromEntries(Object.keys(SIMPLE_MASTERS).map((t) => [t, 'M-16'])),
  royalty_rules: 'Y-02',
  receipts: 'S-03',
  stock_adjustments: 'S-01',
  reservation_groups: 'S-08',
  sales_orders: 'O-03',
};

/**
 * 編集画面の下に出す「登録日：… 名前　更新日：… 名前」（2026-10-16 マスター編3 M3-01。
 * 楽楽販売の「作成：… 最終更新：…」と同じもの）。
 *
 * 各画面の詳細 API に1つずつ列を足すと漏れが出るため、テーブルと ID から読む経路を1つだけ置く。
 * 権限は、そのテーブルを扱う画面の参照の権限で見る（画面を開ける人だけが読める）。
 */
@Controller('record-stamps')
export class RecordStampsController {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly auth: AuthService,
  ) {}

  @Get(':table/:id')
  async stamp(
    @Param('table') table: string,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const functionId = STAMP_TABLES[table];
    if (!functionId) throw new NotFoundException(`「${table}」の登録日・更新日は読めません`);
    if (!(await this.auth.can(user.id, functionId, 'view'))) {
      throw new ForbiddenException('この操作を行う権限がありません');
    }

    // テーブル名は上の表の鍵（＝実在のテーブル名）だけ。利用者の入力は値（id）としてのみ渡る
    const { rows } = await sql<{
      created_at: Date;
      created_by_name: string | null;
      updated_at: Date;
      updated_by_name: string | null;
    }>`
      select t.created_at, cu.name as created_by_name, t.updated_at, uu.name as updated_by_name
        from ${sql.table(table)} t
        left join users cu on cu.id = t.created_by
        left join users uu on uu.id = t.updated_by
       where t.id = ${id}
    `.execute(this.db);
    if (rows.length === 0) throw new NotFoundException(`データが見つかりません（ID: ${id}）`);
    return rows[0];
  }
}

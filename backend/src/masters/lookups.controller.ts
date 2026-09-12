import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { sql } from 'kysely';

import { RequirePermission } from '../auth/guards';
import { KYSELY, type ConyDatabase } from '../db/database.module';

/**
 * 受注入力などで選択肢として使うマスタ。
 * 区分値はすべてデータベースに持たせており、プログラムに固定値は書かない。
 */
@Controller('masters')
export class LookupsController {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  @Get('sales-categories')
  @RequirePermission('O-01', 'view')
  salesCategories() {
    return this.db
      .selectFrom('sales_categories')
      .select(['id', 'code', 'name'])
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('code', 'asc')
      .execute();
  }

  @Get('warehouses')
  @RequirePermission('M-14', 'view')
  warehouses() {
    return this.db
      .selectFrom('warehouses')
      .select(['id', 'warehouse_code', 'short_name', 'is_consignment'])
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('warehouse_code', 'asc')
      .execute();
  }

  /** 汎用区分。例 /api/masters/codes/QUALITY_DIVISION */
  @Get('codes/:categoryCode')
  @RequirePermission('M-16', 'view')
  async codes(@Param('categoryCode') categoryCode: string) {
    const category = await this.db
      .selectFrom('code_categories')
      .select(['id', 'code', 'name'])
      .where('code', '=', categoryCode)
      .executeTakeFirst();

    if (!category) throw new NotFoundException(`区分カテゴリーが見つかりません（${categoryCode}）`);

    const values = await this.db
      .selectFrom('codes')
      .select(['id', 'code', 'name'])
      .where('code_category_id', '=', category.id)
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('code', 'asc')
      .execute();

    return { category, values };
  }

  /** システム設定の一覧。画面から変更できる項目がどれかを示す。 */
  @Get('settings')
  @RequirePermission('M-16', 'view')
  settings() {
    return this.db
      .selectFrom('system_settings')
      .select([
        'setting_key',
        'setting_group',
        'name',
        'value_text',
        'value_type',
        'allowed_values',
        'description',
        'is_user_editable',
      ])
      .orderBy('setting_group', 'asc')
      .orderBy('sort_order', sql`asc nulls last`)
      .execute();
  }
}

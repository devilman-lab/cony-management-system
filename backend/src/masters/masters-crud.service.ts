import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import type { Paged } from './partners.service';

/** 分類マスタ。コード・名称・表示順・有効・備考だけを持つ同じ形のもの。 */
export const SIMPLE_MASTERS = {
  brands: 'ブランド',
  categories: 'カテゴリー',
  product_classes: '商品分類',
  colors: 'カラー',
  sizes: 'サイズ',
  media: '媒体',
  partner_categories: '取引先カテゴリー',
  sales_categories: '販売カテゴリー',
  delivery_rules: '納品ルール',
  work_instructions: '作業指示内容',
  sales_staff: '販売担当',
} as const;

export type SimpleMaster = keyof typeof SIMPLE_MASTERS;

export type WritableTable = keyof DB & string;

export interface ListOptions {
  q?: string;
  /** 部分一致で探す列。 */
  searchColumns: string[];
  include_inactive?: boolean;
  orderBy: string[];
  limit: number;
  offset: number;
}

/**
 * マスタの登録・更新をまとめて扱う。
 *
 * **マスタは物理削除しない。**伝票から参照されているため、消すと過去の伝票が
 * 読めなくなる。使わなくなったものは「無効」にして一覧から外す。
 * 検証は経路ごとに zod で行い、ここには検証済みの値だけが来る。
 */
@Injectable()
export class MastersCrudService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async list(table: WritableTable, opts: ListOptions): Promise<Paged<Record<string, unknown>>> {
    let base = this.db.selectFrom(table as never);

    if (!opts.include_inactive) {
      base = base.where(sql`is_active`, '=', true) as never;
    }
    if (opts.q && opts.searchColumns.length > 0) {
      const like = `%${opts.q}%`;
      // 検索対象の列はマスタごとに違うため、1つの条件式として組む。
      // 列名はこちら側の定義から渡すもので、利用者の入力は値としてのみ渡る。
      const predicate = sql<boolean>`(${sql.join(
        opts.searchColumns.map((c) => sql`${sql.ref(c)} ilike ${like}`),
        sql` or `,
      )})`;
      base = base.where(predicate as never) as never;
    }

    const [items, total] = await Promise.all([
      base
        .selectAll()
        .orderBy(opts.orderBy.map((c) => sql.ref(c)) as never)
        .limit(opts.limit)
        .offset(opts.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return {
      items: items as Record<string, unknown>[],
      total: Number((total as { n: number }).n),
      limit: opts.limit,
      offset: opts.offset,
    };
  }

  async findOne(table: WritableTable, id: number, label: string): Promise<Record<string, unknown>> {
    const row = await this.db
      .selectFrom(table as never)
      .selectAll()
      .where(sql`id`, '=', id)
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`${label}が見つかりません（ID: ${id}）`);
    return row as Record<string, unknown>;
  }

  async create(
    table: WritableTable,
    values: Record<string, unknown>,
    userId: number,
  ): Promise<Record<string, unknown>> {
    const row = await this.db
      .insertInto(table as never)
      .values({ ...values, created_by: userId, updated_by: userId } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as Record<string, unknown>;
  }

  /** 監査のため created_by は触らない。誰が最後に直したかは updated_by に残す。 */
  async update(
    table: WritableTable,
    id: number,
    values: Record<string, unknown>,
    label: string,
    userId: number,
  ): Promise<Record<string, unknown>> {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('更新する項目がありません');
    }

    const row = await this.db
      .updateTable(table as never)
      .set({ ...clean, updated_by: userId, updated_at: new Date() } as never)
      .where(sql`id`, '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`${label}が見つかりません（ID: ${id}）`);
    return row as Record<string, unknown>;
  }

  /**
   * 無効にする（物理削除しない）。
   * 伝票から参照されているマスタを消すと、過去の伝票が読めなくなる。
   */
  async setActive(
    table: WritableTable,
    id: number,
    isActive: boolean,
    label: string,
    userId: number,
  ): Promise<{ id: number; is_active: boolean }> {
    const row = await this.db
      .updateTable(table as never)
      .set({ is_active: isActive, updated_by: userId, updated_at: new Date() } as never)
      .where(sql`id`, '=', id)
      .returning([sql<number>`id`.as('id'), sql<boolean>`is_active`.as('is_active')])
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`${label}が見つかりません（ID: ${id}）`);
    return row;
  }

  /**
   * 一覧から消す。
   *
   * **どこからも使われていないものだけ消せる。**伝票から参照されているマスタを
   * 消すと過去の伝票が読めなくなるため、使われているものは断って「使わない」に
   * 誘導する（1001 のご要望「入力後に、一覧から削除ができるようにしてほしい」）。
   *
   * 使われているかどうかは外部キーに任せる。参照元を1つずつ数えると、
   * 新しいテーブルが増えたときに数え漏れるため。
   */
  async remove(table: WritableTable, id: number, label: string): Promise<{ id: number; deleted: true }> {
    const exists = await this.db
      .selectFrom(table as never)
      .select(sql<number>`id`.as('id'))
      .where(sql`id`, '=', id)
      .executeTakeFirst();
    if (!exists) throw new NotFoundException(`${label}が見つかりません（ID: ${id}）`);

    try {
      await this.db.deleteFrom(table as never).where(sql`id`, '=', id).execute();
    } catch (e) {
      // 23503 ＝ 外部キー違反。どこかの伝票・マスタから使われている。
      if ((e as { code?: string }).code === '23503') {
        // どこで使われているかを出す（2026-10-16 マスター編3 M3-39「使われていれば理由を出して断る」）
        const where = await this.usages(table, id).catch(() => '');
        throw new ConflictException(
          (where ? `この${label}は次で使われているため削除できません：${where}。` : `この${label}はすでに伝票などで使われているため、削除できません。`) +
            `一覧や選択肢から外したいときは、編集画面で「非表示」にしてください`,
        );
      }
      throw e;
    }
    return { id, deleted: true };
  }

  /**
   * どこで何件使われているか（「取引先 3件、受注 2件」の形）。削除を断るときの理由に使う。
   *
   * 参照元は外部キーの定義（pg_constraint）から拾う（products.service.ts の usages と同じ考え方）。
   * 消すと一緒に消える参照（ON DELETE CASCADE・SET NULL・SET DEFAULT）は数えない。
   */
  async usages(table: WritableTable, id: number): Promise<string> {
    const fks = await sql<{ table_name: string; column_name: string }>`
      select cl.relname as table_name, a.attname as column_name
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join pg_namespace n on n.oid = rf.relnamespace
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f'
         and rf.relname = ${table}
         and n.nspname = current_schema()
         and array_length(c.conkey, 1) = 1
         and c.confdeltype not in ('c', 'n', 'd')
       order by cl.relname, a.attname`.execute(this.db);

    const counts = new Map<string, number>();
    for (const fk of fks.rows) {
      // 表・列の名前はデータベースの定義から取ったもの。利用者の入力は値としてのみ渡る
      const r = await sql<{ n: number }>`
        select count(*)::int as n from ${sql.table(fk.table_name)} where ${sql.ref(fk.column_name)} = ${id}`.execute(this.db);
      const n = Number(r.rows[0]?.n ?? 0);
      if (n === 0) continue;
      const name = TABLE_LABELS[fk.table_name] ?? fk.table_name;
      counts.set(name, (counts.get(name) ?? 0) + n);
    }
    return [...counts].map(([name, n]) => `${name} ${n}件`).join('、');
  }
}

/**
 * 参照元の表の呼び名（削除を断る理由に出す）。載っていない表は表の名前のまま出す。
 * 見出しと明細は同じ呼び名にする（「受注 3件」のように、利用者には1つの伝票に見えるため）。
 */
const TABLE_LABELS: Record<string, string> = {
  allocations: '引当（出荷）',
  ap_ledgers: '買掛',
  ar_ledgers: '売掛',
  cash_payments: '支払',
  cash_receipts: '入金',
  cash_transactions: '入出金',
  codes: '区分値',
  delivery_destinations: '納品先',
  external_order_lines: '受注取込',
  external_orders: '受注取込',
  import_templates: '取込の設定',
  invoice_lines: '請求書',
  invoices: '請求書',
  partner_category_links: '取引先',
  partner_product_prices: '得意先別商品',
  partner_products: '得意先別商品',
  partners: '取引先',
  platform_transactions: 'Amazon 取引取込',
  product_classes: '商品分類',
  products: '商品',
  purchase_items: '仕入項目',
  purchase_lines: '仕入',
  purchases: '仕入',
  receipt_lines: '入荷',
  receipts: '入荷',
  refurbishments: '再生',
  reservation_groups: '引当在庫',
  reservations: '引当在庫',
  return_lines: '返品',
  returns: '返品',
  royalty_calculation_lines: 'ロイヤリティ計算',
  royalty_calculations: 'ロイヤリティ計算',
  royalty_rules: 'ロイヤリティ規定',
  sales_order_lines: '受注',
  sales_orders: '受注',
  sales_schedules: '販売予定',
  set_components: 'セット登録',
  set_headers: 'セット登録',
  shipment_lines: '出荷',
  shipments: '出荷',
  skus: 'SKU',
  stock_adjustment_lines: '在庫調整',
  stock_adjustments: '在庫調整',
  stock_movements: '在庫の動き',
  stocks: '在庫表',
  users: '利用者',
  warehouses: '倉庫',
};

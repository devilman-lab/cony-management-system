import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
}

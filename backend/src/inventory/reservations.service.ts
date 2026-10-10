import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';

/**
 * 確保数（貴社の呼び方では「引当在庫」）。
 *
 * 2026-10-09（在庫編）から「確保（見出し）＋明細」の形にした。商品登録と同じく、
 * 見出し（販売期間・媒体・取引先・販売カテゴリー・項目・商品分類・備考）の下に
 * SKU ごとの確保数を並べて1枚で登録する。見出しは reservation_groups、明細は reservations。
 * 明細にも取引先・媒体・販売カテゴリー・期間を持たせているのは、受注で減らすときの
 * 当て方を明細だけで引けるようにするため（見出しを直したら明細にも写す）。
 *
 * 受注で減らすときの当て方（Z-25）:
 *  - 販売カテゴリーが一致し、受注日が期間に入っていること
 *  - 見出しに取引先があれば、その取引先の受注だけ
 *  - 取引先が空で媒体があれば、受注の取引先の媒体（取引先マスタの媒体）が一致する受注
 *  - 取引先も媒体も空（2026-10-09 より前に作った枠）は、その販売カテゴリーの受注すべて
 *  - 複数当たれば 取引先指定 → 媒体指定 → どちらも無し の順に使う
 *  - 「項目」は当て方に使わない（何と突き合わせるか顧客に確認中。表示と確保の区別のため）
 *
 * 枠は期間で持つので、月末を過ぎれば自動的に効かなくなり、翌月1日からは翌月の
 * 枠が使われる。夜間処理はない。棚の在庫（有効在庫）とは別の枠。受注登録では両方を見る。
 */

/** 受注の当て方を決める材料。 */
interface OrderScope {
  partner_id: number;
  /** 受注の取引先の媒体（取引先マスタ） */
  media_id: number | null;
  sales_category_id: number;
  order_date: string;
}

export interface GroupHeaderInput {
  period_from: string;
  period_to: string;
  media_id?: number | null;
  partner_id?: number | null;
  sales_category_id: number;
  item_label?: string | null;
  product_class_id?: number | null;
  note?: string | null;
}

export interface GroupLineInput {
  /** 既存の明細を直すときだけ。無ければ新しい明細 */
  id?: number | null;
  sku_id: number;
  reserved_qty: string;
}

export interface GroupListFilter {
  /** from〜to に少しでも重なる確保。月の一覧はこちら（月の途中から始まる確保を取りこぼさないため） */
  from?: string;
  to?: string;
  sales_category_id?: number;
  media_id?: number;
  partner_id?: number;
  sku_id?: number;
  /** 商品コード・品番・商品名のどれかを含む明細がある確保 */
  q?: string;
  limit: number;
  offset: number;
}

/** 一覧・CSV の明細の行。 */
interface LineRow {
  id: number;
  group_id: number;
  sku_id: number;
  sku_code: string;
  item_name: string;
  color_name: string | null;
  size_name: string | null;
  reserved_qty: string;
  consumed_qty: string;
  remaining_qty: string;
}

/** 数量の表示用。NUMERIC の文字列から末尾の 0 を落とす（10.00 → 10）。数値には通さない。 */
const trimQty = (v: string | null | undefined): string => {
  const s = String(v ?? '0');
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** 日付の表示用（YYYY-MM-DD → YYYY/MM/DD） */
const slash = (d: string): string => String(d).slice(0, 10).replace(/-/g, '/');

@Injectable()
export class ReservationsService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  // ===========================================================================
  // 受注からの消費・戻し
  // ===========================================================================

  /**
   * 受注の明細を枠から減らす。受注の登録・修正の直後に同じトランザクションで呼ぶ。
   * strict=false（CSV取込）では、枠を超えても止めずに知らせるだけにする。
   * 枠が登録されていない商品はそのまま通す（枠は任意）。
   *
   * セット商品（Z-31）: セット SKU の枠があればそれを減らす。無ければ構成品の枠を
   * 「構成数 × セット数」ずつ減らす。通販CSVのように内訳商品の行が付いている受注は、
   * セット SKU の枠が無ければ内訳商品の行がそれぞれ構成品の枠を減らす（二重に減らさない）。
   */
  async consume(trx: Transaction<DB>, orderId: number, opts: { strict: boolean }): Promise<string[]> {
    const scope = await this.orderScope(trx, orderId);

    const lines = await trx
      .selectFrom('sales_order_lines as l')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select([
        'l.id as id',
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.sku_id as sku_id',
        'l.qty as qty',
        'l.item_name as item_name',
        'l.is_stock_target as is_stock_target',
        's.sku_code as sku_code',
        sql<boolean>`l.qty > 0`.as('positive'),
      ])
      .where('l.sales_order_id', '=', orderId)
      .where('l.reservation_id', 'is', null)
      .orderBy('l.line_no', 'asc')
      .execute();

    const warnings: string[] = [];
    const over: string[] = [];
    const report = (lineNo: number, msg: string) => {
      if (opts.strict) over.push(msg);
      else warnings.push(`${lineNo}行目：引当在庫の枠を超えています（${msg}）`);
    };

    const hasChild = new Set(lines.map((l) => l.parent_line_no).filter((n): n is number => n !== null));
    // セット SKU の枠で扱ったセット行。その内訳商品の行は枠から減らさない（二重に減らさないため）
    const setHandled = new Set<number>();

    // 先にセット商品の行を見る。内訳商品の行を減らすかどうかがセット行の結果で決まるため。
    for (const line of lines) {
      if (line.line_type !== 'セット商品' || !line.sku_id || !line.positive) continue;

      const frame = await this.pickFrame(trx, scope, line.sku_id, line.qty);
      if (frame) {
        setHandled.add(line.line_no);
        if (!frame.enough) {
          report(line.line_no, `${line.sku_code ?? ''}（${line.item_name}）必要 ${trimQty(line.qty)} / 引当在庫の残り ${trimQty(frame.remaining)}`);
          continue;
        }
        await this.take(trx, frame.id, line.qty);
        await trx.updateTable('sales_order_lines').set({ reservation_id: frame.id }).where('id', '=', line.id).execute();
        continue;
      }

      // 内訳商品の行が付いていれば、その行が構成品の枠を減らす
      if (hasChild.has(line.line_no)) continue;

      // セット SKU の枠が無い手入力のセット行: 構成品の枠を「構成数 × セット数」ずつ減らす
      const components = await this.components(trx, line.sku_id, line.qty);
      let marker: number | null = null;
      for (const c of components) {
        const cf = await this.pickFrame(trx, scope, c.sku_id, c.need);
        if (!cf) continue;
        if (!cf.enough) {
          report(
            line.line_no,
            `${line.sku_code ?? ''}（${line.item_name}）の構成品 ${c.sku_code} 必要 ${trimQty(c.need)} / 引当在庫の残り ${trimQty(cf.remaining)}`,
          );
          continue;
        }
        await this.take(trx, cf.id, c.need);
        marker ??= cf.id;
      }
      // 受注明細には枠を1つしか結べない。構成品の枠を減らした印として、最初に減らした
      // 構成品の枠を結ぶ（セット SKU と違う SKU の枠を指していれば「構成品で減らした」と分かる）。
      if (marker !== null) {
        await trx.updateTable('sales_order_lines').set({ reservation_id: marker }).where('id', '=', line.id).execute();
      }
    }

    for (const line of lines) {
      if (!line.is_stock_target || !line.sku_id || !line.positive) continue;
      if (line.line_type === '内訳商品' && line.parent_line_no !== null && setHandled.has(line.parent_line_no)) continue;

      const frame = await this.pickFrame(trx, scope, line.sku_id, line.qty);
      if (!frame) continue;
      if (!frame.enough) {
        report(line.line_no, `${line.sku_code ?? ''}（${line.item_name}）必要 ${trimQty(line.qty)} / 引当在庫の残り ${trimQty(frame.remaining)}`);
        continue;
      }
      await this.take(trx, frame.id, line.qty);
      await trx.updateTable('sales_order_lines').set({ reservation_id: frame.id }).where('id', '=', line.id).execute();
    }

    if (over.length > 0) {
      throw new BadRequestException({
        message: '引当在庫（販売カテゴリーの枠）を超えています。枠を増やしてから登録してください',
        over,
      });
    }
    return warnings;
  }

  /**
   * 受注の明細が減らした分を枠に戻す。受注の修正・取消の前に呼ぶ。
   *
   * 構成品の枠で減らしたセット行は、受注明細に枠を1つしか結べないため、
   * 構成と当て方を引き直して戻す（結んだ枠と同じ確保の枠を優先）。
   * 途中でセット構成や確保の条件を変えると戻し先がずれることがある。
   */
  async restore(trx: Transaction<DB>, orderId: number): Promise<number> {
    const lines = await trx
      .selectFrom('sales_order_lines as l')
      .innerJoin('reservations as r', 'r.id', 'l.reservation_id')
      .select([
        'l.id as id',
        'l.qty as qty',
        'l.sku_id as sku_id',
        'l.reservation_id as reservation_id',
        'r.sku_id as frame_sku_id',
        'r.group_id as frame_group_id',
      ])
      .where('l.sales_order_id', '=', orderId)
      .execute();

    let scope: OrderScope | null = null;
    for (const line of lines) {
      if (line.sku_id === null || line.frame_sku_id === line.sku_id) {
        await this.giveBack(trx, line.reservation_id as number, line.qty);
      } else {
        // 構成品の枠で減らしたセット行
        scope ??= await this.orderScope(trx, orderId);
        const components = await this.components(trx, line.sku_id, line.qty);
        for (const c of components) {
          const frameId = await this.findTakenFrame(trx, scope, c.sku_id, c.need, line.frame_group_id);
          if (frameId !== null) await this.giveBack(trx, frameId, c.need);
        }
      }
      await trx.updateTable('sales_order_lines').set({ reservation_id: null }).where('id', '=', line.id).execute();
    }
    return lines.length;
  }

  private async orderScope(trx: Transaction<DB>, orderId: number): Promise<OrderScope> {
    const o = await trx
      .selectFrom('sales_orders as o')
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .select(['o.partner_id as partner_id', 'p.media_id as media_id', 'o.sales_category_id as sales_category_id', 'o.order_date as order_date'])
      .where('o.id', '=', orderId)
      .executeTakeFirstOrThrow();
    return o;
  }

  /** 受注が当たる枠の条件（Z-25）。r は reservations。 */
  private scopeSql(s: OrderScope) {
    return sql<boolean>`(r.sales_category_id = ${s.sales_category_id}
      and r.period_from <= ${s.order_date}::date and r.period_to >= ${s.order_date}::date
      and (r.partner_id = ${s.partner_id}
           or (r.partner_id is null and r.media_id = ${s.media_id}::bigint)
           or (r.partner_id is null and r.media_id is null)))`;
  }

  /** 当てる順。取引先指定 → 媒体指定 → どちらも無し。 */
  private readonly tierSql = sql<number>`(case when r.partner_id is not null then 1 when r.media_id is not null then 2 else 3 end)`;

  /**
   * 減らす枠を決めて行を押さえる。当たる枠が無ければ null。
   * いちばん優先の段（取引先指定など）の中で、残りが足りる枠を古い順に使う。
   * 段を下げて別の枠から減らすことはしない（取引先に取っておいた枠を使い切ったのに、
   * 媒体全体の枠を食ってしまうと、ほかの取引先の分が減るため）。
   */
  private async pickFrame(
    trx: Transaction<DB>,
    scope: OrderScope,
    skuId: number,
    need: string,
  ): Promise<{ id: number; remaining: string; enough: boolean } | null> {
    const rows = await trx
      .selectFrom('reservations as r')
      .select([
        'r.id as id',
        sql<string>`r.reserved_qty - r.consumed_qty`.as('remaining'),
        sql<boolean>`r.reserved_qty - r.consumed_qty >= ${need}::numeric`.as('enough'),
        this.tierSql.as('tier'),
      ])
      .where('r.sku_id', '=', skuId)
      .where(this.scopeSql(scope))
      .orderBy(this.tierSql)
      .orderBy('r.period_from', 'asc')
      .orderBy('r.id', 'asc')
      .forUpdate()
      .execute();
    if (rows.length === 0) return null;
    const top = rows.filter((r) => r.tier === rows[0].tier);
    return top.find((r) => r.enough) ?? top[0];
  }

  /** 構成品の枠を戻す先。結んだ枠と同じ確保を優先し、無ければ当て方で引き直す。 */
  private async findTakenFrame(
    trx: Transaction<DB>,
    scope: OrderScope,
    skuId: number,
    need: string,
    groupId: number | null,
  ): Promise<number | null> {
    const row = await trx
      .selectFrom('reservations as r')
      .select('r.id as id')
      .where('r.sku_id', '=', skuId)
      // 減らした分以上が使われている枠だけ（減らしていない枠に戻してしまわないため）
      .where(sql<boolean>`r.consumed_qty >= ${need}::numeric`)
      .where((eb) =>
        groupId === null ? this.scopeSql(scope) : eb.or([eb('r.group_id', '=', groupId), this.scopeSql(scope)]),
      )
      .orderBy(sql`(r.group_id is not distinct from ${groupId}::bigint) desc`)
      .orderBy(this.tierSql)
      .orderBy('r.period_from', 'asc')
      .orderBy('r.id', 'asc')
      .forUpdate()
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** セットの構成品と、セット数を掛けた必要数（掛け算は SQL で）。 */
  private components(trx: Transaction<DB>, setSkuId: number, setQty: string) {
    return trx
      .selectFrom('set_components as sc')
      .innerJoin('set_headers as h', 'h.id', 'sc.set_header_id')
      .innerJoin('skus as s', 's.id', 'sc.component_sku_id')
      .select([
        'sc.component_sku_id as sku_id',
        's.sku_code as sku_code',
        sql<string>`(${setQty}::numeric * sc.qty)::text`.as('need'),
      ])
      .where('h.sku_id', '=', setSkuId)
      .orderBy('sc.sort_order', 'asc')
      .orderBy('sc.id', 'asc')
      .execute();
  }

  private async take(trx: Transaction<DB>, frameId: number, qty: string): Promise<void> {
    await trx
      .updateTable('reservations')
      .set({ consumed_qty: sql<string>`consumed_qty + ${qty}::numeric`, updated_at: new Date() })
      .where('id', '=', frameId)
      .execute();
  }

  private async giveBack(trx: Transaction<DB>, frameId: number, qty: string): Promise<void> {
    await trx
      .updateTable('reservations')
      .set({ consumed_qty: sql<string>`greatest(consumed_qty - ${qty}::numeric, 0)`, updated_at: new Date() })
      .where('id', '=', frameId)
      .execute();
  }

  // ===========================================================================
  // 確保（見出し＋明細）の登録・変更・削除
  // ===========================================================================

  /** 見出しの決まり。画面の入力ミスを、データベースの英語のエラーより先に日本語で返す。 */
  private checkHeader(h: Pick<GroupHeaderInput, 'period_from' | 'period_to'>): void {
    if (h.period_to < h.period_from) throw new BadRequestException('販売期間の開始日が終了日より後になっています');
  }

  private checkLines(lines: GroupLineInput[]): void {
    if (lines.length === 0) throw new BadRequestException('明細（商品と確保数）を1行以上入力してください');
    const seen = new Map<number, number>();
    lines.forEach((l, i) => {
      const prev = seen.get(l.sku_id);
      if (prev !== undefined) throw new BadRequestException(`${i + 1}行目：同じ商品が ${prev}行目 にもあります。1つの確保に同じ商品は1行までです`);
      seen.set(l.sku_id, i + 1);
    });
  }

  /** 明細に写す見出しの値（受注の当て方を明細だけで引けるようにするため）。 */
  private scopeOf(g: { partner_id: number | null; media_id: number | null; sales_category_id: number; period_from: string; period_to: string }) {
    return {
      partner_id: g.partner_id,
      media_id: g.media_id,
      sales_category_id: g.sales_category_id,
      period_from: g.period_from,
      period_to: g.period_to,
    };
  }

  async createGroup(input: GroupHeaderInput & { lines: GroupLineInput[] }, userId: number) {
    this.checkHeader(input);
    this.checkLines(input.lines);

    const id = await this.db.transaction().execute(async (trx) => {
      const g = await trx
        .insertInto('reservation_groups')
        .values({
          period_from: input.period_from,
          period_to: input.period_to,
          media_id: input.media_id ?? null,
          partner_id: input.partner_id ?? null,
          sales_category_id: input.sales_category_id,
          item_label: input.item_label?.trim() || null,
          product_class_id: input.product_class_id ?? null,
          note: input.note?.trim() || null,
          created_by: userId,
          updated_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('reservations')
        .values(
          input.lines.map((l) => ({
            group_id: g.id,
            ...this.scopeOf(g),
            sku_id: l.sku_id,
            reserved_qty: l.reserved_qty,
            consumed_qty: '0',
            created_by: userId,
            updated_by: userId,
          })),
        )
        .execute();
      return g.id;
    });
    return this.findGroup(id);
  }

  /**
   * 確保の変更（Z-32）。見出し・明細のすべてを後から直せる。
   * lines を渡したときは「画面の明細がすべて」として扱い、載っていない明細は消す。
   * 使われている明細（使用数 > 0）は、消せない・商品を変えられない・使用数より減らせない。
   * 見出しを直したら明細にも写す（受注の当て方は明細の値で引くため）。
   * 判定はすべて行を押さえてから行い、駄目ならまとめて取り消す（途中まで保存されない）。
   */
  async updateGroup(id: number, input: Partial<GroupHeaderInput> & { lines?: GroupLineInput[] }, userId: number) {
    await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('reservation_groups').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException(`確保が見つかりません（ID: ${id}）`);

      const header = {
        period_from: input.period_from ?? cur.period_from,
        period_to: input.period_to ?? cur.period_to,
        media_id: input.media_id !== undefined ? input.media_id : cur.media_id,
        partner_id: input.partner_id !== undefined ? input.partner_id : cur.partner_id,
        sales_category_id: input.sales_category_id ?? cur.sales_category_id,
        item_label: input.item_label !== undefined ? input.item_label?.trim() || null : cur.item_label,
        product_class_id: input.product_class_id !== undefined ? input.product_class_id : cur.product_class_id,
        note: input.note !== undefined ? input.note?.trim() || null : cur.note,
      };
      this.checkHeader(header);

      const g = await trx
        .updateTable('reservation_groups')
        .set({ ...header, updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 明細の行を押さえる（受注の登録が同時に使用数を増やしても、判定がずれないように）。
      // 下の SKU との結合に FOR UPDATE を付けると SKU の行まで押さえてしまうので分ける。
      await trx.selectFrom('reservations').select('id').where('group_id', '=', id).forUpdate().execute();
      const existing = await trx
        .selectFrom('reservations as r')
        .innerJoin('skus as s', 's.id', 'r.sku_id')
        .select([
          'r.id as id',
          'r.sku_id as sku_id',
          's.sku_code as sku_code',
          'r.consumed_qty as consumed_qty',
          sql<boolean>`r.consumed_qty > 0 or exists (select 1 from sales_order_lines l where l.reservation_id = r.id)`.as('used'),
        ])
        .where('r.group_id', '=', id)
        .orderBy('r.id', 'asc')
        .execute();

      if (input.lines) {
        this.checkLines(input.lines);
        const byId = new Map(existing.map((e) => [e.id, e]));
        const keep = new Set<number>();
        input.lines.forEach((l, i) => {
          if (!l.id) return;
          const e = byId.get(l.id);
          if (!e) throw new BadRequestException(`${i + 1}行目：この確保の明細ではありません（ID: ${l.id}）`);
          if (e.used && e.sku_id !== l.sku_id) {
            throw new BadRequestException(`${i + 1}行目：${e.sku_code} はすでに受注で使われているため、商品は変えられません`);
          }
          keep.add(l.id);
        });

        // 先に消す。消した商品を別の行に入れ直したときに「同じ商品がある」で止まらないように。
        for (const e of existing) {
          if (keep.has(e.id)) continue;
          if (e.used) {
            throw new BadRequestException(`${e.sku_code} はすでに受注で ${trimQty(e.consumed_qty)} 使われているため、明細から消せません`);
          }
          await trx.deleteFrom('reservations').where('id', '=', e.id).execute();
        }

        for (const [i, l] of input.lines.entries()) {
          if (l.id) {
            const row = await trx
              .updateTable('reservations')
              .set({ sku_id: l.sku_id, reserved_qty: l.reserved_qty, updated_by: userId, updated_at: new Date() })
              .where('id', '=', l.id)
              .returning(['reserved_qty', 'consumed_qty', sql<boolean>`reserved_qty < consumed_qty`.as('short')])
              .executeTakeFirstOrThrow();
            if (row.short) {
              throw new BadRequestException(
                `${i + 1}行目：すでに ${trimQty(row.consumed_qty)} 使われているため、${trimQty(row.reserved_qty)} には減らせません`,
              );
            }
          } else {
            await trx
              .insertInto('reservations')
              .values({
                group_id: id,
                ...this.scopeOf(g),
                sku_id: l.sku_id,
                reserved_qty: l.reserved_qty,
                consumed_qty: '0',
                created_by: userId,
                updated_by: userId,
              })
              .execute();
          }
        }
      }

      // 見出しの値を明細へ写す
      await trx
        .updateTable('reservations')
        .set({ ...this.scopeOf(g), updated_by: userId, updated_at: new Date() })
        .where('group_id', '=', id)
        .execute();
    });
    return this.findGroup(id);
  }

  /** 確保の削除（Z-28）。明細が1つでも受注で使われていれば消せない。 */
  async removeGroup(id: number) {
    return this.db.transaction().execute(async (trx) => {
      const g = await trx.selectFrom('reservation_groups').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!g) throw new NotFoundException(`確保が見つかりません（ID: ${id}）`);
      // 同時に受注が使用数を増やしても判定がずれないよう、明細の行を押さえてから確かめる
      await trx.selectFrom('reservations').select('id').where('group_id', '=', id).forUpdate().execute();
      const used = await trx
        .selectFrom('reservations as r')
        .select(sql<string>`coalesce(sum(r.consumed_qty), 0)`.as('consumed'))
        .select(sql<boolean>`bool_or(r.consumed_qty > 0 or exists (select 1 from sales_order_lines l where l.reservation_id = r.id))`.as('used'))
        .where('r.group_id', '=', id)
        .executeTakeFirstOrThrow();
      if (used.used) {
        throw new BadRequestException(
          `この確保はすでに受注で ${trimQty(used.consumed)} 使われているため削除できません。確保数を直してください`,
        );
      }
      // 明細は ON DELETE CASCADE で一緒に消える
      await trx.deleteFrom('reservation_groups').where('id', '=', id).execute();
      return { id, deleted: true };
    });
  }

  // ---- 明細1行ずつの経路（/inventory/reservations。2026-10-09 より前の画面・smoke との互換） ----

  /**
   * 明細1行の確保数・期間の変更。期間は見出しのものなので、見出しごと直して明細に写す
   * （以前の枠は「1件＝1確保」で作られているので、見出しを直しても他の明細には響かない）。
   */
  async updateLine(id: number, values: { reserved_qty?: string; period_to?: string; note?: string | null }, userId: number) {
    if (values.reserved_qty === undefined && values.period_to === undefined && values.note === undefined) {
      throw new BadRequestException('更新する項目がありません');
    }
    return this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('reservations').select(['id', 'group_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException(`確保数が見つかりません（ID: ${id}）`);

      if (values.period_to !== undefined && cur.group_id !== null) {
        const before = await trx
          .selectFrom('reservation_groups')
          .select('period_from')
          .where('id', '=', cur.group_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        this.checkHeader({ period_from: before.period_from, period_to: values.period_to });
        const g = await trx
          .updateTable('reservation_groups')
          .set({ period_to: values.period_to, updated_by: userId, updated_at: new Date() })
          .where('id', '=', cur.group_id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx.updateTable('reservations').set(this.scopeOf(g)).where('group_id', '=', g.id).execute();
      }

      const row = await trx
        .updateTable('reservations')
        .set({
          ...(values.reserved_qty !== undefined ? { reserved_qty: values.reserved_qty } : {}),
          ...(values.period_to !== undefined ? { period_to: values.period_to } : {}),
          ...(values.note !== undefined ? { note: values.note } : {}),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // 使用数を下回る枠には減らせない。書いたあとでもトランザクションの中なので、ここで止めれば取り消される。
      const short = await trx
        .selectFrom('reservations')
        .select(sql<boolean>`reserved_qty < consumed_qty`.as('short'))
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (short.short) {
        throw new BadRequestException(`すでに ${trimQty(row.consumed_qty)} 使われているため、${trimQty(row.reserved_qty)} には減らせません`);
      }
      return row;
    });
  }

  /** 明細1行の削除。まだ受注に使われていない明細だけ。確保に明細が残らなければ見出しも消す。 */
  async removeLine(id: number) {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('reservations as r')
        .select(['r.id as id', 'r.group_id as group_id', 'r.consumed_qty as consumed_qty'])
        .select(sql<boolean>`r.consumed_qty > 0 or exists (select 1 from sales_order_lines l where l.reservation_id = r.id)`.as('used'))
        .where('r.id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException(`確保数が見つかりません（ID: ${id}）`);
      if (row.used) throw new BadRequestException('すでに受注で使われている枠は消せません。数量を直してください');
      await trx.deleteFrom('reservations').where('id', '=', id).execute();
      if (row.group_id !== null) {
        const left = await trx.selectFrom('reservations').select('id').where('group_id', '=', row.group_id).executeTakeFirst();
        if (!left) await trx.deleteFrom('reservation_groups').where('id', '=', row.group_id).execute();
      }
      return { id, deleted: true };
    });
  }

  /**
   * 前月（任意の月）の確保を翌月分として複写する。毎月の登録を数量の見直しだけで済ませるため。
   * 見出しごとに写し、明細も一緒に写す（使用数は 0 から）。期間は複写先の 1日〜末日にする。
   * 複写先の月に同じ見出し（媒体・取引先・販売カテゴリー・項目・商品分類・備考）の確保が
   * すでにあれば、その数だけ飛ばす（2回押しても二重にならないように）。
   */
  async copyMonth(input: { from_month: string; to_month: string }, userId: number) {
    const [fy, fm] = input.from_month.split('-').map(Number);
    const [ty, tm] = input.to_month.split('-').map(Number);
    const fromStart = `${input.from_month}-01`;
    const fromEnd = `${input.from_month}-${String(new Date(Date.UTC(fy, fm, 0)).getUTCDate()).padStart(2, '0')}`;
    const toStart = `${input.to_month}-01`;
    const toEnd = `${input.to_month}-${String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0')}`;

    const keyOf = (g: { media_id: number | null; partner_id: number | null; sales_category_id: number; item_label: string | null; product_class_id: number | null; note: string | null }) =>
      JSON.stringify([g.media_id, g.partner_id, g.sales_category_id, g.item_label ?? '', g.product_class_id, g.note ?? '']);

    return this.db.transaction().execute(async (trx) => {
      const sources = await trx
        .selectFrom('reservation_groups')
        .selectAll()
        .where('period_from', '>=', fromStart)
        .where('period_from', '<=', fromEnd)
        .orderBy('id', 'asc')
        .execute();
      const targets = await trx
        .selectFrom('reservation_groups')
        .selectAll()
        .where('period_from', '=', toStart)
        .execute();
      const already = new Map<string, number>();
      for (const t of targets) already.set(keyOf(t), (already.get(keyOf(t)) ?? 0) + 1);

      let copied = 0;
      let skipped = 0;
      let lines = 0;
      for (const s of sources) {
        const k = keyOf(s);
        const n = already.get(k) ?? 0;
        if (n > 0) {
          already.set(k, n - 1);
          skipped += 1;
          continue;
        }
        const g = await trx
          .insertInto('reservation_groups')
          .values({
            period_from: toStart,
            period_to: toEnd,
            media_id: s.media_id,
            partner_id: s.partner_id,
            sales_category_id: s.sales_category_id,
            item_label: s.item_label,
            product_class_id: s.product_class_id,
            note: s.note,
            created_by: userId,
            updated_by: userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const src = await trx
          .selectFrom('reservations')
          .select(['sku_id', 'reserved_qty', 'note'])
          .where('group_id', '=', s.id)
          .orderBy('id', 'asc')
          .execute();
        if (src.length > 0) {
          await trx
            .insertInto('reservations')
            .values(
              src.map((r) => ({
                group_id: g.id,
                ...this.scopeOf(g),
                sku_id: r.sku_id,
                reserved_qty: r.reserved_qty,
                consumed_qty: '0',
                note: r.note,
                created_by: userId,
                updated_by: userId,
              })),
            )
            .execute();
        }
        copied += 1;
        lines += src.length;
      }
      return { from_month: input.from_month, to_month: input.to_month, copied, skipped, lines };
    });
  }

  // ===========================================================================
  // 参照（一覧・詳細・CSV・商品の候補）
  // ===========================================================================

  /** 絞り込みに合う確保の見出し。 */
  private groupQuery(f: Omit<GroupListFilter, 'limit' | 'offset'>) {
    let q = this.db
      .selectFrom('reservation_groups as g')
      .leftJoin('partners as p', 'p.id', 'g.partner_id')
      .leftJoin('media as m', 'm.id', 'g.media_id')
      // 見出しの媒体が空でも、取引先の媒体（取引先マスタ）を一覧に出すため
      .leftJoin('media as pm', 'pm.id', 'p.media_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'g.sales_category_id')
      .leftJoin('product_classes as pc', 'pc.id', 'g.product_class_id');
    if (f.from) q = q.where('g.period_to', '>=', f.from);
    if (f.to) q = q.where('g.period_from', '<=', f.to);
    if (f.sales_category_id !== undefined) q = q.where('g.sales_category_id', '=', f.sales_category_id);
    if (f.partner_id !== undefined) q = q.where('g.partner_id', '=', f.partner_id);
    // 媒体は、見出しの媒体か、見出しの取引先の媒体（取引先マスタ）で絞る
    if (f.media_id !== undefined) {
      const mid = f.media_id;
      q = q.where((eb) => eb.or([eb('g.media_id', '=', mid), eb('p.media_id', '=', mid)]));
    }
    if (f.sku_id !== undefined) {
      q = q.where(sql<boolean>`exists (select 1 from reservations r2 where r2.group_id = g.id and r2.sku_id = ${f.sku_id})`);
    }
    if (f.q) {
      const like = `%${f.q}%`;
      q = q.where(sql<boolean>`exists (
        select 1 from reservations r2
          join skus s2 on s2.id = r2.sku_id
          join products p2 on p2.id = s2.product_id
         where r2.group_id = g.id
           and (s2.sku_code ilike ${like} or s2.sku_name ilike ${like} or p2.product_code ilike ${like} or p2.product_name ilike ${like}))`);
    }
    return q;
  }

  private groupColumns() {
    return [
      'g.id as id',
      'g.period_from as period_from',
      'g.period_to as period_to',
      'g.media_id as media_id',
      'm.name as media_name',
      'pm.name as partner_media_name',
      'g.partner_id as partner_id',
      'p.partner_code as partner_code',
      'p.name1 as partner_name',
      'g.sales_category_id as sales_category_id',
      'sc.name as sales_category_name',
      'g.item_label as item_label',
      'g.note as note',
      'g.product_class_id as product_class_id',
      'pc.code as product_class_code',
      'pc.name as product_class_name',
      sql<string>`(select coalesce(sum(r.reserved_qty), 0) from reservations r where r.group_id = g.id)`.as('reserved_total'),
      sql<string>`(select coalesce(sum(r.consumed_qty), 0) from reservations r where r.group_id = g.id)`.as('consumed_total'),
    ] as const;
  }

  /** 明細。商品名は SKU の商品名があればそれ、無ければ商品名＋カラー・サイズ（M-10 と同じ決まり）。 */
  private async linesOf(groupIds: number[]): Promise<LineRow[]> {
    if (groupIds.length === 0) return [];
    return this.db
      .selectFrom('reservations as r')
      .innerJoin('skus as s', 's.id', 'r.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .select([
        'r.id as id',
        sql<number>`r.group_id`.as('group_id'),
        'r.sku_id as sku_id',
        's.sku_code as sku_code',
        sql<string>`coalesce(nullif(btrim(s.sku_name), ''), concat_ws(' ', pr.product_name, c.name, z.name))`.as('item_name'),
        'c.name as color_name',
        'z.name as size_name',
        'r.reserved_qty as reserved_qty',
        'r.consumed_qty as consumed_qty',
        sql<string>`r.reserved_qty - r.consumed_qty`.as('remaining_qty'),
      ])
      .where('r.group_id', 'in', groupIds)
      .orderBy('r.group_id', 'asc')
      .orderBy('r.id', 'asc')
      .execute();
  }

  /** 一覧（Z-30）。確保ごとに見出し＋明細＋確保数合計・使用数合計。ページ送りは確保の単位。 */
  async listGroups(f: GroupListFilter) {
    const base = this.groupQuery(f);
    const [groups, total, sum] = await Promise.all([
      base
        .select(this.groupColumns())
        .orderBy('g.period_from', 'desc')
        .orderBy('g.id', 'asc')
        .limit(f.limit)
        .offset(f.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
      this.db
        .selectFrom('reservations as r')
        .select([
          sql<string>`coalesce(sum(r.reserved_qty), 0)`.as('reserved'),
          sql<string>`coalesce(sum(r.consumed_qty), 0)`.as('consumed'),
          sql<string>`coalesce(sum(r.reserved_qty - r.consumed_qty), 0)`.as('remaining'),
        ])
        .where('r.group_id', 'in', base.select('g.id'))
        .executeTakeFirstOrThrow(),
    ]);
    const lines = await this.linesOf(groups.map((g) => g.id));
    const items = groups.map((g) => ({ ...g, lines: lines.filter((l) => l.group_id === g.id) }));
    return { items, total: Number(total.n), limit: f.limit, offset: f.offset, summary: sum };
  }

  async findGroup(id: number) {
    const g = await this.groupQuery({}).select(this.groupColumns()).where('g.id', '=', id).executeTakeFirst();
    if (!g) throw new NotFoundException(`確保が見つかりません（ID: ${id}）`);
    return { ...g, lines: await this.linesOf([id]) };
  }

  /** 一覧の CSV（Z-29）。一覧と同じ列の並びで、1明細1行（見出しの列は各行に繰り返す）。 */
  async exportCsv(f: Omit<GroupListFilter, 'limit' | 'offset'>): Promise<string> {
    const groups = await this.groupQuery(f)
      .select(this.groupColumns())
      .orderBy('g.period_from', 'desc')
      .orderBy('g.id', 'asc')
      .execute();
    const lines = await this.linesOf(groups.map((g) => g.id));

    const header = [
      '販売期間',
      '媒体',
      '取引先',
      '販売カテゴリー',
      '項目',
      '備考',
      '商品分類コード',
      '商品分類',
      '商品コード',
      '商品名',
      '確保数',
      '使用数',
      '残り',
      '確保数合計',
      '使用数合計',
    ];
    const esc = (v: string | null | undefined): string => `"${(v ?? '').replace(/"/g, '""')}"`;
    const out = [header.map((h) => esc(h)).join(',')];
    for (const g of groups) {
      const head = [
        esc(`${slash(g.period_from)}〜${slash(g.period_to)}`),
        esc(g.media_name ?? g.partner_media_name),
        esc(g.partner_name),
        esc(g.sales_category_name),
        esc(g.item_label),
        esc(g.note),
        esc(g.product_class_code),
        esc(g.product_class_name),
      ];
      for (const l of lines.filter((x) => x.group_id === g.id)) {
        out.push(
          [
            ...head,
            esc(l.sku_code),
            esc(l.item_name),
            trimQty(l.reserved_qty),
            trimQty(l.consumed_qty),
            trimQty(l.remaining_qty),
            trimQty(g.reserved_total),
            trimQty(g.consumed_total),
          ].join(','),
        );
      }
    }
    // Excel がそのまま開けるように BOM 付き・CRLF（ほかの CSV 出力と同じ）
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  /**
   * 明細の商品の候補。商品分類を渡すとその分類の商品だけ（Z-26）。
   * 商品マスタの SKU 検索と違い、SKU の商品名・カラー・サイズと商品分類を返す。
   */
  async skuOptions(f: { q?: string; product_class_id?: number; limit: number }) {
    let q = this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .where('s.is_active', '=', true)
      .where('p.is_active', '=', true);
    if (f.product_class_id !== undefined) q = q.where('p.product_class_id', '=', f.product_class_id);
    if (f.q) {
      const like = `%${f.q}%`;
      q = q.where((eb) =>
        eb.or([
          eb('s.sku_code', 'ilike', like),
          eb('s.jan', 'ilike', like),
          eb('s.sku_name', 'ilike', like),
          eb('p.product_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
        ]),
      );
    }
    return q
      .select([
        's.id as sku_id',
        's.sku_code as sku_code',
        sql<string>`coalesce(nullif(btrim(s.sku_name), ''), p.product_name)`.as('product_name'),
        'c.name as color_name',
        'z.name as size_name',
        'p.is_set as is_set',
        'p.product_class_id as product_class_id',
      ])
      .orderBy('s.sku_code', 'asc')
      .limit(f.limit)
      .execute();
  }
}

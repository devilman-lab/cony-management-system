import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';

import { CONSTRAINT_MESSAGES } from '../common/database-exception.filter';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';
import { AllocationService } from '../shipping/allocation.service';

/**
 * 受注一覧（2026-10-13 受注処理編 O-15〜O-22）。
 *
 * 一覧を作り直したもの。受注の登録・修正（orders.service）とは分け、経路も /order-list にしてある。
 *   - 列: 受注日を外し、納品日・納品時間を足す（O-15）
 *   - キーワード（O-16）、出荷日の範囲（O-17）、状態・区分を複数、並び（出荷日の新しい順／受注番号の新しい順）（O-18）
 *   - 列ごとの絞り込み（Excel のフィルターのように、値の一覧に件数を添える）（O-20）
 *   - 明細・出荷依頼書／納品書の備考・適用を一緒に返す（O-21）
 *   - 選んだ受注をまとめて引き当てる（O-19）、一覧のまま出荷日・納品日・備考・適用を直す（O-22）
 */

/** 受注区分。絞り込みの選択肢は件数が 0 でもすべて出す（O-02「卸・直送・通販・社内移動・サンプル・返品」） */
export const ORDER_TYPES = ['卸', '直送', '通販', '社内移動', 'サンプル', '返品'] as const;
/** 状態。取消は「取消も表示」で出し分けるので、状態の絞り込みの選択肢には入れない */
export const ORDER_STATUSES = ['未確定', '引当待ち', '引当済', '出荷指示済', '出荷済'] as const;

/** 値の一覧で絞る列（O-20）。none は「値が空」（取引先の無いサンプルなど） */
export type FacetField = 'type' | 'partner' | 'destination' | 'category' | 'staff' | 'status';

export interface IdFilter {
  ids: number[];
  /** 値が空のもの（'none'）も含める */
  none: boolean;
}

export interface OrderListFilters {
  q?: string;
  /** 状態（複数）。'取消' を含めると取消も出す */
  status?: string[];
  order_type?: string[];
  partner_ids?: IdFilter;
  destination_ids?: IdFilter;
  sales_category_ids?: IdFilter;
  sales_staff_ids?: IdFilter;
  ship_from?: string;
  ship_to?: string;
  delivery_from?: string;
  delivery_to?: string;
  include_cancelled?: boolean;
}

export interface OrderListQuery extends OrderListFilters {
  /** ship_date＝出荷日の新しい順（空は後、同じなら受注番号の新しい順。既定）／order_no＝受注番号の新しい順（O-18） */
  sort: 'ship_date' | 'order_no';
  /** ページの受注の明細を一緒に返す（O-21） */
  with_lines: boolean;
  limit: number;
  offset: number;
}

export interface Facet {
  value: string;
  label: string;
  /** 取引先・納品先のコード（値の一覧の検索と見分けに使う） */
  code?: string | null;
  count: number;
}

export interface BulkAllocateResult {
  order_id: number;
  order_no: string;
  /** 引当のあとの状態（引当済／引当待ち）。エラーのときは今の状態 */
  status: string;
  /** 有効在庫が足りず引き当てられなかった分 */
  shortages: string[];
  error: string | null;
}

/** 一覧のまま直せる項目（O-22）。渡した項目だけ直す。引当には触らない */
export interface OrderListPatch {
  ship_date?: string | null;
  delivery_date?: string | null;
  delivery_time_code_id?: number | null;
  shipping_remarks?: string | null;
  delivery_note_remarks?: string | null;
  lines?: { id: number; shipping_note?: string | null; delivery_slip_note?: string | null }[];
}

/** 一覧の土台。取引先・販売カテゴリーは空のことがある（サンプル・社内移動）ので外部結合 */
function baseQuery(db: ConyDatabase) {
  return db
    .selectFrom('sales_orders as o')
    .leftJoin('partners as p', 'p.id', 'o.partner_id')
    .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
    .leftJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
    .leftJoin('sales_staff as su', 'su.id', 'o.sales_staff_id')
    .leftJoin('codes as dt', 'dt.id', 'o.delivery_time_code_id');
}
type OrderListBase = ReturnType<typeof baseQuery>;

/** キーワードは空白（全角も）で区切り、すべてを含む受注を出す。LIKE の記号（% _ \）は文字として探す */
function keywordTokens(q: string | undefined): string[] {
  return (q ?? '')
    .split(/[\s　]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 5)
    .map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** 「この ID のどれか、または空」の条件 */
function idFilterSql(column: string, filter: IdFilter): RawBuilder<SqlBool> {
  const ref = sql.ref(column);
  const parts: RawBuilder<SqlBool>[] = [];
  if (filter.ids.length > 0) parts.push(sql<SqlBool>`${ref} in (${sql.join(filter.ids)})`);
  if (filter.none) parts.push(sql<SqlBool>`${ref} is null`);
  if (parts.length === 0) return sql<SqlBool>`true`;
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

/**
 * 絞り込みを当てる。skip は値の一覧（facets）を数えるときの自分の列で、その列の絞り込みだけ外して数える
 * （Excel のフィルターと同じ。ほかの列で絞った中に、その列のどの値が何件あるか）。
 */
function applyFilters(qb: OrderListBase, f: OrderListFilters, skip?: FacetField): OrderListBase {
  // キーワード（O-16）: 受注番号・先方発注番号・取引先・納品先・お届け先・備考と、明細の商品コード・品名・JAN
  for (const like of keywordTokens(f.q)) {
    qb = qb.where((eb) =>
      eb.or([
        eb('o.order_no', 'ilike', like),
        eb('o.po_no', 'ilike', like),
        eb('p.partner_code', 'ilike', like),
        eb('p.name1', 'ilike', like),
        eb('p.short_name', 'ilike', like),
        eb('d.delivery_code', 'ilike', like),
        eb('d.name', 'ilike', like),
        eb('o.direct_name', 'ilike', like),
        eb('o.shipping_remarks', 'ilike', like),
        eb('o.delivery_note_remarks', 'ilike', like),
        eb.exists(
          eb
            .selectFrom('sales_order_lines as kl')
            .leftJoin('skus as ks', 'ks.id', 'kl.sku_id')
            .select(sql<number>`1`.as('x'))
            .whereRef('kl.sales_order_id', '=', 'o.id')
            .where((e2) =>
              e2.or([
                e2('ks.sku_code', 'ilike', like),
                e2('kl.item_name', 'ilike', like),
                e2('ks.jan', 'ilike', like),
                // 得意先別商品の出荷JAN・先方JAN（この受注の取引先の、明細の商品の行）
                e2.exists(
                  e2
                    .selectFrom('partner_products as kp')
                    .select(sql<number>`1`.as('y'))
                    .whereRef('kp.sku_id', '=', 'kl.sku_id')
                    .whereRef('kp.partner_id', '=', 'o.partner_id')
                    .where((e3) => e3.or([e3('kp.shipping_jan', 'ilike', like), e3('kp.partner_jan', 'ilike', like)])),
                ),
              ]),
            ),
        ),
      ]),
    );
  }

  // 状態（O-18）。取消は「取消も表示」のときだけ（状態の一覧で取消を選んだときも）出す。
  // 状態の値の一覧は取消を除いて数える（取消は「取消も表示」で出し分ける）
  if (skip === 'status') {
    qb = qb.where('o.is_cancelled', '=', false);
  } else {
    const list = f.status ?? [];
    const active = list.filter((s) => s !== '取消');
    const showCancelled = f.include_cancelled === true || list.includes('取消');
    if (list.length === 0) {
      if (!showCancelled) qb = qb.where('o.is_cancelled', '=', false);
    } else {
      qb = qb.where((eb) => {
        const parts: Expression<SqlBool>[] = [];
        if (active.length > 0) parts.push(eb.and([eb('o.is_cancelled', '=', false), eb('o.status', 'in', active)]));
        if (showCancelled) parts.push(eb('o.is_cancelled', '=', true));
        return parts.length > 0 ? eb.or(parts) : sql<SqlBool>`false`;
      });
    }
  }

  if (skip !== 'type' && f.order_type && f.order_type.length > 0) qb = qb.where('o.order_type', 'in', f.order_type);
  if (skip !== 'partner' && f.partner_ids) qb = qb.where(idFilterSql('o.partner_id', f.partner_ids));
  if (skip !== 'destination' && f.destination_ids) qb = qb.where(idFilterSql('o.delivery_destination_id', f.destination_ids));
  if (skip !== 'category' && f.sales_category_ids) qb = qb.where(idFilterSql('o.sales_category_id', f.sales_category_ids));
  if (skip !== 'staff' && f.sales_staff_ids) qb = qb.where(idFilterSql('o.sales_staff_id', f.sales_staff_ids));

  // 出荷日（O-17）・納品日の範囲
  if (f.ship_from) qb = qb.where('o.ship_date', '>=', f.ship_from);
  if (f.ship_to) qb = qb.where('o.ship_date', '<=', f.ship_to);
  if (f.delivery_from) qb = qb.where('o.delivery_date', '>=', f.delivery_from);
  if (f.delivery_to) qb = qb.where('o.delivery_date', '<=', f.delivery_to);
  return qb;
}

/** 一覧の1行の列 */
function selectRow(qb: OrderListBase) {
  return qb.select([
    'o.id as id',
    'o.order_no as order_no',
    'o.order_type as order_type',
    'o.status as status',
    'o.is_cancelled as is_cancelled',
    'o.is_billable as is_billable',
    'o.po_no as po_no',
    'o.partner_id as partner_id',
    'p.partner_code as partner_code',
    'p.name1 as partner_name',
    'o.delivery_destination_id as delivery_destination_id',
    'd.delivery_code as delivery_code',
    // 納品先が無い受注（直送・サンプル・社内移動）はお届け先のお名前
    sql<string | null>`coalesce(d.name, o.direct_name)`.as('delivery_name'),
    'o.direct_name as direct_name',
    'o.sales_category_id as sales_category_id',
    'sc.name as sales_category_name',
    'o.sales_staff_id as sales_staff_id',
    'su.name as staff_name',
    // 返品は明細がマイナスなので合計もマイナス
    (eb) =>
      eb
        .selectFrom('sales_order_lines as l')
        .select(sql<string>`coalesce(sum(l.amount), 0)`.as('a'))
        .whereRef('l.sales_order_id', '=', 'o.id')
        .as('total_amount'),
    // 通貨（取引先の通貨で固定。2026-10-12 No.39）
    'o.currency as currency',
    'o.ship_date as ship_date',
    'o.delivery_date as delivery_date',
    'o.delivery_time_code_id as delivery_time_code_id',
    'dt.name as delivery_time_name',
    'o.shipping_remarks as shipping_remarks',
    'o.delivery_note_remarks as delivery_note_remarks',
    // 出荷確定・帳票の対象になる出荷（引当済みのとき1件）
    (eb) =>
      eb
        .selectFrom('shipments as sh')
        .select('sh.id')
        .whereRef('sh.sales_order_id', '=', 'o.id')
        .where('sh.status', '<>', '削除')
        .orderBy('sh.id', 'desc')
        .limit(1)
        .as('shipment_id'),
    (eb) =>
      eb
        .selectFrom('shipments as sh')
        .select('sh.status')
        .whereRef('sh.sales_order_id', '=', 'o.id')
        .where('sh.status', '<>', '削除')
        .orderBy('sh.id', 'desc')
        .limit(1)
        .as('shipment_status'),
  ]);
}

type OrderListRow = Awaited<ReturnType<ReturnType<typeof selectRow>['executeTakeFirstOrThrow']>>;

/**
 * 明細の JAN（出荷依頼書・納品書と同じ。2026-10-09 マスター編② M-18・M3-26）。
 * 得意先別商品の出荷JAN → SKU の JAN（コニーJAN）の順。明細が得意先別商品を指していればその行だけを、
 * 指していなければ取引先×SKU で引く。空白だけの出荷JANは空とみなす。
 */
const lineJanExpr = sql<string | null>`coalesce(
  case when l.partner_product_id is not null
    then (select nullif(btrim(pp.shipping_jan), '') from partner_products pp where pp.id = l.partner_product_id)
    else (select nullif(btrim(pp2.shipping_jan), '') from partner_products pp2
      where pp2.partner_id = o.partner_id and pp2.sku_id = l.sku_id
        and nullif(btrim(pp2.shipping_jan), '') is not null
      order by pp2.is_active desc, pp2.id limit 1) end,
  s.jan)`;

/** 例外を、まとめて引当の結果に書く文にする */
function errorText(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const body = r as { message?: unknown; over?: unknown; shortages?: unknown; details?: unknown };
    const msg = Array.isArray(body.message)
      ? body.message.map(String).join('、')
      : typeof body.message === 'string'
        ? body.message
        : e.message;
    const extra = [body.over, body.shortages, body.details].flatMap((v) => (Array.isArray(v) ? v.map(String) : []));
    return extra.length > 0 ? `${msg}（${extra.join('、')}）` : msg;
  }
  const pg = e as { code?: string; constraint?: string };
  if (pg?.code === '23514' && pg.constraint && CONSTRAINT_MESSAGES[pg.constraint]) return CONSTRAINT_MESSAGES[pg.constraint];
  return '処理中に問題が起きました。時間をおいて試すか、担当者にお知らせください';
}

@Injectable()
export class OrderListService {
  private readonly logger = new Logger('OrderListService');

  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly allocation: AllocationService,
  ) {}

  /** 一覧（O-15〜O-18・O-20・O-21）。件数は絞り込んだ受注の全体の件数 */
  async list(query: OrderListQuery): Promise<Paged<Record<string, unknown>>> {
    const base = applyFilters(baseQuery(this.db), query);
    let rowsQuery = selectRow(base);
    rowsQuery =
      query.sort === 'order_no'
        ? rowsQuery.orderBy('o.order_no', 'desc')
        : rowsQuery.orderBy('o.ship_date', sql`desc nulls last`).orderBy('o.order_no', 'desc');

    const [rows, total] = await Promise.all([
      rowsQuery.limit(query.limit).offset(query.offset).execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    const items: Record<string, unknown>[] = query.with_lines ? await this.withLines(rows) : rows;
    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /** 1件（一覧のまま直したあとに、その行を描き直すため） */
  async row(id: number): Promise<Record<string, unknown>> {
    const row = await selectRow(baseQuery(this.db).where('o.id', '=', id)).executeTakeFirst();
    if (!row) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);
    return (await this.withLines([row]))[0];
  }

  /** 受注の行に明細（lines）を付ける */
  private async withLines(rows: OrderListRow[]): Promise<Record<string, unknown>[]> {
    const ids = rows.map((r) => r.id);
    const byOrder = new Map<number, Record<string, unknown>[]>();
    if (ids.length > 0) {
      const lines = await this.db
        .selectFrom('sales_order_lines as l')
        .innerJoin('sales_orders as o', 'o.id', 'l.sales_order_id')
        .leftJoin('skus as s', 's.id', 'l.sku_id')
        .leftJoin('colors as cl', 'cl.id', 's.color_id')
        .leftJoin('sizes as sz', 'sz.id', 's.size_id')
        .select([
          'l.sales_order_id as sales_order_id',
          'l.id as id',
          'l.line_no as line_no',
          'l.parent_line_no as parent_line_no',
          'l.line_type as line_type',
          's.sku_code as sku_code',
          'l.item_name as item_name',
          'cl.name as color_name',
          'sz.name as size_name',
          lineJanExpr.as('jan'),
          // 返品はマイナスのまま返す（一覧では返品と分かるようにそのまま出す）
          'l.qty as qty',
          'l.unit_price as unit_price',
          'l.amount as amount',
          'l.shipping_note as shipping_note',
          'l.delivery_slip_note as delivery_slip_note',
        ])
        .where('l.sales_order_id', 'in', ids)
        .orderBy('l.sales_order_id')
        .orderBy('l.line_no')
        .execute();
      for (const { sales_order_id, ...line } of lines) {
        const list = byOrder.get(sales_order_id) ?? [];
        list.push(line);
        byOrder.set(sales_order_id, list);
      }
    }
    return rows.map((r) => ({ ...r, lines: byOrder.get(r.id) ?? [] }));
  }

  /**
   * 列の絞り込みの値の一覧（O-20）。[{ value, label, count }]。
   * その列の絞り込みだけ外し、ほかの絞り込みを当てた中で数える（Excel のフィルターと同じ）。
   * 区分・状態は件数が 0 の値も並べる（選べる値がいつも同じに見えるように）。
   */
  async facets(field: FacetField, f: OrderListFilters): Promise<Facet[]> {
    const qb = applyFilters(baseQuery(this.db), f, field);
    const n = sql<number>`count(*)::int`;

    if (field === 'type' || field === 'status') {
      const col = sql.ref(field === 'type' ? 'o.order_type' : 'o.status');
      const rows = await qb.select([sql<string>`${col}`.as('v'), n.as('n')]).groupBy(col).execute();
      const counts = new Map(rows.map((r) => [r.v, Number(r.n)]));
      const known: readonly string[] = field === 'type' ? ORDER_TYPES : ORDER_STATUSES;
      const values = [...known, ...rows.map((r) => r.v).filter((v) => !known.includes(v))];
      return values.map((v) => ({ value: v, label: v, count: counts.get(v) ?? 0 }));
    }

    if (field === 'partner') {
      const rows = await qb
        .select([sql<string>`coalesce(o.partner_id::text, 'none')`.as('v'), 'p.partner_code as code', 'p.name1 as name', n.as('n')])
        .groupBy(['o.partner_id', 'p.partner_code', 'p.name1'])
        .orderBy(sql`o.partner_id is null`)
        .orderBy('p.partner_code')
        .execute();
      return rows.map((r) => ({ value: r.v, label: r.name ?? '（取引先なし）', code: r.code, count: Number(r.n) }));
    }

    if (field === 'destination') {
      const rows = await qb
        .select([sql<string>`coalesce(o.delivery_destination_id::text, 'none')`.as('v'), 'd.delivery_code as code', 'd.name as name', n.as('n')])
        .groupBy(['o.delivery_destination_id', 'd.delivery_code', 'd.name'])
        .orderBy(sql`o.delivery_destination_id is null`)
        .orderBy('d.delivery_code')
        .execute();
      return rows.map((r) => ({
        value: r.v,
        label: r.name ?? '（納品先なし：お届け先）',
        code: r.code,
        count: Number(r.n),
      }));
    }

    if (field === 'category') {
      const rows = await qb
        .select([sql<string>`coalesce(o.sales_category_id::text, 'none')`.as('v'), 'sc.name as name', n.as('n')])
        .groupBy(['o.sales_category_id', 'sc.name', 'sc.sort_order', 'sc.code'])
        .orderBy(sql`o.sales_category_id is null`)
        .orderBy('sc.sort_order', sql`asc nulls last`)
        .orderBy('sc.code')
        .execute();
      return rows.map((r) => ({ value: r.v, label: r.name ?? '（なし）', count: Number(r.n) }));
    }

    // 販売担当
    const rows = await qb
      .select([sql<string>`coalesce(o.sales_staff_id::text, 'none')`.as('v'), 'su.name as name', n.as('n')])
      .groupBy(['o.sales_staff_id', 'su.name', 'su.sort_order', 'su.code'])
      .orderBy(sql`o.sales_staff_id is null`)
      .orderBy('su.sort_order', sql`asc nulls last`)
      .orderBy('su.code')
      .execute();
    return rows.map((r) => ({ value: r.v, label: r.name ?? '（未設定）', count: Number(r.n) }));
  }

  /** 納品時間の選択肢（区分値 DELIVERY_TIME。編集モードの欄に使う。O-03・O-22） */
  deliveryTimes() {
    return this.db
      .selectFrom('codes as c')
      .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
      .select(['c.id as id', 'c.code as code', 'c.name as name'])
      .where('cc.code', '=', 'DELIVERY_TIME')
      .where('c.is_active', '=', true)
      .orderBy('c.sort_order', sql`asc nulls last`)
      .orderBy('c.code')
      .execute();
  }

  /**
   * まとめて引当（O-19）。出荷日の早い順（空は後）・同じなら受注番号順に、1件ずつ引き当てる。
   * 1件ごとに自分のトランザクション（AllocationService.reallocate）なので、ある受注が失敗しても
   * ほかの受注はそのまま続け、受注ごとの結果を返す（引当済／引当待ち（足りない内容）／エラー）。
   */
  async allocateMany(orderIds: number[], userId: number): Promise<BulkAllocateResult[]> {
    const ids = [...new Set(orderIds)];
    const orders = await this.db
      .selectFrom('sales_orders')
      .select(['id', 'order_no', 'status'])
      .where('id', 'in', ids)
      .orderBy('ship_date', sql`asc nulls last`)
      .orderBy('order_no', 'asc')
      .execute();

    // 選んだ受注の引当を先にすべて戻してから、出荷日の早い順に引き当てる（2026-10-20 受入テスト T2）。
    // 1件ずつ「戻して取り直す」だけだと、前に一部だけ引き当てた出荷日の遅い受注が押さえている在庫が、
    // 一緒に選んだ出荷日の早い受注に回らなかった
    await this.db.transaction().execute(async (trx) => {
      for (const o of orders) {
        if (['未確定', '引当待ち', '引当済'].includes(o.status)) await this.allocation.releaseInTrx(trx, o.id, userId);
      }
    });

    const results: BulkAllocateResult[] = [];
    for (const o of orders) {
      try {
        const r = await this.allocation.reallocate(o.id, userId);
        results.push({ order_id: o.id, order_no: o.order_no, status: r.status, shortages: r.shortages, error: null });
      } catch (e) {
        if (!(e instanceof HttpException)) this.logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
        const now = await this.db.selectFrom('sales_orders').select('status').where('id', '=', o.id).executeTakeFirst();
        results.push({ order_id: o.id, order_no: o.order_no, status: now?.status ?? o.status, shortages: [], error: errorText(e) });
      }
    }
    const found = new Set(orders.map((o) => o.id));
    for (const id of ids) {
      if (!found.has(id)) results.push({ order_id: id, order_no: '', status: '', shortages: [], error: `受注が見つかりません（ID: ${id}）` });
    }
    return results;
  }

  /**
   * 一覧のまま直す（O-22。楽楽の編集モード）。出荷日・納品日・納品時間・出荷依頼書備考・納品書備考と、
   * 明細の出荷依頼書適用・納品書適用のうち、渡したものだけを直す。
   * 引当には触らない（状態も変えない）。出荷日を直したら、出荷済でない出荷の予定日もそろえる
   * （出荷確定・印刷の一覧と帳票の出荷予定日が受注と食い違わないように）。
   * 出荷済の受注は出荷日を直せない（備考・適用・納品日は直せる）。取消は直せない。
   */
  async patch(id: number, input: OrderListPatch, userId: number): Promise<Record<string, unknown>> {
    await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'status', 'is_cancelled', 'ship_date'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);
      if (order.is_cancelled) throw new BadRequestException('取り消された受注は直せません');

      const values: Record<string, unknown> = {};
      if (input.ship_date !== undefined && input.ship_date !== order.ship_date) {
        const shipped =
          order.status === '出荷済' ||
          !!(await trx
            .selectFrom('shipments')
            .select('id')
            .where('sales_order_id', '=', id)
            .where('status', '=', '出荷済')
            .executeTakeFirst());
        if (shipped) {
          throw new BadRequestException('出荷済みの受注は出荷日を直せません。先に出荷確定を取り消してください');
        }
        values.ship_date = input.ship_date;
      }
      if (input.delivery_date !== undefined) values.delivery_date = input.delivery_date;
      if (input.delivery_time_code_id !== undefined) {
        if (input.delivery_time_code_id !== null) {
          const code = await trx
            .selectFrom('codes as c')
            .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
            .select('c.id')
            .where('c.id', '=', input.delivery_time_code_id)
            .where('cc.code', '=', 'DELIVERY_TIME')
            .executeTakeFirst();
          if (!code) throw new BadRequestException('納品時間は選択肢から選んでください');
        }
        values.delivery_time_code_id = input.delivery_time_code_id;
      }
      if (input.shipping_remarks !== undefined) values.shipping_remarks = input.shipping_remarks;
      if (input.delivery_note_remarks !== undefined) values.delivery_note_remarks = input.delivery_note_remarks;

      const lines = input.lines ?? [];
      if (lines.length > 0) {
        const lineIds = [...new Set(lines.map((l) => l.id))];
        const own = await trx
          .selectFrom('sales_order_lines')
          .select('id')
          .where('sales_order_id', '=', id)
          .where('id', 'in', lineIds)
          .execute();
        if (own.length !== lineIds.length) throw new BadRequestException('この受注の明細ではない行が含まれています');
        for (const l of lines) {
          const set: { shipping_note?: string | null; delivery_slip_note?: string | null } = {};
          if (l.shipping_note !== undefined) set.shipping_note = l.shipping_note;
          if (l.delivery_slip_note !== undefined) set.delivery_slip_note = l.delivery_slip_note;
          if (Object.keys(set).length > 0) {
            await trx.updateTable('sales_order_lines').set(set).where('id', '=', l.id).execute();
          }
        }
      }

      // 明細だけ直したときも、受注の更新者・更新日時を付け直す（だれがいつ直したかが受注に残るように）
      if (Object.keys(values).length > 0 || lines.length > 0) {
        await trx
          .updateTable('sales_orders')
          .set({ ...values, updated_by: userId, updated_at: new Date() } as never)
          .where('id', '=', id)
          .execute();
      }
      if ('ship_date' in values) {
        await trx
          .updateTable('shipments')
          .set({ planned_ship_date: values.ship_date as string | null, updated_by: userId, updated_at: new Date() })
          .where('sales_order_id', '=', id)
          .where('status', 'not in', ['出荷済', '削除'])
          .execute();
      }
    });
    return this.row(id);
  }
}

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';

export interface PurchaseLineInput {
  line_no: number;
  purchase_item_id?: number | null;
  item_name: string;
  qty?: string;
  unit_cost: string;
  /** 経費の明細は SKU ではなく商品（品番）単位で持つ。商品別経費集計のもとになる。 */
  target_product_id?: number | null;
  target_brand_id?: number | null;
  target_product_class_id?: number | null;
  tax_rate?: string;
  note?: string | null;
}

export interface CreatePurchaseInput {
  division: '仕入' | '経費';
  supplier_partner_id: number;
  purchase_date: string;
  delivery_date?: string | null;
  payment_date1?: string | null;
  payment_date2?: string | null;
  currency?: string;
  note?: string | null;
  lines: PurchaseLineInput[];
}

export interface CashPaymentInput {
  partner_id: number;
  payment_date: string;
  amount: string;
  purchase_id?: number | null;
  applied_amount?: string | null;
  note?: string | null;
}

/** 機能ID P-01 仕入・経費登録／P-03 買掛残高一覧 */
@Injectable()
export class PurchasingService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
  ) {}

  async create(input: CreatePurchaseInput, userId: number) {
    if (input.lines.length === 0) throw new BadRequestException('明細を1行以上入力してください');

    return this.db.transaction().execute(async (trx) => {
      const purchaseNo = await this.numbering.next(trx, 'purchase');

      const purchase = await trx
        .insertInto('purchases')
        .values({
          purchase_no: purchaseNo,
          division: input.division,
          supplier_partner_id: input.supplier_partner_id,
          purchase_date: input.purchase_date,
          delivery_date: input.delivery_date ?? null,
          payment_date1: input.payment_date1 ?? null,
          payment_date2: input.payment_date2 ?? null,
          currency: input.currency ?? undefined,
          note: input.note ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'purchase_no'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('purchase_lines')
        .values(
          input.lines.map((l) => ({
            purchase_id: purchase.id,
            line_no: l.line_no,
            purchase_item_id: l.purchase_item_id ?? null,
            item_name: l.item_name,
            qty: l.qty ?? '1',
            unit_cost: l.unit_cost,
            subtotal: sql<string>`${l.qty ?? '1'}::numeric * ${l.unit_cost}::numeric`,
            tax_rate: l.tax_rate ?? undefined,
            target_product_id: l.target_product_id ?? null,
            target_brand_id: l.target_brand_id ?? null,
            target_product_class_id: l.target_product_class_id ?? null,
            note: l.note ?? null,
            created_by: userId,
          })),
        )
        .execute();

      await trx
        .updateTable('purchases')
        .set({
          total_amount: sql<string>`(select coalesce(sum(subtotal),0) from purchase_lines where purchase_id = ${purchase.id})`,
        })
        .where('id', '=', purchase.id)
        .execute();

      const saved = await trx
        .selectFrom('purchases')
        .select(['id', 'purchase_no', 'total_amount'])
        .where('id', '=', purchase.id)
        .executeTakeFirstOrThrow();

      return saved;
    });
  }

  async list(query: {
    division?: string;
    supplier_partner_id?: number;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('purchases as p')
      .innerJoin('partners as s', 's.id', 'p.supplier_partner_id');

    if (query.division) base = base.where('p.division', '=', query.division);
    if (query.supplier_partner_id !== undefined) base = base.where('p.supplier_partner_id', '=', query.supplier_partner_id);
    if (query.from) base = base.where('p.purchase_date', '>=', query.from);
    if (query.to) base = base.where('p.purchase_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'p.id as id',
          'p.purchase_no as purchase_no',
          'p.division as division',
          'p.purchase_date as purchase_date',
          'p.total_amount as total_amount',
          'p.status as status',
          's.name1 as supplier_name',
        ])
        .orderBy('p.purchase_date', 'desc')
        .orderBy('p.purchase_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const purchase = await this.db
      .selectFrom('purchases as p')
      .innerJoin('partners as s', 's.id', 'p.supplier_partner_id')
      .selectAll('p')
      .select('s.name1 as supplier_name')
      .where('p.id', '=', id)
      .executeTakeFirst();

    if (!purchase) throw new NotFoundException(`仕入・経費が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('purchase_lines as l')
      .leftJoin('products as pr', 'pr.id', 'l.target_product_id')
      .leftJoin('brands as b', 'b.id', 'l.target_brand_id')
      .select([
        'l.line_no as line_no',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_cost as unit_cost',
        'l.subtotal as subtotal',
        'l.tax_rate as tax_rate',
        'pr.product_code as target_product_code',
        'pr.product_name as target_product_name',
        'b.name as target_brand_name',
      ])
      .where('l.purchase_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...purchase, lines };
  }

  /**
   * 商品別の経費集計。
   * 経費の明細に商品（品番）を持たせているので、ここが集計のもとになる。
   */
  async expenseByProduct(query: { from?: string; to?: string }) {
    let base = this.db
      .selectFrom('purchase_lines as l')
      .innerJoin('purchases as p', 'p.id', 'l.purchase_id')
      .leftJoin('products as pr', 'pr.id', 'l.target_product_id')
      .where('p.division', '=', '経費');

    if (query.from) base = base.where('p.purchase_date', '>=', query.from);
    if (query.to) base = base.where('p.purchase_date', '<=', query.to);

    return base
      .select([
        'pr.product_code as product_code',
        'pr.product_name as product_name',
        sql<string>`sum(l.subtotal)`.as('amount'),
        sql<number>`count(*)::int`.as('line_count'),
      ])
      .groupBy(['pr.product_code', 'pr.product_name'])
      .orderBy(sql`sum(l.subtotal)`, 'desc')
      .execute();
  }

  /** 支払の登録と消込。 */
  async createPayment(input: CashPaymentInput, userId: number) {
    if (input.purchase_id) {
      const purchase = await this.db
        .selectFrom('purchases')
        .select(['id', 'supplier_partner_id'])
        .where('id', '=', input.purchase_id)
        .executeTakeFirst();
      if (!purchase) throw new NotFoundException('消込先の仕入が見つかりません');
      if (purchase.supplier_partner_id !== input.partner_id) {
        throw new BadRequestException('支払の取引先と仕入の取引先が違います');
      }
    }

    const applied = input.applied_amount ?? (input.purchase_id ? input.amount : '0');
    if (Number(applied) > Number(input.amount)) {
      throw new BadRequestException('消込額が支払額を超えています');
    }

    return this.db
      .insertInto('cash_payments')
      .values({
        partner_id: input.partner_id,
        payment_date: input.payment_date,
        amount: input.amount,
        purchase_id: input.purchase_id ?? null,
        applied_amount: applied,
        note: input.note ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'amount', 'applied_amount'])
      .executeTakeFirstOrThrow();
  }

  /**
   * 買掛残高一覧。期間の仕入額と支払額から残高を出す。
   * 売掛のように締め伝票を作るのではなく、そのつど集計して見せる。
   */
  async apBalances(query: { from: string; to: string }) {
    return this.db
      .selectFrom('partners as p')
      .select([
        'p.id as partner_id',
        'p.partner_code as partner_code',
        'p.name1 as partner_name',
        (eb) =>
          eb
            .selectFrom('purchases as pu')
            .select(sql<string>`coalesce(sum(pu.total_amount),0)`.as('a'))
            .whereRef('pu.supplier_partner_id', '=', 'p.id')
            .where('pu.purchase_date', '>=', query.from)
            .where('pu.purchase_date', '<=', query.to)
            .as('purchase_amount'),
        (eb) =>
          eb
            .selectFrom('cash_payments as cp')
            .select(sql<string>`coalesce(sum(cp.amount),0)`.as('a'))
            .whereRef('cp.partner_id', '=', 'p.id')
            .where('cp.payment_date', '>=', query.from)
            .where('cp.payment_date', '<=', query.to)
            .as('payment_amount'),
      ])
      .where('p.is_supplier', '=', true)
      .where('p.is_active', '=', true)
      .orderBy('p.partner_code', 'asc')
      .execute();
  }
}

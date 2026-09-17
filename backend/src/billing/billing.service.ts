import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import type { Paged } from '../masters/partners.service';

export interface ClosingInput {
  /** 対象年月。YYYY-MM */
  target_month: string;
  /** 指定しなければ、締め日の設定がある得意先すべてを締める。 */
  partner_id?: number | null;
}

export interface CashReceiptInput {
  partner_id: number;
  receipt_date: string;
  amount: string;
  invoice_id?: number | null;
  applied_amount?: string | null;
  note?: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * 締め期間を求める。
 *   締め日 99（月末）… その月の1日から末日まで
 *   締め日 20        … 前月21日から当月20日まで
 * 前月に該当日がない場合（31日締めの2月など）は前月末日に寄せる。
 */
export function closingPeriod(targetMonth: string, closingDay: number): { from: string; to: string } {
  const [y, m] = targetMonth.split('-').map(Number);
  const last = lastDayOfMonth(y, m);

  if (closingDay >= 99 || closingDay >= last) {
    return { from: `${targetMonth}-01`, to: `${targetMonth}-${pad(last)}` };
  }

  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const prevLast = lastDayOfMonth(py, pm);
  const fromDay = Math.min(closingDay + 1, prevLast);

  return { from: `${py}-${pad(pm)}-${pad(fromDay)}`, to: `${targetMonth}-${pad(closingDay)}` };
}

/** 機能ID B-01 締め処理／B-02 請求書発行／B-04 売掛残高一覧／B-05 入金登録・消込 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 締め処理。取引先ごとの締め日で期間を切り、その期間の出荷と返品を集計する。
   *
   * サンプル出荷（is_billable=false）は集計に入らない。
   * 一度発行した請求書は締め直せない。取り消してからやり直していただく。
   */
  async close(input: ClosingInput, userId: number) {
    if (!/^\d{4}-\d{2}$/.test(input.target_month)) {
      throw new BadRequestException('対象年月は YYYY-MM の形式で指定してください');
    }

    let partnerQuery = this.db
      .selectFrom('partners')
      .select(['id', 'partner_code', 'name1', 'closing_day'])
      .where('is_customer', '=', true)
      .where('is_active', '=', true)
      .where('closing_day', 'is not', null);

    if (input.partner_id) partnerQuery = partnerQuery.where('id', '=', input.partner_id);
    const partners = await partnerQuery.execute();

    if (partners.length === 0) {
      throw new BadRequestException('締め日が設定された得意先がありません');
    }

    const roundingMode = await this.settings.text('TAX_ROUNDING_MODE', 'floor');
    const results: Array<Record<string, unknown>> = [];

    for (const partner of partners) {
      const period = closingPeriod(input.target_month, partner.closing_day ?? 99);
      const invoice = await this.db.transaction().execute((trx) =>
        this.closeOne(trx, partner.id, period, roundingMode, userId),
      );
      results.push({
        partner_code: partner.partner_code,
        partner_name: partner.name1,
        period_from: period.from,
        period_to: period.to,
        ...invoice,
      });
    }

    return { target_month: input.target_month, closed: results.length, invoices: results };
  }

  private async closeOne(
    trx: Transaction<DB>,
    partnerId: number,
    period: { from: string; to: string },
    roundingMode: string,
    userId: number,
  ) {
    const existing = await trx
      .selectFrom('invoices')
      .select(['id', 'invoice_no', 'status'])
      .where('partner_id', '=', partnerId)
      .where('period_to', '=', period.to)
      .executeTakeFirst();

    if (existing && existing.status === '発行済') {
      throw new ConflictException(
        `${existing.invoice_no} はすでに発行済みです。締め直すには先に取り消してください`,
      );
    }
    // 未発行のものは作り直す（明細ごと消える）
    if (existing) {
      await trx.deleteFrom('invoices').where('id', '=', existing.id).execute();
    }

    const invoiceNo = existing?.invoice_no ?? (await this.numbering.next(trx, 'invoice'));

    // 前回の請求残高。初回は 0。
    const prev = await trx
      .selectFrom('invoices')
      .select(['current_balance'])
      .where('partner_id', '=', partnerId)
      .where('period_to', '<', period.from)
      .orderBy('period_to', 'desc')
      .limit(1)
      .executeTakeFirst();
    const prevBalance = prev?.current_balance ?? '0';

    const invoice = await trx
      .insertInto('invoices')
      .values({
        invoice_no: invoiceNo,
        partner_id: partnerId,
        closing_date: period.to,
        period_from: period.from,
        period_to: period.to,
        prev_invoice_balance: prevBalance,
        status: '未発行',
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'invoice_no'])
      .executeTakeFirstOrThrow();

    // 出荷（サンプルは除く）を、出荷×税率でまとめて明細にする
    await trx
      .insertInto('invoice_lines')
      .columns(['invoice_id', 'line_no', 'shipment_id', 'item_name', 'qty', 'unit_price', 'tax_rate', 'amount', 'created_by'])
      .expression(
        trx
          .selectFrom('shipment_lines as sl')
          .innerJoin('shipments as sh', 'sh.id', 'sl.shipment_id')
          .innerJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
          .select([
            sql<number>`${invoice.id}`.as('invoice_id'),
            sql<number>`row_number() over (order by sh.shipment_no, sl.tax_rate)`.as('line_no'),
            'sh.id as shipment_id',
            sql<string>`'出荷 ' || sh.shipment_no`.as('item_name'),
            sql<string>`sum(sl.qty)`.as('qty'),
            sql<string>`0`.as('unit_price'),
            'sl.tax_rate as tax_rate',
            sql<string>`sum(sl.amount)`.as('amount'),
            sql<number>`${userId}`.as('created_by'),
          ])
          .where('sh.status', '=', '出荷済')
          .where('o.partner_id', '=', partnerId)
          .where('o.is_billable', '=', true)
          .where('sh.ship_date', '>=', period.from)
          .where('sh.ship_date', '<=', period.to)
          .groupBy(['sh.id', 'sh.shipment_no', 'sl.tax_rate']),
      )
      .execute();

    // 返品はマイナスの明細として同じ請求に載せる
    const shipmentLineCount = await trx
      .selectFrom('invoice_lines')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('invoice_id', '=', invoice.id)
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('invoice_lines')
      .columns(['invoice_id', 'line_no', 'return_id', 'item_name', 'qty', 'unit_price', 'tax_rate', 'amount', 'created_by'])
      .expression(
        trx
          .selectFrom('return_lines as rl')
          .innerJoin('returns as r', 'r.id', 'rl.return_id')
          .select([
            sql<number>`${invoice.id}`.as('invoice_id'),
            sql<number>`${Number(shipmentLineCount.n)} + row_number() over (order by r.return_no, rl.tax_rate)`.as('line_no'),
            'r.id as return_id',
            sql<string>`'返品 ' || r.return_no`.as('item_name'),
            sql<string>`-sum(rl.qty)`.as('qty'),
            sql<string>`0`.as('unit_price'),
            'rl.tax_rate as tax_rate',
            sql<string>`-sum(rl.qty * rl.unit_price)`.as('amount'),
            sql<number>`${userId}`.as('created_by'),
          ])
          .where('r.partner_id', '=', partnerId)
          .where('r.status', '<>', '取消')
          .where('r.return_date', '>=', period.from)
          .where('r.return_date', '<=', period.to)
          .groupBy(['r.id', 'r.return_no', 'rl.tax_rate']),
      )
      .execute();

    // 税率別の内訳。端数処理は設定に従う（既定は請求書単位・税率別・切捨て）。
    await trx
      .insertInto('invoice_tax_summaries')
      .columns(['invoice_id', 'tax_rate', 'taxable_base', 'tax_amount'])
      .expression(
        trx
          .selectFrom('invoice_lines')
          .select([
            sql<number>`${invoice.id}`.as('invoice_id'),
            'tax_rate',
            sql<string>`sum(amount)`.as('taxable_base'),
            sql<string>`fn_round_amount(sum(amount) * tax_rate / 100, ${roundingMode})`.as('tax_amount'),
          ])
          .where('invoice_id', '=', invoice.id)
          .groupBy('tax_rate'),
      )
      .execute();

    // 集計値をヘッダへ書き戻す。
    // 送料は出荷ごとに判定する（9/15 ご回答：1回の出荷が 30,000 円未満なら一律 750 円）。
    //   受注に送料調整欄があればその額（直送はここに直接入力）。
    //   取引先マスタの送料区分が「請求しない」「直送のみ」なら 0。
    //   それ以外は fn_shipping_fee（閾値・金額は取引先マスタ → 設定の順）。
    await trx
      .updateTable('invoices')
      .set({
        shipping_fee_amount: sql<string>`(
          select coalesce(sum(
            coalesce(o.shipping_fee_adjustment,
              case when o.order_type = '直送' then 0
                   when fr.code in ('NO_CHARGE', 'DIRECT_ONLY') then 0
                   else fn_shipping_fee(o.partner_id, t.total) end)), 0)
            from shipments sh
            join sales_orders o on o.id = sh.sales_order_id
            join partners pa on pa.id = o.partner_id
            left join codes fr on fr.id = pa.shipping_fee_rule_code_id
            join lateral (select coalesce(sum(sl.amount), 0) as total
                            from shipment_lines sl where sl.shipment_id = sh.id) t on true
           where sh.status = '出荷済' and o.is_billable and o.partner_id = ${partnerId}
             and sh.ship_date >= ${period.from} and sh.ship_date <= ${period.to})`,
        shipment_amount: sql<string>`(select coalesce(sum(amount),0) from invoice_lines where invoice_id = ${invoice.id} and shipment_id is not null)`,
        return_amount: sql<string>`(select coalesce(-sum(amount),0) from invoice_lines where invoice_id = ${invoice.id} and return_id is not null)`,
        current_receipt_amount: sql<string>`(select coalesce(sum(amount),0) from cash_receipts where partner_id = ${partnerId} and receipt_date >= ${period.from} and receipt_date <= ${period.to})`,
      })
      .where('id', '=', invoice.id)
      .execute();

    await trx
      .updateTable('invoices')
      .set({
        carryover_balance: sql<string>`prev_invoice_balance - current_receipt_amount`,
        current_invoice_amount: sql<string>`
          (select coalesce(sum(amount),0) from invoice_lines where invoice_id = ${invoice.id})
          + (select coalesce(sum(tax_amount),0) from invoice_tax_summaries where invoice_id = ${invoice.id})
          + shipping_fee_amount + fee_amount + adjust_10 + adjust_8 + unposted_10 + unposted_8`,
      })
      .where('id', '=', invoice.id)
      .execute();

    await trx
      .updateTable('invoices')
      .set({ current_balance: sql<string>`carryover_balance + current_invoice_amount` })
      .where('id', '=', invoice.id)
      .execute();

    // 売掛元帳。締めた期間の増減をそのまま残す。
    await trx
      .deleteFrom('ar_ledgers')
      .where('partner_id', '=', partnerId)
      .where('period_to', '=', period.to)
      .execute();
    await trx
      .insertInto('ar_ledgers')
      .columns(['partner_id', 'period_from', 'period_to', 'opening_balance', 'charge_amount', 'receipt_amount', 'closing_balance', 'created_by', 'updated_by'])
      .expression(
        trx
          .selectFrom('invoices')
          .select([
            'partner_id',
            'period_from',
            'period_to',
            'prev_invoice_balance as opening_balance',
            'current_invoice_amount as charge_amount',
            'current_receipt_amount as receipt_amount',
            'current_balance as closing_balance',
            sql<number>`${userId}`.as('created_by'),
            sql<number>`${userId}`.as('updated_by'),
          ])
          .where('id', '=', invoice.id),
      )
      .execute();

    const totals = await trx
      .selectFrom('invoices')
      .select(['id', 'invoice_no', 'shipment_amount', 'return_amount', 'shipping_fee_amount', 'current_invoice_amount', 'current_balance'])
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow();

    return totals;
  }

  /**
   * 請求の手入力欄を直す。
   *
   * 未計上10%/8%・調整10%/8%・手数料・送料は、現時点では定義が固まっておらず
   * 手入力で運用いただく前提（要件定義書 第10章）。直したら当月請求額と
   * 今回請求残高、売掛元帳を締め処理と同じ式で計算し直す。
   */
  async updateInvoice(
    id: number,
    values: {
      unposted_10?: string;
      unposted_8?: string;
      adjust_10?: string;
      adjust_8?: string;
      fee_amount?: string;
      shipping_fee_amount?: string;
      po_no?: string | null;
    },
    userId: number,
  ) {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('更新する項目がありません');
    }

    return this.db.transaction().execute(async (trx) => {
      const invoice = await trx
        .selectFrom('invoices')
        .select(['id', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!invoice) throw new NotFoundException(`請求が見つかりません（ID: ${id}）`);
      if (invoice.status !== '未発行') {
        throw new ConflictException(
          `${invoice.status}の請求は直せません。取り消してから締め直してください`,
        );
      }

      await trx
        .updateTable('invoices')
        .set({ ...clean, updated_by: userId, updated_at: new Date() } as never)
        .where('id', '=', id)
        .execute();

      // 締め処理と同じ式。片方だけ直して食い違うことがないよう、ここでも同じものを使う。
      await trx
        .updateTable('invoices')
        .set({
          current_invoice_amount: sql<string>`
            (select coalesce(sum(amount),0) from invoice_lines where invoice_id = ${id})
            + (select coalesce(sum(tax_amount),0) from invoice_tax_summaries where invoice_id = ${id})
            + shipping_fee_amount + fee_amount + adjust_10 + adjust_8 + unposted_10 + unposted_8`,
        })
        .where('id', '=', id)
        .execute();

      await trx
        .updateTable('invoices')
        .set({ current_balance: sql<string>`carryover_balance + current_invoice_amount` })
        .where('id', '=', id)
        .execute();

      await sql`
        update ar_ledgers a
           set charge_amount   = i.current_invoice_amount,
               closing_balance = i.current_balance,
               updated_by      = ${userId},
               updated_at      = now()
          from invoices i
         where i.id = ${id}
           and a.partner_id = i.partner_id
           and a.period_to  = i.period_to`.execute(trx);

      return trx
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    });
  }

  async listInvoices(query: {
    partner_id?: number;
    status?: string;
    period_to?: string;
    limit: number;
    offset: number;
  }): Promise<Paged<Record<string, unknown>>> {
    let base = this.db.selectFrom('invoices as i').innerJoin('partners as p', 'p.id', 'i.partner_id');
    if (query.partner_id !== undefined) base = base.where('i.partner_id', '=', query.partner_id);
    if (query.status) base = base.where('i.status', '=', query.status);
    if (query.period_to) base = base.where('i.period_to', '=', query.period_to);

    const [items, total] = await Promise.all([
      base
        .select([
          'i.id as id',
          'i.invoice_no as invoice_no',
          'i.status as status',
          'i.period_from as period_from',
          'i.period_to as period_to',
          'p.partner_code as partner_code',
          'p.name1 as partner_name',
          // 売掛残高一覧の12項目。現行と同じ並び。
          'i.prev_invoice_balance as prev_invoice_balance',
          'i.current_receipt_amount as current_receipt_amount',
          'i.carryover_balance as carryover_balance',
          'i.shipment_amount as shipment_amount',
          'i.return_amount as return_amount',
          'i.unposted_10 as unposted_10',
          'i.unposted_8 as unposted_8',
          'i.fee_amount as fee_amount',
          'i.adjust_10 as adjust_10',
          'i.adjust_8 as adjust_8',
          'i.shipping_fee_amount as shipping_fee_amount',
          'i.current_invoice_amount as current_invoice_amount',
          'i.current_balance as current_balance',
        ])
        .orderBy('i.period_to', 'desc')
        .orderBy('p.partner_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findInvoice(id: number) {
    const invoice = await this.db
      .selectFrom('invoices as i')
      .innerJoin('partners as p', 'p.id', 'i.partner_id')
      .selectAll('i')
      .select(['p.partner_code as partner_code', 'p.name1 as partner_name', 'p.invoice_registration_no as partner_invoice_no'])
      .where('i.id', '=', id)
      .executeTakeFirst();

    if (!invoice) throw new NotFoundException(`請求が見つかりません（ID: ${id}）`);

    const [lines, taxes] = await Promise.all([
      this.db
        .selectFrom('invoice_lines')
        .select(['line_no', 'shipment_id', 'return_id', 'item_name', 'qty', 'tax_rate', 'amount'])
        .where('invoice_id', '=', id)
        .orderBy('line_no', 'asc')
        .execute(),
      this.db
        .selectFrom('invoice_tax_summaries')
        .select(['tax_rate', 'taxable_base', 'tax_amount'])
        .where('invoice_id', '=', id)
        .orderBy('tax_rate', 'desc')
        .execute(),
    ]);

    return { ...invoice, lines, tax_summaries: taxes };
  }

  /** 発行。請求書に発行日は印刷しないが、いつ出したかは残す。 */
  async issueInvoice(id: number, userId: number) {
    const invoice = await this.db
      .selectFrom('invoices')
      .select(['id', 'invoice_no', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!invoice) throw new NotFoundException(`請求が見つかりません（ID: ${id}）`);
    if (invoice.status === '発行済') throw new ConflictException('すでに発行済みです');

    await this.db
      .updateTable('invoices')
      .set({ status: '発行済', issued_at: new Date(), updated_by: userId, updated_at: new Date() })
      .where('id', '=', id)
      .execute();

    return { id, invoice_no: invoice.invoice_no, status: '発行済' };
  }

  /** 入金登録と消込。請求を指定すると、その請求に充当した額として記録する。 */
  async createCashReceipt(input: CashReceiptInput, userId: number) {
    if (input.invoice_id) {
      const invoice = await this.db
        .selectFrom('invoices')
        .select(['id', 'partner_id'])
        .where('id', '=', input.invoice_id)
        .executeTakeFirst();
      if (!invoice) throw new NotFoundException('消込先の請求が見つかりません');
      if (invoice.partner_id !== input.partner_id) {
        throw new BadRequestException('入金の取引先と請求の取引先が違います');
      }
    }

    const applied = input.applied_amount ?? (input.invoice_id ? input.amount : '0');
    if (Number(applied) > Number(input.amount)) {
      throw new BadRequestException('消込額が入金額を超えています');
    }

    return this.db
      .insertInto('cash_receipts')
      .values({
        partner_id: input.partner_id,
        receipt_date: input.receipt_date,
        amount: input.amount,
        invoice_id: input.invoice_id ?? null,
        applied_amount: applied,
        note: input.note ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'amount', 'applied_amount'])
      .executeTakeFirstOrThrow();
  }

  async listCashReceipts(query: { partner_id?: number; from?: string; to?: string; limit: number; offset: number }) {
    let base = this.db
      .selectFrom('cash_receipts as c')
      .innerJoin('partners as p', 'p.id', 'c.partner_id')
      .leftJoin('invoices as i', 'i.id', 'c.invoice_id');

    if (query.partner_id !== undefined) base = base.where('c.partner_id', '=', query.partner_id);
    if (query.from) base = base.where('c.receipt_date', '>=', query.from);
    if (query.to) base = base.where('c.receipt_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'c.id as id',
          'c.receipt_date as receipt_date',
          'c.amount as amount',
          'c.applied_amount as applied_amount',
          sql<string>`c.amount - c.applied_amount`.as('unapplied_amount'),
          'p.name1 as partner_name',
          'i.invoice_no as invoice_no',
        ])
        .orderBy('c.receipt_date', 'desc')
        .orderBy('c.id', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }
}

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { currencyDigits } from '../common/currency';
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
  /** 通貨。省略時は消込先の請求の通貨、請求を選ばなければ取引先の通貨（2026-10-12 No.39）。 */
  currency?: string;
  applied_amount?: string | null;
  note?: string | null;
}

/** 入金の訂正。取引先は入れ替えさせないので、ここには入っていない。 */
export interface CashReceiptUpdateInput {
  receipt_date?: string;
  amount?: string;
  /** null を入れると消込を外す。 */
  invoice_id?: number | null;
  /** 通貨。消込先の請求と同じ通貨でないと消し込めない（2026-10-12 No.39）。 */
  currency?: string;
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

/**
 * 入金額の決まり。0 円の入金は記録する意味がなく、打ち間違いのほうが疑わしいので受け付けない。
 *
 * 0・負数・数字以外をひとつの文言にそろえたいので、受注・入荷・返品と同じく
 * ここ（サービス側）でまとめて見る。画面の項目名「入金額」を文言に入れてあるので、
 * 項目名を頭に付けずにそのまま出せる。
 * 金額は NUMERIC の文字列のまま扱うため、0 かどうかも数値に直さず文字で見る
 * （数字とピリオドだけの文字列なので、1〜9 が1つも無ければ 0）。
 */
function assertReceiptAmount(value: string): void {
  if (!/^\d+(\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new BadRequestException('入金額は 0 より大きい数で入力してください');
  }
}

/**
 * 入金と消込先の請求の通貨がそろっているか（2026-10-12 No.39）。
 * 円の請求にドルの入金を消し込むと、売掛残高の数字に意味が無くなるため断る。
 */
function assertSameCurrency(receiptCurrency: string, invoiceCurrency: string, invoiceNo: string): void {
  if (receiptCurrency !== invoiceCurrency) {
    throw new BadRequestException(
      `入金の通貨（${receiptCurrency}）と請求 ${invoiceNo} の通貨（${invoiceCurrency}）が違うため、消し込めません。通貨を合わせるか、消込先を選び直してください`,
    );
  }
}

/** 機能ID B-01 締め処理／B-02 請求書発行／B-04 売掛残高一覧／B-05 入金登録・消込 */
/**
 * その請求の期間に入っている入金の合計。締めたあとに登録された分も含める。
 * 請求書そのもの（findInvoice・PDF）は送付済みの書類なので締め時点の値を保ち、
 * 一覧・売掛残高だけを最新の入金で見せる。
 */
const RECEIPT_IN_PERIOD = sql<string>`(
  select coalesce(sum(cr.amount), 0)
    from cash_receipts cr
   where cr.partner_id = i.partner_id
     -- 請求と同じ通貨の入金だけ数える（円の請求にドルの入金を足さない。2026-10-12 No.39）
     and cr.currency = i.currency
     and cr.receipt_date >= i.period_from
     and cr.receipt_date <= i.period_to
)`;

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
   * 取り消した請求は残したまま、新しい請求番号で作り直す（未発行のやり直しは同じ番号のまま）。
   */
  async close(input: ClosingInput, userId: number) {
    if (!/^\d{4}-\d{2}$/.test(input.target_month)) {
      throw new BadRequestException('対象年月は YYYY-MM の形式で指定してください');
    }

    let partnerQuery = this.db
      .selectFrom('partners')
      .select(['id', 'partner_code', 'name1', 'closing_day', 'is_overseas', 'currency'])
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
        this.closeOne(trx, partner.id, period, roundingMode, userId, partner.is_overseas, partner.currency),
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
    overseas = false,
    partnerCurrency = 'JPY',
  ) {
    // 海外の得意先（取引先マスタの「海外」）は消費税を 0 にする（2026-10-09 マスター編②）。
    // 免税（税抜扱い）でも課税対象外でも税額は 0 で、違いは請求書の表記だけ（reports.service.ts）。
    // 受注明細の税率は国内と同じ 10% のまま入っていることがあるので、請求明細の税率を 0 に置き換え、
    // 税率別の内訳も「0%・税額 0」の1行にまとめる（10% の対象額として載せると税がかかって見えるため）。
    const lineRate = overseas ? sql<string>`0` : null;

    // 取り消した請求は残す（請求番号と、いくらで出してどう取り消したかを追えるようにする）。
    // そのため、締め直しの判断材料になるのは「取消でない請求」だけ。
    const existing = await trx
      .selectFrom('invoices')
      .select(['id', 'invoice_no', 'status'])
      .where('partner_id', '=', partnerId)
      .where('period_to', '=', period.to)
      .where('status', '<>', '取消')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    if (existing && existing.status === '発行済') {
      throw new ConflictException(
        `${existing.invoice_no} はすでに発行済みです。締め直すには、請求書の一覧でこの請求を「取消」にしてください`,
      );
    }

    // 未発行のものは「締めのやり直し」なので作り直し、請求番号はそのまま使う（明細ごと消える）。
    // 取消のものは残すので、そちらには触らず、新しい請求番号で作る。
    //
    // 入金の消込先になっている請求は外部キーで消せないため、いったん消込を外す。
    // 取り消した請求に消し込んでいた入金も、ここで作る新しい請求に付け替える
    // （取り消した請求に入金がぶら下がったままにしない）。
    const receipts = await trx
      .selectFrom('cash_receipts as c')
      .innerJoin('invoices as i', 'i.id', 'c.invoice_id')
      .select(['c.id as id', 'c.currency as currency'])
      .where('i.partner_id', '=', partnerId)
      .where('i.period_to', '=', period.to)
      .execute();
    const relinkReceiptIds = receipts.map((r) => r.id);
    if (relinkReceiptIds.length > 0) {
      await trx
        .updateTable('cash_receipts')
        .set({ invoice_id: null, updated_by: userId, updated_at: new Date() })
        .where('id', 'in', relinkReceiptIds)
        .execute();
    }
    if (existing) {
      await trx.deleteFrom('invoices').where('id', '=', existing.id).execute();
    }

    const invoiceNo = existing?.invoice_no ?? (await this.numbering.next(trx, 'invoice'));

    // 請求の通貨（2026-10-12 No.39「売上仕入用の通貨」）。請求書は取引先の通貨で作る。
    // まだ請求していない受注は取引先の通貨に従う決まり（引き金 trg_partners_currency）なので、
    // 締め直しで外れた受注（未発行の請求を消した分・取り消した請求に載っていた分）も、ここで取引先の通貨にそろえる。
    // 受注の通貨は引き金 trg_sales_orders_currency が取引先から入れ直す（currency = currency で起動する）。
    await sql`
      update sales_orders o
         set currency = o.currency
       where o.partner_id = ${partnerId}
         and o.is_billable
         and o.currency <> ${partnerCurrency}
         and exists (select 1 from shipments sh
                      where sh.sales_order_id = o.id and sh.status = '出荷済'
                        and sh.ship_date >= ${period.from} and sh.ship_date <= ${period.to})
         and not exists (select 1 from shipments sh
                           join invoice_lines il on il.shipment_id = sh.id
                           join invoices i on i.id = il.invoice_id
                          where sh.sales_order_id = o.id and i.status <> '取消')`.execute(trx);

    // 1つの請求に違う通貨を混ぜない。ほかの請求に載ったまま残っている受注があると、ここに来る。
    const mixed = await trx
      .selectFrom('sales_orders as o')
      .innerJoin('shipments as sh', 'sh.sales_order_id', 'o.id')
      .select('o.currency as currency')
      .distinct()
      .where('sh.status', '=', '出荷済')
      .where('o.partner_id', '=', partnerId)
      .where('o.is_billable', '=', true)
      .where('o.currency', '<>', partnerCurrency)
      .where('sh.ship_date', '>=', period.from)
      .where('sh.ship_date', '<=', period.to)
      .execute();
    if (mixed.length > 0) {
      throw new ConflictException(
        `${period.from}〜${period.to} の出荷に、取引先の通貨（${partnerCurrency}）と違う通貨（${mixed.map((m) => m.currency).join('・')}）の受注があります。` +
          '1つの請求書には1つの通貨しか載せられません。ほかの請求に載っている受注がないか、請求書の一覧で確かめてください',
      );
    }
    const currency = partnerCurrency;

    // 前回の請求残高。初回は 0。
    // 取り消した請求の残高は引き継がない（取り消した金額を繰り越すと、繰越残高が実態と合わなくなる）。
    const prev = await trx
      .selectFrom('invoices')
      .select(['current_balance'])
      .where('partner_id', '=', partnerId)
      .where('period_to', '<', period.from)
      .where('status', '<>', '取消')
      // 前回の残高は同じ通貨の請求から引き継ぐ（通貨を切り替えた取引先で、円の残高をドルに足さない）
      .where('currency', '=', currency)
      .orderBy('period_to', 'desc')
      .orderBy('id', 'desc')
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
        currency,
        prev_invoice_balance: prevBalance,
        status: '未発行',
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'invoice_no'])
      .executeTakeFirstOrThrow();

    // 付け替えるのは新しい請求と同じ通貨の入金だけ（2026-10-12 No.39）。取引先の通貨を直して締め直したときに、
    // 前の通貨の入金を違う通貨の請求へ消し込まないよう、通貨の違う入金は消込を外したまま（消込額も 0）にする。
    const sameCurrency = receipts.filter((r) => r.currency === currency).map((r) => r.id);
    const otherCurrency = receipts.filter((r) => r.currency !== currency).map((r) => r.id);
    if (sameCurrency.length > 0) {
      await trx
        .updateTable('cash_receipts')
        .set({ invoice_id: invoice.id, updated_by: userId, updated_at: new Date() })
        .where('id', 'in', sameCurrency)
        .execute();
    }
    if (otherCurrency.length > 0) {
      await trx
        .updateTable('cash_receipts')
        .set({ applied_amount: '0', updated_by: userId, updated_at: new Date() })
        .where('id', 'in', otherCurrency)
        .execute();
    }

    // 出荷（サンプルは除く）を、出荷×税率でまとめて明細にする
    await trx
      .insertInto('invoice_lines')
      .columns(['invoice_id', 'line_no', 'shipment_id', 'item_name', 'qty', 'unit_price', 'tax_rate', 'amount', 'created_by'])
      .expression(
        trx
          // 請求は「売った内容」。出荷明細（shipment_lines）は倉庫から出たものの記録で、
          // 送料・値引のような在庫を持たない行が無く、セット商品は構成品ごとに並ぶため、
          // そのまま請求にすると送料と値引が落ち、セットは構成品の数だけ金額が膨らむ。
          .selectFrom('sales_order_lines as sl')
          .innerJoin('shipments as sh', 'sh.sales_order_id', 'sl.sales_order_id')
          .innerJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
          .select([
            sql<number>`${invoice.id}`.as('invoice_id'),
            sql<number>`row_number() over (order by sh.shipment_no${overseas ? sql.raw('') : sql.raw(', sl.tax_rate')})`.as('line_no'),
            'sh.id as shipment_id',
            sql<string>`'出荷 ' || sh.shipment_no`.as('item_name'),
            // 数量は品物の行だけ数える（送料・値引の「1」を個数に混ぜない）。
            // 納品書・出荷指示書の goodsQty() と同じ数え方にそろえてある。
            sql<string>`coalesce(sum(sl.qty) filter (where sl.line_type in ('商品','セット商品')
              or (sl.line_type = '内訳商品' and sl.parent_line_no is null)), 0)`.as('qty'),
            sql<string>`0`.as('unit_price'),
            (lineRate ?? sql<string>`sl.tax_rate`).as('tax_rate'),
            sql<string>`sum(sl.amount)`.as('amount'),
            sql<number>`${userId}`.as('created_by'),
          ])
          .where('sh.status', '=', '出荷済')
          .where('o.partner_id', '=', partnerId)
          .where('o.is_billable', '=', true)
          .where('sh.ship_date', '>=', period.from)
          .where('sh.ship_date', '<=', period.to)
          .groupBy(['sh.id', 'sh.shipment_no'])
          // 海外は税率を 0 にそろえるので、税率で行を分けない（1出荷1行）
          .$if(!overseas, (qb) => qb.groupBy('sl.tax_rate')),
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
            sql<number>`${Number(shipmentLineCount.n)} + row_number() over (order by r.return_no${overseas ? sql.raw('') : sql.raw(', rl.tax_rate')})`.as('line_no'),
            'r.id as return_id',
            sql<string>`'返品 ' || r.return_no`.as('item_name'),
            sql<string>`-sum(rl.qty)`.as('qty'),
            sql<string>`0`.as('unit_price'),
            (lineRate ?? sql<string>`rl.tax_rate`).as('tax_rate'),
            sql<string>`-sum(rl.qty * rl.unit_price)`.as('amount'),
            sql<number>`${userId}`.as('created_by'),
          ])
          .where('r.partner_id', '=', partnerId)
          .where('r.status', '<>', '取消')
          .where('r.return_date', '>=', period.from)
          .where('r.return_date', '<=', period.to)
          .groupBy(['r.id', 'r.return_no'])
          .$if(!overseas, (qb) => qb.groupBy('rl.tax_rate')),
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
            // 端数は通貨の最小単位で処理する（円は1円、外貨は小数2桁。2026-10-13 再テスト N3）
            sql<string>`fn_round_amount(sum(amount) * tax_rate / 100, ${roundingMode}, ${currencyDigits(currency)}::int)`.as('tax_amount'),
          ])
          .where('invoice_id', '=', invoice.id)
          .groupBy('tax_rate'),
      )
      .execute();

    // 集計値をヘッダへ書き戻す。
    // 送料は出荷ごとに判定する（9/15 ご回答：1回の出荷が 30,000 円未満なら一律 750 円）。
    //   受注に送料調整欄があればその額（直送はここに直接入力）。
    //   取引先マスタの送料区分が「請求しない」「直送のみ」なら 0。
    //   受注明細に金額の入った「送料」の行があるときは、その行が請求明細に乗るので
    //   自動計算も送料調整欄も使わない（同じ送料を二重に請求しないため）。
    //   0 円の送料行は「送料なし」の意思表示ではないので、自動計算をそのまま行う。
    //   判定の元になる金額は送料の行を除いた受注金額（送料で閾値を超えるのを避ける）。
    //   それ以外は fn_shipping_fee（閾値・金額は取引先マスタ → 設定の順）。
    await trx
      .updateTable('invoices')
      .set({
        shipping_fee_amount: sql<string>`(
          select coalesce(sum(
            case when t.fee_amount <> 0 then 0
                 else coalesce(o.shipping_fee_adjustment,
                        case when o.order_type = '直送' then 0
                             -- 自動の送料（3万円未満で 750 円）は円の決まり。外貨の受注には付けず、要るときは送料調整欄に入れる
                             when o.currency <> 'JPY' then 0
                             when fr.code in ('NO_CHARGE', 'DIRECT_ONLY') then 0
                             else fn_shipping_fee(o.partner_id, t.total) end) end), 0)
            from shipments sh
            join sales_orders o on o.id = sh.sales_order_id
            join partners pa on pa.id = o.partner_id
            left join codes fr on fr.id = pa.shipping_fee_rule_code_id
            join lateral (
              select coalesce(sum(sl.amount) filter (where sl.line_type <> '送料'), 0) as total,
                     coalesce(sum(sl.amount) filter (where sl.line_type = '送料'), 0) as fee_amount
                from sales_order_lines sl
               where sl.sales_order_id = sh.sales_order_id) t on true
           where sh.status = '出荷済' and o.is_billable and o.partner_id = ${partnerId}
             and sh.ship_date >= ${period.from} and sh.ship_date <= ${period.to})`,
        shipment_amount: sql<string>`(select coalesce(sum(amount),0) from invoice_lines where invoice_id = ${invoice.id} and shipment_id is not null)`,
        return_amount: sql<string>`(select coalesce(-sum(amount),0) from invoice_lines where invoice_id = ${invoice.id} and return_id is not null)`,
        current_receipt_amount: sql<string>`(select coalesce(sum(amount),0) from cash_receipts where partner_id = ${partnerId} and currency = ${currency} and receipt_date >= ${period.from} and receipt_date <= ${period.to})`,
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
      .select(['id', 'invoice_no', 'currency', 'shipment_amount', 'return_amount', 'shipping_fee_amount', 'current_invoice_amount', 'current_balance'])
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

  /**
   * 請求書の一覧。
   *
   * 取り消した請求も「取消」として並べる（どの番号をいつ取り消したかを見ていただくため）。
   * 売掛残高一覧（exclude_cancelled）だけは取消を外す。取り消した請求を残高に数えると、
   * 同じ期間の請求が2行並んで当月請求額も残高も二重になってしまう。
   */
  async listInvoices(query: {
    partner_id?: number;
    status?: string;
    period_to?: string;
    /** 売掛残高一覧のように、取り消した請求を数えてはいけないときに true。 */
    exclude_cancelled?: boolean;
    limit: number;
    offset: number;
  }): Promise<Paged<Record<string, unknown>>> {
    let base = this.db.selectFrom('invoices as i').innerJoin('partners as p', 'p.id', 'i.partner_id');
    if (query.partner_id !== undefined) base = base.where('i.partner_id', '=', query.partner_id);
    if (query.status) base = base.where('i.status', '=', query.status);
    if (query.period_to) base = base.where('i.period_to', '=', query.period_to);
    if (query.exclude_cancelled) base = base.where('i.status', '<>', '取消');

    const [items, total] = await Promise.all([
      base
        .select([
          'i.id as id',
          'i.invoice_no as invoice_no',
          'i.status as status',
          'i.period_from as period_from',
          'i.period_to as period_to',
          // 通貨（2026-10-12 No.39）。一覧・売掛残高の金額に添え、合計は通貨ごとに出す
          'i.currency as currency',
          'p.partner_code as partner_code',
          'p.name1 as partner_name',
          // 売掛残高一覧の12項目。現行と同じ並び。
          'i.prev_invoice_balance as prev_invoice_balance',
          // 入金は締めたあとに登録されることもあるので、一覧では数え直す。
          // 締め時点の値をそのまま返すと、入金しても売掛残高が減らず、
          // 入金済みと未入金が画面で区別できない。
          RECEIPT_IN_PERIOD.as('current_receipt_amount'),
          sql<string>`i.prev_invoice_balance - ${RECEIPT_IN_PERIOD}`.as('carryover_balance'),
          'i.shipment_amount as shipment_amount',
          'i.return_amount as return_amount',
          'i.unposted_10 as unposted_10',
          'i.unposted_8 as unposted_8',
          'i.fee_amount as fee_amount',
          'i.adjust_10 as adjust_10',
          'i.adjust_8 as adjust_8',
          'i.shipping_fee_amount as shipping_fee_amount',
          'i.current_invoice_amount as current_invoice_amount',
          sql<string>`i.prev_invoice_balance - ${RECEIPT_IN_PERIOD} + i.current_invoice_amount`.as('current_balance'),
          // この請求に消し込んだ入金の合計と、その残り。入金消込の「消込先の請求」で、一部入金を続けて入れるときの目安
          // （今回請求残高は締めた時点の値なので、消し込んでも変わらない。再テスト R1 N3）
          sql<string>`coalesce((select sum(cr.applied_amount) from cash_receipts cr where cr.invoice_id = i.id), 0)`.as('applied_amount'),
          sql<string>`i.prev_invoice_balance - ${RECEIPT_IN_PERIOD} + i.current_invoice_amount
                      - coalesce((select sum(cr.applied_amount) from cash_receipts cr where cr.invoice_id = i.id), 0)`.as('unapplied_balance'),
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
    if (invoice.status === '取消') {
      throw new ConflictException(
        `${invoice.invoice_no} は取り消された請求です。締め処理でこの期間を締め直し、新しくできた請求書を発行してください`,
      );
    }

    await this.db
      .updateTable('invoices')
      .set({ status: '発行済', issued_at: new Date(), updated_by: userId, updated_at: new Date() })
      .where('id', '=', id)
      .execute();

    return { id, invoice_no: invoice.invoice_no, status: '発行済' };
  }

  /**
   * 請求の取消。
   *
   * 発行済の請求を締め直したいときに使う。消してしまうと請求番号と履歴が
   * 追えなくなるため、状態を「取消」にして残す（スキーマの ck_invoices_status
   * が許容している3つ目の状態）。取消にすると同じ期間で締め直せるようになり、
   * 締め直すと取消の行はそのまま残したまま、新しい請求番号の請求が作られる。
   * 売掛元帳はその場で取り消す（締め直せば作り直される）。
   */
  async cancelInvoice(id: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const invoice = await trx
        .selectFrom('invoices')
        .select(['id', 'invoice_no', 'status', 'partner_id', 'period_to'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!invoice) throw new NotFoundException(`請求が見つかりません（ID: ${id}）`);
      if (invoice.status === '取消') throw new ConflictException('すでに取り消されています');

      await trx
        .updateTable('invoices')
        .set({ status: '取消', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      // 売掛元帳からも外す（締め直せば作り直される）
      await trx
        .deleteFrom('ar_ledgers')
        .where('partner_id', '=', invoice.partner_id)
        .where('period_to', '=', invoice.period_to)
        .execute();

      return { id, invoice_no: invoice.invoice_no, status: '取消' };
    });
  }

  /** 入金登録と消込。請求を指定すると、その請求に充当した額として記録する。 */
  async createCashReceipt(input: CashReceiptInput, userId: number) {
    assertReceiptAmount(input.amount);

    // 通貨（2026-10-12 No.39）。指定が無ければ消込先の請求の通貨、請求も無ければ取引先の通貨。
    let currency = input.currency;
    if (input.invoice_id) {
      const invoice = await this.db
        .selectFrom('invoices')
        .select(['id', 'partner_id', 'invoice_no', 'status', 'currency'])
        .where('id', '=', input.invoice_id)
        .executeTakeFirst();
      if (!invoice) throw new NotFoundException('消込先の請求が見つかりません');
      if (invoice.partner_id !== input.partner_id) {
        throw new BadRequestException('入金の取引先と請求の取引先が違います');
      }
      // 取り消した請求に消し込んでも売掛残高に入らないので、先に選び直していただく。
      if (invoice.status === '取消') {
        throw new BadRequestException(
          `${invoice.invoice_no} は取り消された請求です。締め直してできた請求を消込先に選んでください`,
        );
      }
      currency ??= invoice.currency;
      assertSameCurrency(currency, invoice.currency, invoice.invoice_no);
    }
    if (currency === undefined) {
      const partner = await this.db
        .selectFrom('partners')
        .select('currency')
        .where('id', '=', input.partner_id)
        .executeTakeFirst();
      currency = partner?.currency ?? 'JPY';
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
        currency,
        invoice_id: input.invoice_id ?? null,
        applied_amount: applied,
        note: input.note ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'amount', 'currency', 'applied_amount'])
      .executeTakeFirstOrThrow();
  }

  /**
   * 入金の訂正。
   *
   * 入金は「振り込まれた事実」の記録なので、消し込んだ請求が発行済でも直せる
   * （入力を間違えたまま直せないと、売掛残高がいつまでも実態と合わない）。
   * 売掛残高一覧は入金を期間で数え直して出しているため（RECEIPT_IN_PERIOD）、
   * 金額や入金日を直せばそのまま残高に反映される。請求書そのものは送付済みの
   * 書類なので、締め時点の値（invoices の列）は触らない。
   */
  async updateCashReceipt(id: number, input: CashReceiptUpdateInput, userId: number) {
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('更新する項目がありません');
    }
    if (input.amount !== undefined) assertReceiptAmount(input.amount);

    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('cash_receipts')
        .select(['id', 'partner_id', 'amount', 'currency', 'applied_amount', 'invoice_id', 'cash_transaction_id'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!current) throw new NotFoundException(`入金が見つかりません（ID: ${id}）`);

      // 入出金処理（出納帳）に取り込まれた入金をここで直すと、出納帳と食い違う。
      if (current.cash_transaction_id) {
        throw new ConflictException(
          'この入金は入出金処理に取り込まれているため、ここでは直せません。入出金処理の画面で直してください',
        );
      }

      const nextInvoiceId =
        'invoice_id' in clean ? ((clean.invoice_id as number | null | undefined) ?? null) : current.invoice_id;
      const nextAmount = (clean.amount as string | undefined) ?? current.amount;

      // 消込先を付け替えるときは取引先の一致を確かめる（登録時と同じ確認）。
      // 他社の請求に消し込むと、どちらの売掛残高も合わなくなる。
      const nextCurrency = (clean.currency as string | undefined) ?? current.currency;
      // 登録済みの入金の通貨は、消込先を選んだついでには変えない（2026-10-13 再テスト N1）。
      // 円 5,000 の入金をドルの請求に付け替えると同時に通貨を USD にすると、USD 5,000 として消し込まれ、
      // 請求の残高がマイナスになっていた。通貨を直すのは消込を外した状態のときだけ（入力の誤りを直す用）。
      if (nextCurrency !== current.currency && nextInvoiceId !== null) {
        throw new BadRequestException(
          `消し込んだまま入金の通貨は直せません（${current.currency} → ${nextCurrency}）。` +
            '通貨が違う請求には消し込めないので、消込先を「消し込まない」にして通貨を直すか、入金を削除して入れ直してください',
        );
      }
      if (nextInvoiceId !== null && nextInvoiceId !== current.invoice_id) {
        const invoice = await trx
          .selectFrom('invoices')
          .select(['id', 'partner_id', 'invoice_no', 'status', 'currency'])
          .where('id', '=', nextInvoiceId)
          .executeTakeFirst();
        if (!invoice) throw new NotFoundException('消込先の請求が見つかりません');
        if (invoice.partner_id !== current.partner_id) {
          throw new BadRequestException('入金の取引先と請求の取引先が違います');
        }
        // 取り消した請求に消し込んでも売掛残高に入らないので、先に選び直していただく。
        if (invoice.status === '取消') {
          throw new BadRequestException(
            `${invoice.invoice_no} は取り消された請求です。締め直してできた請求を消込先に選んでください`,
          );
        }
        assertSameCurrency(nextCurrency, invoice.currency, invoice.invoice_no);
      }

      // 消込額は画面から直接いただかないので、ここで辻褄を合わせる。
      // 入金日や備考だけを直したときに消込額が動くと驚かれるので、
      // 金額か消込先が変わったときだけ計算し直す。
      // 金額の比較だけ数値に直す（保存する値は NUMERIC の文字列のまま）。
      let nextApplied = current.applied_amount;
      if ('amount' in clean || 'invoice_id' in clean) {
        if (nextInvoiceId === null) {
          nextApplied = '0'; // 消込を外したら消込額も戻す
        } else if (current.invoice_id === null || Number(current.applied_amount) >= Number(current.amount)) {
          nextApplied = nextAmount; // 新たに消し込む／これまで全額消込だったものは新しい金額に合わせる
        } else if (Number(current.applied_amount) > Number(nextAmount)) {
          nextApplied = nextAmount; // 一部消込。金額を減らしたら消込額が入金額を超えないよう詰める
        }
      }

      await trx
        .updateTable('cash_receipts')
        .set({ ...clean, applied_amount: nextApplied, updated_by: userId, updated_at: new Date() } as never)
        .where('id', '=', id)
        .execute();

      return trx
        .selectFrom('cash_receipts as c')
        .leftJoin('invoices as i', 'i.id', 'c.invoice_id')
        .selectAll('c')
        .select('i.invoice_no as invoice_no')
        .where('c.id', '=', id)
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * 入金の削除。
   *
   * 消し込んだ請求が発行済でも消せる。入金そのものが無かったと分かったときに
   * 消せないと、売掛残高が実態と合わないまま残ってしまうため。
   * 売掛残高一覧は入金を期間で数え直しているので、消せばその分の残高が戻る。
   */
  async removeCashReceipt(id: number) {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('cash_receipts')
        .select(['id', 'cash_transaction_id'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!current) throw new NotFoundException(`入金が見つかりません（ID: ${id}）`);

      // 出納帳に取り込まれた入金を黙って消すと、帳簿側だけが残って合わなくなる。
      if (current.cash_transaction_id) {
        throw new ConflictException(
          'この入金は入出金処理に取り込まれているため、削除できません。入出金処理の画面で取り消してから、もう一度お試しください',
        );
      }

      await trx.deleteFrom('cash_receipts').where('id', '=', id).execute();

      return { id, deleted: true };
    });
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
          'c.currency as currency',
          'c.applied_amount as applied_amount',
          sql<string>`c.amount - c.applied_amount`.as('unapplied_amount'),
          'c.partner_id as partner_id',
          'p.name1 as partner_name',
          // 訂正の画面で「どの請求に消し込んだか」「備考に何を書いたか」を
          // そのまま開き直せるよう、番号だけでなく id と備考も返す。
          'c.invoice_id as invoice_id',
          'i.invoice_no as invoice_no',
          'c.note as note',
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

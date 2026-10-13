import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';

import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import { ROYALTY_GOODS_LINE, royaltyAmount, royaltyRuleFor } from './royalty-rule.sql';

/**
 * 機能ID Y-02 ロイヤリティ計算
 *
 * 貴社ご回答（2026/09/10）により確定した3点。
 *   1. 出荷金額をもとに計算する
 *   2. 販売先への卸金額に料率をかける
 *   3. 返品はマイナスの出荷金額として同じ月に反映し、その分だけ差し引く
 * いずれも system_settings に持たせてあり、設定を変えれば計算も変わる。
 *
 * どの規定を当てるかは royalty_rules の scope_priority が決める（royalty-rule.sql.ts。販売実績と共通）。
 * 販売先を指定した行は、指定していない行より優先される。
 *
 * 規定の「計算の基準」で、どの月に計上するかが変わる（2026-10-12 T3 No.33。以前は常に出荷で計算していた）。
 *   出荷 … 出荷日の月　／　売上 … その出荷を載せた請求の締め日の月　／　入金 … 請求に入金（消込）された月に、入金の割合で按分
 */
/**
 * 計算表の「基準」の表示。当てた規定の基準を「出荷・入金」のように全部並べる。
 * 計算表の列（calc_base）は1つしか持てないため、基準の違う規定が混ざった月はここで補う。
 * 明細の無い計算表は列の値のまま。
 */
const CALC_BASE_LABEL = sql<string>`coalesce((
  select string_agg(b.calc_base, '・' order by array_position(array['出荷', '売上', '入金']::text[], b.calc_base::text))
    from (select distinct rr.calc_base
            from royalty_calculation_lines l
            join royalty_rules rr on rr.id = l.royalty_rule_id
           where l.royalty_calculation_id = c.id) b
), c.calc_base)`;

@Injectable()
export class RoyaltyService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly settings: SettingsService,
  ) {}

  async calculate(targetMonth: string, userId: number) {
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      throw new BadRequestException('対象年月は YYYY-MM の形式で指定してください');
    }
    const monthStart = `${targetMonth}-01`;
    const roundingMode = await this.settings.text('ROYALTY_ROUNDING_MODE', 'floor');
    const includeReturns = await this.settings.bool('ROYALTY_INCLUDE_RETURNS', true);

    // 有効な規定を持つ支払先に加えて、この月に確定前の計算表がある支払先も計算し直す。
    // 規定をすべて「使わない」にした支払先の計算表が、古い金額のまま残らないようにするため。
    const payees = await this.db
      .selectFrom('partners as p')
      .select(['p.id as id', 'p.name1 as name'])
      .where((eb) =>
        eb.or([
          eb.exists(
            eb.selectFrom('royalty_rules as r').select('r.id').whereRef('r.payee_partner_id', '=', 'p.id').where('r.is_active', '=', true),
          ),
          eb.exists(
            eb
              .selectFrom('royalty_calculations as c')
              .select('c.id')
              .whereRef('c.payee_partner_id', '=', 'p.id')
              .where('c.target_month', '=', monthStart)
              .where('c.status', '<>', '確定'),
          ),
        ]),
      )
      .orderBy('p.id')
      .execute();

    if (payees.length === 0) throw new BadRequestException('ロイヤリティ規定が登録されていません');

    // 確定済みの支払先は計算し直さずに飛ばし、ほかの支払先は計算する。
    // 以前は1社でも確定していると途中で 409 になり、それより前の支払先だけ計算し直された状態で止まっていた。
    const confirmed = await this.db
      .selectFrom('royalty_calculations')
      .select('payee_partner_id')
      .where('target_month', '=', monthStart)
      .where('status', '=', '確定')
      .execute();
    const confirmedIds = new Set(confirmed.map((c) => Number(c.payee_partner_id)));
    const skipped = payees.filter((p) => confirmedIds.has(Number(p.id))).map((p) => p.name);
    const targets = payees.filter((p) => !confirmedIds.has(Number(p.id)));
    if (targets.length === 0) {
      throw new ConflictException(`${monthStart} 分は、すべての支払先がすでに確定しています`);
    }

    const results = [];
    for (const payee of targets) {
      results.push(
        await this.db
          .transaction()
          .execute((trx) => this.calculateOne(trx, payee.id, payee.name, monthStart, roundingMode, includeReturns, userId)),
      );
    }
    return { target_month: targetMonth, payees: results.length, calculations: results, skipped_confirmed: skipped };
  }

  private async calculateOne(
    trx: Transaction<DB>,
    payeeId: number,
    payeeName: string,
    monthStart: string,
    roundingMode: string,
    includeReturns: boolean,
    userId: number,
  ) {
    const existing = await trx
      .selectFrom('royalty_calculations')
      .select(['id', 'status'])
      .where('target_month', '=', monthStart)
      .where('payee_partner_id', '=', payeeId)
      .executeTakeFirst();

    if (existing?.status === '確定') {
      throw new ConflictException(`${payeeName} の ${monthStart} 分はすでに確定しています`);
    }
    if (existing) {
      await trx.deleteFrom('royalty_calculations').where('id', '=', existing.id).execute();
    }

    const calc = await trx
      .insertInto('royalty_calculations')
      .values({
        target_month: monthStart,
        payee_partner_id: payeeId,
        calc_base: '出荷',
        status: '計算済',
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // 規定の当たる明細を、規定の「計算の基準」ごとに、その月に計上する分だけ拾う。
    // どの規定を当てるかは取引の日（出荷日・返品日）で決める（royaltyRuleFor）。基準はどの月に計上するかを決める。
    //   出荷 … 出荷日がこの月の出荷
    //   売上 … この月に締めた請求（締め日がこの月。取り消した請求は除く）に載った出荷。売上はこのシステムでは締めで計上する
    //   入金 … この月に入金（消込）された額を、その請求に載った明細の金額の割合で按分した分（一部入金も按分）
    // 返品（設定 ROYALTY_INCLUDE_RETURNS）は、どの基準でも出荷と同じ扱いでマイナスにする
    // （出荷＝返品日の月、売上＝返品を載せた請求の締め日の月、入金＝返品を載せた請求への入金の月）。
    //
    // 金額の元は受注明細（＝請求・納品書と同じ土台）。出荷明細（shipment_lines）は
    // 倉庫から出たものの記録で、セット商品は構成品ごとにセットの単価を持つため、
    // そのまま使うと構成品の数だけ課税基礎が膨らむ。
    // なおセット商品の行は「セット商品そのもの」のブランド・商品で規定を当てる。
    // 構成品側のブランドで規定を当てたい場合は、セット商品にそのブランドを設定する。
    const saleRule = royaltyRuleFor({
      payee: payeeId,
      date: sql`sh.ship_date`,
      brandId: sql`p.brand_id`,
      productId: sql`p.id`,
      customerId: sql`o.partner_id`,
    });
    const returnRule = royaltyRuleFor({
      payee: payeeId,
      date: sql`r.return_date`,
      brandId: sql`p.brand_id`,
      productId: sql`p.id`,
      customerId: sql`r.partner_id`,
    });
    // 受注ごとに最初の出荷（受注と出荷は1対1が基本。分納・取込経路で2本あっても明細を倍に数えない）
    const firstShipment = sql`
      join lateral (
        select sh0.id, sh0.ship_date
          from shipments sh0
         where sh0.sales_order_id = sl.sales_order_id
           and sh0.status = '出荷済'
         order by sh0.ship_date, sh0.id
         limit 1
      ) sh on true`;
    const inMonth = (col: RawBuilder<unknown>) => sql`date_trunc('month', ${col}) = ${monthStart}::date`;

    // 入金基準: この月の入金を請求ごとに割合（入金額 ÷ 請求額）にする。
    // 請求額は当月請求額（税・送料込み）なので、全額入金されると明細の金額がそのまま基準額になる。
    // 入金が請求額を超えた分（過入金）は数えない（それまでの入金の累計で頭打ちにする）。
    const paidRatio = sql`(
      select x.invoice_id, sum(x.ratio) as ratio
        from (
          select cr.invoice_id, cr.receipt_date,
                 (least(sum(cr.applied_amount) over w, i.current_invoice_amount)
                  - least(sum(cr.applied_amount) over w - cr.applied_amount, i.current_invoice_amount))
                 / i.current_invoice_amount as ratio
            from cash_receipts cr
            join invoices i on i.id = cr.invoice_id
           where i.status <> '取消'
             and i.current_invoice_amount > 0
             and cr.applied_amount > 0
          window w as (partition by cr.invoice_id order by cr.receipt_date, cr.id)
        ) x
       where ${inMonth(sql`x.receipt_date`)}
       group by x.invoice_id
      having sum(x.ratio) > 0
    )`;

    const sources: RawBuilder<unknown>[] = [
      // 出荷基準の出荷
      sql`
        select 'sale' as kind, o.partner_id as customer_id, p.brand_id, sl.sku_id, rule.id as rule_id,
               rule.rate, rule.fixed_amount, sl.qty, sl.amount
          from sales_order_lines sl
          ${firstShipment}
          join sales_orders o on o.id = sl.sales_order_id
          join skus s on s.id = sl.sku_id
          join products p on p.id = s.product_id
          join lateral ${saleRule} rule on true
         where ${ROYALTY_GOODS_LINE}
           and o.is_billable
           and not rule.is_excluded
           and rule.calc_base = '出荷'
           and ${inMonth(sql`sh.ship_date`)}`,
      // 売上基準の出荷（この月に締めた請求に載ったもの）
      sql`
        select 'sale', o.partner_id, p.brand_id, sl.sku_id, rule.id, rule.rate, rule.fixed_amount, sl.qty, sl.amount
          from sales_order_lines sl
          ${firstShipment}
          join sales_orders o on o.id = sl.sales_order_id
          join skus s on s.id = sl.sku_id
          join products p on p.id = s.product_id
          join lateral ${saleRule} rule on true
         where ${ROYALTY_GOODS_LINE}
           and o.is_billable
           and not rule.is_excluded
           and rule.calc_base = '売上'
           and exists (
             select 1
               from invoice_lines il
               join invoices i on i.id = il.invoice_id
               join shipments sh1 on sh1.id = il.shipment_id
              where sh1.sales_order_id = sl.sales_order_id
                and i.status <> '取消'
                and ${inMonth(sql`i.closing_date`)})`,
      // 入金基準の出荷（この月の入金で按分）
      sql`
        select 'sale', o.partner_id, p.brand_id, sl.sku_id, rule.id, rule.rate, rule.fixed_amount,
               sl.qty * pr.ratio, sl.amount * pr.ratio
          from ${paidRatio} pr
          join lateral (
            select distinct il.shipment_id from invoice_lines il
             where il.invoice_id = pr.invoice_id and il.shipment_id is not null
          ) ish on true
          join shipments sh on sh.id = ish.shipment_id
          join sales_order_lines sl on sl.sales_order_id = sh.sales_order_id
          join sales_orders o on o.id = sl.sales_order_id
          join skus s on s.id = sl.sku_id
          join products p on p.id = s.product_id
          join lateral ${saleRule} rule on true
         where ${ROYALTY_GOODS_LINE}
           and o.is_billable
           and not rule.is_excluded
           and rule.calc_base = '入金'`,
    ];

    // 返品はマイナスの金額として、出荷と同じ基準で反映する（設定 ROYALTY_INCLUDE_RETURNS）
    if (includeReturns) {
      const returnFrom = sql`
          from return_lines rl
          join returns r on r.id = rl.return_id
          join skus s on s.id = rl.sku_id
          join products p on p.id = s.product_id
          join lateral ${returnRule} rule on true`;
      sources.push(
        sql`
          select 'return', r.partner_id, p.brand_id, rl.sku_id, rule.id, rule.rate, rule.fixed_amount,
                 -rl.qty, -(rl.qty * rl.unit_price)
          ${returnFrom}
           where r.status <> '取消'
             and not rule.is_excluded
             and rule.calc_base = '出荷'
             and ${inMonth(sql`r.return_date`)}`,
        sql`
          select 'return', r.partner_id, p.brand_id, rl.sku_id, rule.id, rule.rate, rule.fixed_amount,
                 -rl.qty, -(rl.qty * rl.unit_price)
          ${returnFrom}
           where r.status <> '取消'
             and not rule.is_excluded
             and rule.calc_base = '売上'
             and exists (
               select 1
                 from invoice_lines il
                 join invoices i on i.id = il.invoice_id
                where il.return_id = r.id
                  and i.status <> '取消'
                  and ${inMonth(sql`i.closing_date`)})`,
        sql`
          select 'return', r.partner_id, p.brand_id, rl.sku_id, rule.id, rule.rate, rule.fixed_amount,
                 -rl.qty * pr.ratio, -(rl.qty * rl.unit_price) * pr.ratio
            from ${paidRatio} pr
            join lateral (
              select distinct il.return_id from invoice_lines il
               where il.invoice_id = pr.invoice_id and il.return_id is not null
            ) irt on true
            join returns r on r.id = irt.return_id
            join return_lines rl on rl.return_id = r.id
            join skus s on s.id = rl.sku_id
            join products p on p.id = s.product_id
            join lateral ${returnRule} rule on true
           where r.status <> '取消'
             and not rule.is_excluded
             and rule.calc_base = '入金'`,
      );
    }

    // 販売先 × ブランド × SKU × 規定 ごとに1行。出荷と返品は別の行にし、それぞれの行で端数を処理する
    // （返品は「返品の金額 × 料率」の端数を落としてからマイナスにする。以前と同じ結果になる）。
    // 基準の違う規定が混ざっていても、規定ごとに行が分かれるのでそのまま合算できる。
    await sql`
      insert into royalty_calculation_lines
        (royalty_calculation_id, customer_partner_id, brand_id, sku_id, royalty_rule_id,
         qty, base_amount, rate, fixed_amount, royalty_amount)
      select ${calc.id}, src.customer_id, src.brand_id, src.sku_id, src.rule_id,
             sum(src.qty), sum(src.amount), src.rate, src.fixed_amount,
             ${royaltyAmount(sql`src.rate`, sql`src.fixed_amount`, sql`sum(src.amount)`, sql`sum(src.qty)`, roundingMode)}
        from (${sql.join(sources, sql` union all `)}) src
       group by src.kind, src.customer_id, src.brand_id, src.sku_id, src.rule_id, src.rate, src.fixed_amount
    `.execute(trx);

    // 計算表の「基準」。当てた規定の基準をそのまま入れる。基準の違う規定が混ざったときは
    // 計上した金額の大きい基準を入れ、一覧・明細では当てた規定から「出荷・入金」のように全部を出す（list・findOne）。
    // 明細が1行も無い月は、この支払先の有効な規定の基準（混ざっていれば「出荷」）。
    const bases = await trx
      .selectFrom('royalty_calculation_lines as l')
      .innerJoin('royalty_rules as rr', 'rr.id', 'l.royalty_rule_id')
      .select(['rr.calc_base as calc_base', sql<string>`sum(abs(l.base_amount))`.as('amount')])
      .where('l.royalty_calculation_id', '=', calc.id)
      .groupBy('rr.calc_base')
      .orderBy(sql`sum(abs(l.base_amount))`, 'desc')
      .execute();
    let calcBase = bases[0]?.calc_base;
    if (!calcBase) {
      const ruleBases = await trx
        .selectFrom('royalty_rules')
        .select('calc_base')
        .distinct()
        .where('payee_partner_id', '=', payeeId)
        .where('is_active', '=', true)
        .execute();
      calcBase = ruleBases.length === 1 ? ruleBases[0].calc_base : '出荷';
    }

    await trx
      .updateTable('royalty_calculations')
      .set({
        calc_base: calcBase,
        total_base_amount: sql<string>`(select coalesce(sum(base_amount),0) from royalty_calculation_lines where royalty_calculation_id = ${calc.id})`,
        total_amount: sql<string>`(select coalesce(sum(royalty_amount),0) from royalty_calculation_lines where royalty_calculation_id = ${calc.id})`,
      })
      .where('id', '=', calc.id)
      .execute();

    const totals = await trx
      .selectFrom('royalty_calculations')
      .select(['id', 'total_base_amount', 'total_amount'])
      .where('id', '=', calc.id)
      .executeTakeFirstOrThrow();

    const lineCount = await trx
      .selectFrom('royalty_calculation_lines')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('royalty_calculation_id', '=', calc.id)
      .executeTakeFirstOrThrow();

    return { payee_partner_id: payeeId, payee_name: payeeName, ...totals, lines: Number(lineCount.n) };
  }

  async list(query: { target_month?: string; payee_partner_id?: number }) {
    let base = this.db
      .selectFrom('royalty_calculations as c')
      .innerJoin('partners as p', 'p.id', 'c.payee_partner_id');
    if (query.target_month) base = base.where('c.target_month', '=', `${query.target_month}-01`);
    if (query.payee_partner_id !== undefined) base = base.where('c.payee_partner_id', '=', query.payee_partner_id);

    return base
      .select([
        'c.id as id',
        'c.target_month as target_month',
        'p.name1 as payee_name',
        CALC_BASE_LABEL.as('calc_base'),
        'c.total_base_amount as total_base_amount',
        'c.total_amount as total_amount',
        'c.status as status',
        'c.confirmed_at as confirmed_at',
      ])
      .orderBy('c.target_month', 'desc')
      .orderBy('p.name1', 'asc')
      .execute();
  }

  /** 計算表の中身。販売先別の内訳と、その下の商品別明細。 */
  async findOne(id: number) {
    const header = await this.db
      .selectFrom('royalty_calculations as c')
      .innerJoin('partners as p', 'p.id', 'c.payee_partner_id')
      .selectAll('c')
      .select(['p.name1 as payee_name', CALC_BASE_LABEL.as('calc_base')])
      .where('c.id', '=', id)
      .executeTakeFirst();

    if (!header) throw new NotFoundException(`ロイヤリティ計算が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('royalty_calculation_lines as l')
      .leftJoin('partners as cp', 'cp.id', 'l.customer_partner_id')
      .leftJoin('brands as b', 'b.id', 'l.brand_id')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('royalty_rules as rr', 'rr.id', 'l.royalty_rule_id')
      .select([
        // 当てた規定の計算の基準（出荷／売上／入金）
        'rr.calc_base as calc_base',
        'cp.name1 as customer_name',
        'b.name as brand_name',
        's.sku_code as sku_code',
        // SKU ごとの商品名があればそれ、無ければ商品名（2026-10-09 マスター編②）
        sql<string>`coalesce(nullif(btrim(s.sku_name), ''), pr.product_name)`.as('product_name'),
        'l.qty as qty',
        'l.base_amount as base_amount',
        'l.rate as rate',
        'l.royalty_amount as royalty_amount',
      ])
      .where('l.royalty_calculation_id', '=', id)
      .orderBy('cp.name1', 'asc')
      .orderBy('s.sku_code', 'asc')
      .execute();

    // 販売先別の小計。計算表はこの単位で見ていただく。
    const byCustomer = await this.db
      .selectFrom('royalty_calculation_lines as l')
      .leftJoin('partners as cp', 'cp.id', 'l.customer_partner_id')
      .select([
        'cp.name1 as customer_name',
        sql<string>`sum(l.qty)`.as('qty'),
        sql<string>`sum(l.base_amount)`.as('base_amount'),
        sql<string>`sum(l.royalty_amount)`.as('royalty_amount'),
      ])
      .where('l.royalty_calculation_id', '=', id)
      .groupBy('cp.name1')
      .orderBy('cp.name1', 'asc')
      .execute();

    return { ...header, by_customer: byCustomer, lines };
  }

  async confirm(id: number, userId: number) {
    const calc = await this.db
      .selectFrom('royalty_calculations')
      .select(['id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!calc) throw new NotFoundException(`ロイヤリティ計算が見つかりません（ID: ${id}）`);
    if (calc.status === '確定') throw new ConflictException('すでに確定しています');

    await this.db
      .updateTable('royalty_calculations')
      .set({ status: '確定', confirmed_at: new Date(), updated_by: userId, updated_at: new Date() })
      .where('id', '=', id)
      .execute();

    return { id, status: '確定' };
  }
}

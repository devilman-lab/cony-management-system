import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';

/**
 * 機能ID Y-02 ロイヤリティ計算
 *
 * 貴社ご回答（2026/09/10）により確定した3点。
 *   1. 出荷金額をもとに計算する
 *   2. 販売先への卸金額に料率をかける
 *   3. 返品はマイナスの出荷金額として同じ月に反映し、その分だけ差し引く
 * いずれも system_settings に持たせてあり、設定を変えれば計算も変わる。
 *
 * どの規定を当てるかは royalty_rules の scope_priority が決める。
 * 販売先を指定した行は、指定していない行より優先される。
 */
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

    // 出荷した受注の明細を、規定が当たるものだけ拾う。
    // 規定は「販売先 → 商品 → ブランド」の順に細かいものを優先する（scope_priority）。
    //
    // 金額の元は受注明細（＝請求・納品書と同じ土台）。出荷明細（shipment_lines）は
    // 倉庫から出たものの記録で、セット商品は構成品ごとにセットの単価を持つため、
    // そのまま使うと構成品の数だけ課税基礎が膨らむ。
    // なおセット商品の行は「セット商品そのもの」のブランド・商品で規定を当てる。
    // 構成品側のブランドで規定を当てたい場合は、セット商品にそのブランドを設定する。
    const applied = sql`
      lateral (
        select rr.id, rr.rate, rr.fixed_amount, rr.is_excluded
          from royalty_rules rr
         where rr.payee_partner_id = ${payeeId}
           and rr.is_active
           and rr.valid_from <= sh.ship_date
           and (rr.valid_to is null or rr.valid_to >= sh.ship_date)
           and (rr.brand_id is null or rr.brand_id = p.brand_id)
           and (rr.product_id is null or rr.product_id = p.id)
           and (rr.customer_partner_id is null or rr.customer_partner_id = o.partner_id)
           -- 媒体。取引先マスタの媒体と突き合わせる。空欄の規定はすべての媒体に当たる（1001 ご要望）
           and (rr.media_id is null
                or rr.media_id = (select pa.media_id from partners pa where pa.id = o.partner_id))
         -- 媒体を指定した規定を、指定していないものより先に当てる
         order by (rr.media_id is not null) desc, rr.scope_priority desc, rr.valid_from desc
         limit 1
      ) rule
    `;

    await sql`
      insert into royalty_calculation_lines
        (royalty_calculation_id, customer_partner_id, brand_id, sku_id, royalty_rule_id,
         qty, base_amount, rate, fixed_amount, royalty_amount)
      select ${calc.id}, o.partner_id, p.brand_id, sl.sku_id, rule.id,
             sum(sl.qty), sum(sl.amount), rule.rate, rule.fixed_amount,
             fn_round_amount(
               case when rule.rate is not null then sum(sl.amount) * rule.rate
                    else coalesce(rule.fixed_amount, 0) * sum(sl.qty) end,
               ${roundingMode})
        from sales_order_lines sl
        join lateral (
          select sh0.id, sh0.ship_date
            from shipments sh0
           where sh0.sales_order_id = sl.sales_order_id
             and sh0.status = '出荷済'
           order by sh0.ship_date, sh0.id
           limit 1
        ) sh on true
        join sales_orders o on o.id = sl.sales_order_id
        join skus s on s.id = sl.sku_id
        join products p on p.id = s.product_id
        join ${applied} on true
       where (sl.line_type in ('商品', 'セット商品')
              or (sl.line_type = '内訳商品' and sl.parent_line_no is null))
         and o.is_billable
         and date_trunc('month', sh.ship_date) = ${monthStart}::date
         and not rule.is_excluded
       group by o.partner_id, p.brand_id, sl.sku_id, rule.id, rule.rate, rule.fixed_amount
    `.execute(trx);

    // 返品はマイナスの出荷金額として同じ月に反映する（設定 ROYALTY_INCLUDE_RETURNS）
    if (includeReturns) {
      const appliedReturn = sql`
        lateral (
          select rr.id, rr.rate, rr.fixed_amount, rr.is_excluded
            from royalty_rules rr
           where rr.payee_partner_id = ${payeeId}
             and rr.is_active
             and rr.valid_from <= r.return_date
             and (rr.valid_to is null or rr.valid_to >= r.return_date)
             and (rr.brand_id is null or rr.brand_id = p.brand_id)
             and (rr.product_id is null or rr.product_id = p.id)
             and (rr.customer_partner_id is null or rr.customer_partner_id = r.partner_id)
             and (rr.media_id is null
                  or rr.media_id = (select pa.media_id from partners pa where pa.id = r.partner_id))
           order by (rr.media_id is not null) desc, rr.scope_priority desc, rr.valid_from desc
           limit 1
        ) rule
      `;
      await sql`
        insert into royalty_calculation_lines
          (royalty_calculation_id, customer_partner_id, brand_id, sku_id, royalty_rule_id,
           qty, base_amount, rate, fixed_amount, royalty_amount)
        select ${calc.id}, r.partner_id, p.brand_id, rl.sku_id, rule.id,
               -sum(rl.qty), -sum(rl.qty * rl.unit_price), rule.rate, rule.fixed_amount,
               -fn_round_amount(
                 case when rule.rate is not null then sum(rl.qty * rl.unit_price) * rule.rate
                      else coalesce(rule.fixed_amount, 0) * sum(rl.qty) end,
                 ${roundingMode})
          from return_lines rl
          join returns r on r.id = rl.return_id
          join skus s on s.id = rl.sku_id
          join products p on p.id = s.product_id
          join ${appliedReturn} on true
         where r.status <> '取消'
           and date_trunc('month', r.return_date) = ${monthStart}::date
           and not rule.is_excluded
         group by r.partner_id, p.brand_id, rl.sku_id, rule.id, rule.rate, rule.fixed_amount
      `.execute(trx);
    }

    await trx
      .updateTable('royalty_calculations')
      .set({
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
        'c.calc_base as calc_base',
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
      .select('p.name1 as payee_name')
      .where('c.id', '=', id)
      .executeTakeFirst();

    if (!header) throw new NotFoundException(`ロイヤリティ計算が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('royalty_calculation_lines as l')
      .leftJoin('partners as cp', 'cp.id', 'l.customer_partner_id')
      .leftJoin('brands as b', 'b.id', 'l.brand_id')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .select([
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

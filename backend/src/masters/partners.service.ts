import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { OVERSEAS_TAX_LABEL, SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';

export interface PartnerListQuery {
  q?: string;
  /** customer＝得意先、supplier＝仕入先、royalty_payee＝ロイヤリティの支払先 */
  role?: 'customer' | 'supplier' | 'royalty_payee';
  include_inactive?: boolean;
  /** 媒体・販売担当・カテゴリーで絞る（1001 ご要望）。 */
  media_id?: number;
  sales_staff_id?: number;
  partner_category_id?: number;
  limit: number;
  offset: number;
}

export interface PartnerListItem {
  id: number;
  partner_code: string;
  media_id?: number | null;
  media_name?: string | null;
  sales_staff_name?: string | null;
  partner_category_id?: number | null;
  category_names?: string | null;
  name1: string;
  short_name: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  /** 海外の取引先（2026-10-09 マスター編②）。仕入入力・受注入力で税の扱いを決めるのに使う。 */
  is_overseas: boolean;
  /** 取引先の消費税免税区分（exempt／non_taxable）。空ならシステム設定に従う（2026-10-16 マスター編_3 M3-07） */
  overseas_tax_treatment: string | null;
  /**
   * 消費税免税区分の呼び名（一覧の「消費税免税区分」の列と、受注入力の合計の横の表記）。
   * 海外でなければ null。取引先で選んでいなければシステム設定の呼び名。
   */
  overseas_tax_label: string | null;
  /** 粗利調整販社（区分値 GROSS_MARGIN_ADJUST の名称。対象／対象外）。一覧に出す（M3-04・M3-10） */
  gross_margin_adjust_name: string | null;
  /** 支払①（何か月後・何日。99＝末日）。一覧の「支払」の列に出す（M3-04） */
  payment_month_offset: number | null;
  payment_day: number | null;
  /** 取引通貨（区分値 CURRENCY のコード）。受注入力で得意先を選んだときに受注の通貨として出す（2026-10-12 No.39）。 */
  currency: string;
  closing_day: number | null;
  default_trade_type: string | null;
  /** 既定の販売担当。受注入力で取引先を選んだときに引き継ぐ。 */
  sales_staff_id: number | null;
  is_active: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class PartnersService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly settings: SettingsService,
  ) {}

  async list(query: PartnerListQuery): Promise<Paged<PartnerListItem>> {
    let base = this.db.selectFrom('partners');

    if (!query.include_inactive) {
      base = base.where('is_active', '=', true);
    }
    if (query.role === 'customer') {
      base = base.where('is_customer', '=', true);
    } else if (query.role === 'supplier') {
      base = base.where('is_supplier', '=', true);
    } else if (query.role === 'royalty_payee') {
      // ロイヤリティの支払先は得意先として登録されていることがあるため、
      // 得意先／仕入先ではなく専用の印で絞る（1001 ご要望）
      base = base.where('is_royalty_payee', '=', true);
    }
    // 媒体・販売担当・カテゴリーで絞る（1001 ご要望「媒体別、担当者で絞れるようにしてほしい」）
    if (query.media_id !== undefined) {
      base = base.where('media_id', '=', query.media_id);
    }
    if (query.sales_staff_id !== undefined) {
      base = base.where('sales_staff_id', '=', query.sales_staff_id);
    }
    if (query.partner_category_id !== undefined) {
      // カテゴリーは複数持てるので、ひも付けの表で見る
      const categoryId = query.partner_category_id;
      base = base.where((eb) =>
        eb.exists(
          eb
            .selectFrom('partner_category_links as pcl')
            .select('pcl.id')
            .whereRef('pcl.partner_id', '=', 'partners.id')
            .where('pcl.partner_category_id', '=', categoryId),
        ),
      );
    }
    if (query.q) {
      // 取引先コード・正式名称・略称のいずれかで部分一致
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('partner_code', 'ilike', like),
          eb('name1', 'ilike', like),
          eb('short_name', 'ilike', like),
        ]),
      );
    }

    const [rows, totalRow] = await Promise.all([
      base
        .select([
          'id',
          'partner_code',
          'name1',
          'short_name',
          'is_customer',
          'is_supplier',
          'is_overseas',
          'overseas_tax_treatment',
          'currency',
          'closing_day',
          'payment_month_offset',
          'payment_day',
          'default_trade_type',
          'sales_staff_id',
          'is_royalty_payee',
          'media_id',
          'partner_category_id',
          'is_active',
          (eb) => eb.selectFrom('media').select('media.name').whereRef('media.id', '=', 'partners.media_id').as('media_name'),
          (eb) =>
            eb
              .selectFrom('codes')
              .select('codes.name')
              .whereRef('codes.id', '=', 'partners.gross_margin_adjust_code_id')
              .as('gross_margin_adjust_name'),
          (eb) =>
            eb
              .selectFrom('sales_staff')
              .select('sales_staff.name')
              .whereRef('sales_staff.id', '=', 'partners.sales_staff_id')
              .as('sales_staff_name'),
          // カテゴリーは複数あるので、名前をまとめて1つの文字列にする
          (eb) =>
            eb
              .selectFrom('partner_category_links as pcl')
              .innerJoin('partner_categories as pc', 'pc.id', 'pcl.partner_category_id')
              .select(sql<string>`string_agg(pc.name, '、' order by pc.sort_order nulls last, pc.name)`.as('n'))
              .whereRef('pcl.partner_id', '=', 'partners.id')
              .as('category_names'),
        ])
        .orderBy('sort_order', sql`asc nulls last`)
        .orderBy('partner_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    // 消費税免税区分の呼び名。取引先で選んでいなければシステム設定のもの（M3-07）
    const defaultLabel = await this.settings.overseasTaxLabel();
    const items = rows.map((r) => ({
      ...r,
      overseas_tax_label: !r.is_overseas
        ? null
        : r.overseas_tax_treatment === 'exempt' || r.overseas_tax_treatment === 'non_taxable'
          ? OVERSEAS_TAX_LABEL[r.overseas_tax_treatment]
          : defaultLabel,
    }));

    return {
      items,
      total: Number(totalRow.n),
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * 1件の詳細。原価や仕入単価と違い取引先自体に機微な項目はないが、
   * 納品先は件数が多くなりうるので同時には返さない。
   */
  async findOne(id: number) {
    const partner = await this.db
      .selectFrom('partners')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!partner) {
      throw new NotFoundException(`取引先が見つかりません（ID: ${id}）`);
    }

    // カテゴリーは1取引先で複数持てる（TVとカタログ両方など。1001 ご要望）。
    // partners.partner_category_id は「代表のカテゴリー」として残してある。
    const links = await this.db
      .selectFrom('partner_category_links')
      .select('partner_category_id')
      .where('partner_id', '=', id)
      .orderBy('partner_category_id')
      .execute();

    return {
      ...partner,
      category_ids: links.map((l) => l.partner_category_id),
      // 編集画面の「消費税免税区分」に出す値（M3-07）。海外でなければ null（なし）。
      // 取引先で選ぶ前から海外にしてあった取引先は、今効いているシステム設定の値を出す（保存すると取引先に書く）
      overseas_tax_class: partner.is_overseas ? await this.settings.overseasTaxTreatment(partner.overseas_tax_treatment) : null,
    };
  }

  /**
   * その取引先にぶら下がる納品先。受注の入力で使う。
   * 納品先マスタの作業指示（名称・本文）も返す。受注入力で納品先を選んだら、その下に読むだけで出す
   * （2026-10-13 受注処理編 O-07）。
   */
  async deliveryDestinations(partnerId: number) {
    return this.db
      .selectFrom('delivery_destinations as d')
      .leftJoin('work_instructions as wi', 'wi.id', 'd.work_instruction_id')
      .select([
        'd.id as id',
        'd.delivery_code as delivery_code',
        'd.name as name',
        'd.partner_delivery_no as partner_delivery_no',
        'd.default_warehouse_id as default_warehouse_id',
        'd.is_active as is_active',
        'wi.name as work_instruction_name',
        'wi.instruction_body as work_instruction_body',
      ])
      .where('d.partner_id', '=', partnerId)
      .where('d.is_active', '=', true)
      .orderBy('d.sort_order', sql`asc nulls last`)
      .orderBy('d.delivery_code', 'asc')
      .execute();
  }
}

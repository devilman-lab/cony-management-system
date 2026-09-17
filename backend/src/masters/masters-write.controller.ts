import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { MastersCrudService, SIMPLE_MASTERS, type SimpleMaster } from './masters-crud.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');
const tax = z.enum(['0.00', '8.00', '10.00']);
const code = z.string().trim().min(1).max(40);

/** 更新時だけ受ける「有効に戻す」用。無効化は専用の経路、復活は PATCH で行う。 */
const Active = { is_active: z.boolean().optional() };

const ListSchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;

const PartnerProductListSchema = ListSchema.extend({
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
});
type PartnerProductListQuery = z.infer<typeof PartnerProductListSchema>;

const DestinationListSchema = ListSchema.extend({
  partner_id: z.coerce.number().int().positive().optional(),
});
type DestinationListQuery = z.infer<typeof DestinationListSchema>;

const PartnerProductLookupSchema = z.object({
  partner_id: z.coerce.number().int().positive(),
  sku_id: z.coerce.number().int().positive(),
});
type PartnerProductLookupQuery = z.infer<typeof PartnerProductLookupSchema>;

// ---- 分類マスタ（10種。同じ形なので1つの経路でまとめて扱う） -----------------
const SimpleSchema = z.object({
  code,
  name: z.string().trim().min(1).max(120),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
  // 納品ルールだけ追加の項目を持つ
  lead_time_days: z.number().int().min(0).max(365).nullish(),
  allowed_weekdays: z.string().trim().max(20).nullish(),
  rule_body: z.string().nullish(),
  // 作業指示内容だけ本文を持つ
  instruction_body: z.string().nullish(),
});
type SimpleBody = z.infer<typeof SimpleSchema>;
const SimplePatchSchema = SimpleSchema.partial().extend(Active);
type SimplePatchBody = z.infer<typeof SimplePatchSchema>;

// ---- 取引先 -----------------------------------------------------------------
const PartnerSchema = z.object({
  partner_code: z.string().trim().min(1).max(20),
  name1: z.string().trim().min(1).max(120),
  name2: z.string().trim().max(120).nullish(),
  short_name: z.string().trim().max(60).nullish(),
  is_customer: z.boolean().default(false),
  is_supplier: z.boolean().default(false),
  staff_user_id: z.number().int().positive().nullish(),
  /** 既定の販売担当（販売担当マスタ）。受注に引き継ぐ。 */
  sales_staff_id: z.number().int().positive().nullish(),
  media_id: z.number().int().positive().nullish(),
  partner_category_id: z.number().int().positive().nullish(),
  invoice_registration_no: z.string().trim().max(20).nullish(),
  invoice_note: z.string().nullish(),
  shipping_fee_threshold: decimal.nullish(),
  shipping_fee_amount: decimal.nullish(),
  default_trade_type: z.enum(['委託', '買取']).nullish(),
  closing_day: z.number().int().min(1).max(99).nullish(),
  payment_month_offset: z.number().int().min(0).max(12).nullish(),
  payment_day: z.number().int().min(1).max(99).nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PartnerBody = z.infer<typeof PartnerSchema>;

// ---- 納品先 -----------------------------------------------------------------
const DestinationSchema = z.object({
  partner_id: z.number().int().positive(),
  delivery_code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  partner_delivery_no: z.string().trim().max(40).nullish(),
  consignee: z.string().trim().max(120).nullish(),
  delivery_note_print1: z.string().nullish(),
  delivery_note_print2: z.string().nullish(),
  work_instruction_id: z.number().int().positive().nullish(),
  delivery_rule_id: z.number().int().positive().nullish(),
  default_warehouse_id: z.number().int().positive().nullish(),
  slip_issue_class_code_id: z.number().int().positive().nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type DestinationBody = z.infer<typeof DestinationSchema>;

// ---- 商品 -------------------------------------------------------------------
const ProductSchema = z.object({
  product_code: z.string().trim().min(1).max(40),
  product_name: z.string().trim().min(1).max(200),
  set_product_name: z.string().trim().max(200).nullish(),
  brand_id: z.number().int().positive().nullish(),
  category_id: z.number().int().positive().nullish(),
  product_class_id: z.number().int().positive().nullish(),
  carton_qty: z.number().int().min(0).nullish(),
  cost_price: decimal.default('0'),
  is_cost_undecided: z.boolean().default(false),
  tax_rate: tax.default('10.00'),
  is_set: z.boolean().default(false),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type ProductBody = z.infer<typeof ProductSchema>;

// ---- SKU --------------------------------------------------------------------
const SkuSchema = z.object({
  product_id: z.number().int().positive(),
  sku_code: z.string().trim().min(1).max(40),
  color_id: z.number().int().positive().nullish(),
  size_id: z.number().int().positive().nullish(),
  pack_division: z.string().trim().max(10).nullish(),
  jan: z
    .string()
    .trim()
    .regex(/^\d{8}$|^\d{13}$/, 'JANコードは8桁または13桁の数字で入力してください')
    .nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type SkuBody = z.infer<typeof SkuSchema>;

// ---- セット登録 -------------------------------------------------------------
const SetSchema = z.object({
  sku_id: z.number().int().positive(),
  components: z
    .array(
      z.object({
        component_sku_id: z.number().int().positive(),
        qty: z.string().regex(/^\d+(\.\d+)?$/, '構成数は0より大きい数値で入力してください'),
        sort_order: z.number().int().nullish(),
      }),
    )
    .min(1, '構成品を1件以上登録してください'),
  note: z.string().nullish(),
});
type SetBody = z.infer<typeof SetSchema>;

// ---- 得意先別商品 -----------------------------------------------------------
const PartnerProductSchema = z.object({
  partner_id: z.number().int().positive(),
  sku_id: z.number().int().positive(),
  partner_product_code: z.string().trim().max(60).nullish(),
  partner_jan: z.string().trim().max(20).nullish(),
  jan_code: z.string().trim().max(20).nullish(),
  sales_name: z.string().trim().max(200).nullish(),
  sales_name2: z.string().trim().max(200).nullish(),
  unit_price: decimal.default('0'),
  /** 上代。納品書「上代あり」に印字する（9/15 ご回答で得意先別商品マスタに置くと確定）。 */
  retail_price: decimal.nullish(),
  cost_price: decimal.nullish(),
  partner_color: z.string().trim().max(40).nullish(),
  partner_size: z.string().trim().max(40).nullish(),
  color_name: z.string().trim().max(40).nullish(),
  size_name: z.string().trim().max(40).nullish(),
  memo: z.string().nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PartnerProductBody = z.infer<typeof PartnerProductSchema>;

// ---- 倉庫 -------------------------------------------------------------------
const WarehouseSchema = z.object({
  warehouse_code: z.string().trim().min(1).max(20),
  short_name: z.string().trim().min(1).max(60),
  is_consignment: z.boolean().default(false),
  partner_id: z.number().int().positive().nullish(),
  media_id: z.number().int().positive().nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type WarehouseBody = z.infer<typeof WarehouseSchema>;

// ---- 仕入マスタ（仕入品目） -------------------------------------------------
const PurchaseItemSchema = z.object({
  purchase_code: z.string().trim().min(1).max(60),
  item_name: z.string().trim().min(1).max(200),
  unit_cost: decimal.default('0'),
  brand_id: z.number().int().positive().nullish(),
  category_id: z.number().int().positive().nullish(),
  product_class_id: z.number().int().positive().nullish(),
  new_tax_rate: tax.nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PurchaseItemBody = z.infer<typeof PurchaseItemSchema>;

// ---- 汎用区分 ---------------------------------------------------------------
const CodeSchema = z.object({
  code_category_code: code,
  code,
  name: z.string().trim().min(1).max(120),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type CodeBody = z.infer<typeof CodeSchema>;

// ---- ロイヤリティ規定 -------------------------------------------------------
const RoyaltyRuleSchema = z
  .object({
    payee_partner_id: z.number().int().positive(),
    brand_id: z.number().int().positive().nullish(),
    product_id: z.number().int().positive().nullish(),
    customer_partner_id: z.number().int().positive().nullish(),
    is_excluded: z.boolean().default(false),
    calc_base: z.enum(['売上', '出荷', '入金']).default('出荷'),
    rate: z.string().regex(/^\d(\.\d{1,4})?$/, '料率は 0.0500（5%）のような形で入力してください').nullish(),
    fixed_amount: decimal.nullish(),
    valid_from: ymd,
    valid_to: ymd.nullish(),
    sort_order: z.number().int().nullish(),
    note: z.string().nullish(),
  })
  .refine((v) => (v.is_excluded ? !v.rate && !v.fixed_amount : Boolean(v.rate || v.fixed_amount)), {
    message: '対象の規定は料率か定額のどちらかが必要です。対象外の規定には入力しないでください',
  });
type RoyaltyRuleBody = z.infer<typeof RoyaltyRuleSchema>;

/**
 * マスタの登録・更新。
 *
 * **マスタは物理削除しない。**伝票から参照されているため、使わなくなったものは
 * 「無効」にして一覧から外す。過去の伝票はそのまま読める。
 */
@Controller('masters')
export class MastersWriteController {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly crud: MastersCrudService,
    private readonly settings: SettingsService,
  ) {}

  // ---- 分類マスタ -----------------------------------------------------------
  /** ブランド・カラー・サイズなど、同じ形の10種をまとめて扱う。 */
  @Get('simple/:kind')
  @RequirePermission('M-16', 'view')
  listSimple(
    @Param('kind') kind: string,
    @Query(new ZodValidationPipe(ListSchema)) query: ListQuery,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.list(table, {
      ...query,
      searchColumns: ['code', 'name'],
      orderBy: ['sort_order', 'code'],
    });
  }

  @Post('simple/:kind')
  @RequirePermission('M-16', 'create')
  createSimple(
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(SimpleSchema)) body: SimpleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.create(table, this.simpleValues(table, body), user.id);
  }

  @Patch('simple/:kind/:id')
  @RequirePermission('M-16', 'update')
  updateSimple(
    @Param('kind') kind: string,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SimplePatchSchema)) body: SimplePatchBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.update(table, id, this.simpleValues(table, body), SIMPLE_MASTERS[table], user.id);
  }

  @Post('simple/:kind/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-16', 'delete')
  deactivateSimple(
    @Param('kind') kind: string,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.setActive(table, id, false, SIMPLE_MASTERS[table], user.id);
  }

  private simpleTable(kind: string): SimpleMaster {
    if (!(kind in SIMPLE_MASTERS)) {
      throw new NotFoundException(
        `マスタ「${kind}」はありません。次のいずれかを指定してください：${Object.keys(SIMPLE_MASTERS).join('、')}`,
      );
    }
    return kind as SimpleMaster;
  }

  /** 分類マスタごとに存在する列だけを残す。 */
  private simpleValues(table: SimpleMaster, body: Partial<SimpleBody> & { is_active?: boolean }): Record<string, unknown> {
    const base: Record<string, unknown> = {
      code: body.code,
      name: body.name,
      sort_order: body.sort_order,
      note: body.note,
      is_active: body.is_active,
    };
    if (table === 'delivery_rules') {
      base.lead_time_days = body.lead_time_days;
      base.allowed_weekdays = body.allowed_weekdays;
      base.rule_body = body.rule_body;
    }
    if (table === 'work_instructions') {
      base.instruction_body = body.instruction_body ?? body.note ?? '';
    }
    return base;
  }

  // ---- 取引先 ---------------------------------------------------------------
  @Post('partners')
  @RequirePermission('M-01', 'create')
  createPartner(
    @Body(new ZodValidationPipe(PartnerSchema)) body: PartnerBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('partners', body, user.id);
  }

  @Patch('partners/:id')
  @RequirePermission('M-01', 'update')
  updatePartner(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PartnerSchema.partial().extend(Active))) body: Partial<PartnerBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('partners', id, body, '取引先', user.id);
  }

  @Post('partners/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-01', 'delete')
  deactivatePartner(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('partners', id, false, '取引先', user.id);
  }

  // ---- 納品先 ---------------------------------------------------------------
  /** 納品先の一覧。取引先で絞れ、取引先名も一緒に返す。 */
  @Get('delivery-destinations')
  @RequirePermission('M-05', 'view')
  async listDestinations(@Query(new ZodValidationPipe(DestinationListSchema)) query: DestinationListQuery) {
    let base = this.db
      .selectFrom('delivery_destinations as d')
      .innerJoin('partners as p', 'p.id', 'd.partner_id');
    if (!query.include_inactive) base = base.where('d.is_active', '=', true);
    if (query.partner_id !== undefined) base = base.where('d.partner_id', '=', query.partner_id);
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('d.delivery_code', 'ilike', like),
          eb('d.name', 'ilike', like),
          eb('d.consignee', 'ilike', like),
          eb('p.name1', 'ilike', like),
        ]),
      );
    }
    const [items, total] = await Promise.all([
      base
        .selectAll('d')
        .select(['p.partner_code as partner_code', 'p.name1 as partner_name'])
        .orderBy('p.partner_code')
        .orderBy('d.sort_order', sql`asc nulls last`)
        .orderBy('d.delivery_code')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  @Post('delivery-destinations')
  @RequirePermission('M-05', 'create')
  createDestination(
    @Body(new ZodValidationPipe(DestinationSchema)) body: DestinationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('delivery_destinations', body, user.id);
  }

  @Patch('delivery-destinations/:id')
  @RequirePermission('M-05', 'update')
  updateDestination(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(DestinationSchema.partial().extend(Active))) body: Partial<DestinationBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('delivery_destinations', id, body, '納品先', user.id);
  }

  @Post('delivery-destinations/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-05', 'delete')
  deactivateDestination(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('delivery_destinations', id, false, '納品先', user.id);
  }

  // ---- 商品 -----------------------------------------------------------------
  @Post('products')
  @RequirePermission('M-08', 'create')
  createProduct(
    @Body(new ZodValidationPipe(ProductSchema)) body: ProductBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('products', body, user.id);
  }

  @Patch('products/:id')
  @RequirePermission('M-08', 'update')
  updateProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ProductSchema.partial().extend(Active))) body: Partial<ProductBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('products', id, body, '商品', user.id);
  }

  @Post('products/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-08', 'delete')
  deactivateProduct(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('products', id, false, '商品', user.id);
  }

  // ---- SKU ------------------------------------------------------------------
  @Post('skus')
  @RequirePermission('M-09', 'create')
  createSku(
    @Body(new ZodValidationPipe(SkuSchema)) body: SkuBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('skus', body, user.id);
  }

  @Patch('skus/:id')
  @RequirePermission('M-09', 'update')
  updateSku(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SkuSchema.partial().extend(Active))) body: Partial<SkuBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('skus', id, body, 'SKU', user.id);
  }

  // ---- セット登録 -----------------------------------------------------------
  /**
   * セット登録。セット自体は在庫を持たず、構成している商品から引き落とす。
   * 構成は入れ替えになるため、登録し直すと前の構成は消える。
   */
  @Post('sets')
  @RequirePermission('M-10', 'create')
  async createSet(
    @Body(new ZodValidationPipe(SetSchema)) body: SetBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const header = await trx
        .insertInto('set_headers')
        .values({ sku_id: body.sku_id, note: body.note ?? null, created_by: user.id, updated_by: user.id })
        .onConflict((oc) => oc.column('sku_id').doUpdateSet({ note: body.note ?? null, updated_by: user.id }))
        .returning(['id', 'sku_id'])
        .executeTakeFirstOrThrow();

      await trx.deleteFrom('set_components').where('set_header_id', '=', header.id).execute();
      await trx
        .insertInto('set_components')
        .values(
          body.components.map((c, i) => ({
            set_header_id: header.id,
            component_sku_id: c.component_sku_id,
            qty: c.qty,
            sort_order: c.sort_order ?? i + 1,
            created_by: user.id,
          })),
        )
        .execute();

      return { ...header, components: body.components.length };
    });
  }

  @Get('sets')
  @RequirePermission('M-10', 'view')
  async listSets(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    const items = await this.db
      .selectFrom('set_headers as h')
      .innerJoin('skus as s', 's.id', 'h.sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .select([
        'h.id as id',
        's.sku_code as sku_code',
        'p.product_name as product_name',
        'h.is_active as is_active',
        (eb) =>
          eb
            .selectFrom('set_components as c')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('c.set_header_id', '=', 'h.id')
            .as('component_count'),
      ])
      .orderBy('s.sku_code', 'asc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();
    return { items, total: items.length, limit: query.limit, offset: query.offset };
  }

  @Get('sets/:id')
  @RequirePermission('M-10', 'view')
  async findSet(@Param('id', ParseIntPipe) id: number) {
    const header = await this.crud.findOne('set_headers', id, 'セット登録');
    const components = await this.db
      .selectFrom('set_components as c')
      .innerJoin('skus as s', 's.id', 'c.component_sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .select([
        'c.id as id',
        'c.component_sku_id as component_sku_id',
        's.sku_code as sku_code',
        'p.product_name as product_name',
        'c.qty as qty',
      ])
      .where('c.set_header_id', '=', id)
      .orderBy('c.sort_order', sql`asc nulls last`)
      .execute();
    return { ...header, components };
  }

  // ---- 得意先別商品 ---------------------------------------------------------
  /** 得意先別商品の一覧。取引先・SKU で絞れ、名称も一緒に返す（画面で ID だけ見せない）。 */
  @Get('partner-products')
  @RequirePermission('M-11', 'view')
  async listPartnerProducts(@Query(new ZodValidationPipe(PartnerProductListSchema)) query: PartnerProductListQuery) {
    let base = this.db
      .selectFrom('partner_products as pp')
      .innerJoin('partners as p', 'p.id', 'pp.partner_id')
      .innerJoin('skus as s', 's.id', 'pp.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id');
    if (!query.include_inactive) base = base.where('pp.is_active', '=', true);
    if (query.partner_id !== undefined) base = base.where('pp.partner_id', '=', query.partner_id);
    if (query.sku_id !== undefined) base = base.where('pp.sku_id', '=', query.sku_id);
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('pp.partner_product_code', 'ilike', like),
          eb('pp.sales_name', 'ilike', like),
          eb('pp.partner_jan', 'ilike', like),
          eb('s.sku_code', 'ilike', like),
          eb('p.name1', 'ilike', like),
        ]),
      );
    }
    const [items, total] = await Promise.all([
      base
        .selectAll('pp')
        .select(['p.partner_code as partner_code', 'p.name1 as partner_name', 's.sku_code as sku_code', 'pr.product_name as product_name'])
        .orderBy('p.partner_code')
        .orderBy('s.sku_code')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 受注入力で使う。取引先×SKU の得意先別商品（専用コード・卸単価・上代）を1件返す。
   * 無ければ null。受注入力の権限だけで呼べるようにしてある。
   */
  @Get('partner-products/lookup')
  @RequirePermission('O-01', 'view')
  async lookupPartnerProduct(@Query(new ZodValidationPipe(PartnerProductLookupSchema)) query: PartnerProductLookupQuery) {
    const row = await this.db
      .selectFrom('partner_products')
      .select(['id', 'partner_product_code', 'sales_name', 'unit_price', 'retail_price'])
      .where('partner_id', '=', query.partner_id)
      .where('sku_id', '=', query.sku_id)
      .where('is_active', '=', true)
      .orderBy('id')
      .executeTakeFirst();
    return row ?? null;
  }

  @Post('partner-products')
  @RequirePermission('M-11', 'create')
  createPartnerProduct(
    @Body(new ZodValidationPipe(PartnerProductSchema)) body: PartnerProductBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('partner_products', body, user.id);
  }

  @Patch('partner-products/:id')
  @RequirePermission('M-11', 'update')
  updatePartnerProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PartnerProductSchema.partial().extend(Active))) body: Partial<PartnerProductBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('partner_products', id, body, '得意先別商品', user.id);
  }

  // ---- 倉庫 -----------------------------------------------------------------
  @Post('warehouses')
  @RequirePermission('M-14', 'create')
  createWarehouse(
    @Body(new ZodValidationPipe(WarehouseSchema)) body: WarehouseBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('warehouses', body, user.id);
  }

  @Patch('warehouses/:id')
  @RequirePermission('M-14', 'update')
  updateWarehouse(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(WarehouseSchema.partial().extend(Active))) body: Partial<WarehouseBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('warehouses', id, body, '倉庫', user.id);
  }

  // ---- 仕入マスタ -----------------------------------------------------------
  @Get('purchase-items')
  @RequirePermission('M-15', 'view')
  listPurchaseItems(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.crud.list('purchase_items', {
      ...query,
      searchColumns: ['purchase_code', 'item_name'],
      orderBy: ['sort_order', 'purchase_code'],
    });
  }

  @Post('purchase-items')
  @RequirePermission('M-15', 'create')
  createPurchaseItem(
    @Body(new ZodValidationPipe(PurchaseItemSchema)) body: PurchaseItemBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('purchase_items', body, user.id);
  }

  @Patch('purchase-items/:id')
  @RequirePermission('M-15', 'update')
  updatePurchaseItem(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PurchaseItemSchema.partial().extend(Active))) body: Partial<PurchaseItemBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('purchase_items', id, body, '仕入品目', user.id);
  }

  // ---- 汎用区分 -------------------------------------------------------------
  /** 区分値の追加。カテゴリーはコードで指定する（例 ADJUSTMENT_REASON）。 */
  @Post('codes')
  @RequirePermission('M-16', 'create')
  async createCode(
    @Body(new ZodValidationPipe(CodeSchema)) body: CodeBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const category = await this.db
      .selectFrom('code_categories')
      .select('id')
      .where('code', '=', body.code_category_code)
      .executeTakeFirst();

    if (!category) {
      throw new BadRequestException(`区分カテゴリー「${body.code_category_code}」が登録されていません`);
    }

    return this.crud.create(
      'codes',
      {
        code_category_id: category.id,
        code: body.code,
        name: body.name,
        sort_order: body.sort_order,
        note: body.note,
      },
      user.id,
    );
  }

  @Patch('codes/:id')
  @RequirePermission('M-16', 'update')
  updateCode(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CodeSchema.partial().omit({ code_category_code: true })))
    body: Partial<Omit<CodeBody, 'code_category_code'>>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('codes', id, body, '区分値', user.id);
  }

  /** システム設定の変更。端数処理や送料の条件をプログラムなしで切り替える。 */
  @Patch('settings/:key')
  @RequirePermission('M-16', 'update')
  async updateSetting(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(z.object({ value_text: z.string().nullable() })))
    body: { value_text: string | null },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const setting = await this.db
      .selectFrom('system_settings')
      .select(['setting_key', 'is_user_editable'])
      .where('setting_key', '=', key)
      .executeTakeFirst();

    if (!setting) throw new NotFoundException(`設定「${key}」はありません`);
    if (!setting.is_user_editable) throw new ForbiddenException(`設定「${key}」は画面から変更できません`);

    const row = await this.db
      .updateTable('system_settings')
      .set({ value_text: body.value_text, updated_by: user.id, updated_at: new Date() })
      .where('setting_key', '=', key)
      .returning(['setting_key', 'name', 'value_text', 'value_type'])
      .executeTakeFirstOrThrow();
    // 設定は短時間覚えているので、変えたその場で捨てて即座に効かせる。
    this.settings.invalidate();
    return row;
  }

  // ---- ロイヤリティ規定 -----------------------------------------------------
  /**
   * ロイヤリティ規定。支払先 × ブランド（または商品） × 販売先 × 期間で決める。
   * ブランド・商品・販売先を空欄にすると「すべて」になる。
   * 料率を変えるときは、既存の行を書き換えず新しい適用開始日で行を足す。
   */
  @Get('royalty-rules')
  @RequirePermission('Y-02', 'view')
  async listRoyaltyRules(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    const items = await this.db
      .selectFrom('royalty_rules as r')
      .innerJoin('partners as payee', 'payee.id', 'r.payee_partner_id')
      .leftJoin('brands as b', 'b.id', 'r.brand_id')
      .leftJoin('products as p', 'p.id', 'r.product_id')
      .leftJoin('partners as cust', 'cust.id', 'r.customer_partner_id')
      .select([
        'r.id as id',
        'r.payee_partner_id as payee_partner_id',
        'payee.name1 as payee_name',
        'r.brand_id as brand_id',
        'b.name as brand_name',
        'r.product_id as product_id',
        'p.product_name as product_name',
        'r.customer_partner_id as customer_partner_id',
        'cust.name1 as customer_name',
        'r.note as note',
        'r.is_excluded as is_excluded',
        'r.calc_base as calc_base',
        'r.rate as rate',
        'r.fixed_amount as fixed_amount',
        'r.valid_from as valid_from',
        'r.valid_to as valid_to',
        'r.scope_priority as scope_priority',
        'r.is_active as is_active',
      ])
      .orderBy('payee.name1', 'asc')
      .orderBy('r.scope_priority', 'desc')
      .orderBy('r.valid_from', 'desc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();
    return { items, total: items.length, limit: query.limit, offset: query.offset };
  }

  @Post('royalty-rules')
  @RequirePermission('Y-02', 'create')
  createRoyaltyRule(
    @Body(new ZodValidationPipe(RoyaltyRuleSchema)) body: RoyaltyRuleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('royalty_rules', body, user.id);
  }

  @Patch('royalty-rules/:id')
  @RequirePermission('Y-02', 'update')
  updateRoyaltyRule(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(RoyaltyRuleSchema.innerType().partial().extend(Active)))
    body: Partial<RoyaltyRuleBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('royalty_rules', id, body, 'ロイヤリティ規定', user.id);
  }

  @Post('royalty-rules/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('Y-02', 'delete')
  deactivateRoyaltyRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('royalty_rules', id, false, 'ロイヤリティ規定', user.id);
  }
}

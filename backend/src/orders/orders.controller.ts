import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { SettingsService } from '../common/settings.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AllocationService } from '../shipping/allocation.service';
import { OVERSEAS_TAX_RATE } from './order-defaults';
import { OrdersService } from './orders.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');

const LineSchema = z.object({
  line_no: z.number().int().min(1),
  parent_line_no: z.number().int().min(1).nullish(),
  line_type: z.enum(['商品', 'セット商品', '内訳商品', '販促品', '送料', '値引', '非商品']),
  sku_id: z.number().int().positive().nullish(),
  partner_product_id: z.number().int().positive().nullish(),
  // 空は受けて、サービスで「n行目：…」と行を添えて断る（非商品の行は品名が必須。2026-10-13 受注処理編 O-11）
  item_name: z.string().trim().max(200, '品名は200文字以内で入力してください').default(''),
  qty: decimal,
  unit_price: decimal.default('0'),
  tax_rate: z.enum(['0.00', '8.00', '10.00']).optional(),
  // 出荷依頼書適用・納品書適用（明細ごと。2026-10-13 受注処理編 O-09）
  shipping_note: z.string().trim().max(200, '出荷依頼書適用は200文字以内で入力してください').nullish(),
  delivery_slip_note: z.string().trim().max(200, '納品書適用は200文字以内で入力してください').nullish(),
});

/** 受注区分（2026-10-13 受注処理編 O-02・O-44 で社内移動・返品を追加。通販は通販CSVの取込で作る） */
const ORDER_TYPES = ['卸', '直送', '通販', '社内移動', 'サンプル', '返品'] as const;

const CreateOrderSchema = z.object({
  order_type: z.enum(ORDER_TYPES),
  // 取引先・販売カテゴリーはサンプル・社内移動だけ空にできる（必須かどうかはサービスで区分ごとに見る。O-14）
  partner_id: z.number().int().positive().nullish(),
  delivery_destination_id: z.number().int().positive().nullish(),
  sales_category_id: z.number().int().positive().nullish(),
  trade_type: z.enum(['委託', '買取']).optional(),
  /** 委託の入庫倉庫（取引条件が委託のときは必須。O-12） */
  consignment_warehouse_id: z.number().int().positive().nullish(),
  /** 納品時間（区分値 DELIVERY_TIME。O-03） */
  delivery_time_code_id: z.number().int().positive().nullish(),
  /** 納品書に送料を記載する（O-10） */
  print_shipping_fee: z.boolean().optional(),
  /** 販売担当。省略時は取引先マスタの担当者。 */
  sales_staff_id: z.number().int().positive().nullish(),
  po_no: z.string().trim().max(40).nullish(),
  po_line_no: z.number().int().nullish(),
  order_date: ymd,
  ship_date: ymd.nullish(),
  delivery_date: ymd.nullish(),
  requested_delivery_date: ymd.nullish(),
  ship_from_warehouse_id: z.number().int().positive().nullish(),
  direct_name: z.string().trim().max(120).nullish(),
  direct_kana: z.string().trim().max(120).nullish(),
  direct_postal_code: z.string().trim().max(8).nullish(),
  direct_address1: z.string().trim().max(200).nullish(),
  direct_address2: z.string().trim().max(200).nullish(),
  direct_tel: z.string().trim().max(20).nullish(),
  shipping_remarks: z.string().nullish(),
  delivery_note_remarks: z.string().nullish(),
  shipping_fee_adjustment: decimal.nullish(),
  channel: z.string().trim().max(30).nullish(),
  lines: z.array(LineSchema).min(1, '明細を1行以上入力してください'),
});
type CreateOrderBody = z.infer<typeof CreateOrderSchema>;

const ListQuerySchema = z.object({
  status: z.enum(['未確定', '引当待ち', '引当済', '出荷指示済', '出荷済', '取消']).optional(),
  order_type: z.enum(ORDER_TYPES).optional(),
  partner_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  include_cancelled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

const SkuPickerQuerySchema = z.object({
  /** 取引先。渡すとその取引先の得意先別商品（使っている行）だけを、行ごとに返す */
  partner_id: z.coerce.number().int().positive().optional(),
});
type SkuPickerQuery = z.infer<typeof SkuPickerQuerySchema>;

/** 機能ID O-01 受注登録／O-03 受注一覧／D-01 出荷指示 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly allocation: AllocationService,
    private readonly settings: SettingsService,
  ) {}

  @Post()
  @RequirePermission('O-01', 'create')
  create(
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrderBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.create(body, user.id);
  }

  @Get()
  @RequirePermission('O-03', 'view')
  list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery) {
    return this.orders.list(query);
  }

  /**
   * 海外の得意先の消費税の表記の既定（システム設定 OVERSEAS_TAX_TREATMENT）。
   * 受注入力で海外の得意先を選んだとき、合計の横に請求書と同じ言い方で出すために使う。
   * 取引先に消費税免税区分があれば、画面はそちら（取引先の検索結果の overseas_tax_label）を出す（2026-10-16 M3-07）。
   */
  @Get('overseas-tax')
  @RequirePermission('O-01', 'view')
  async overseasTax() {
    return { tax_rate: OVERSEAS_TAX_RATE, label: await this.settings.overseasTaxLabel() };
  }

  /**
   * 受注入力の「絞り込んで選ぶ」の候補（2026-10-13 受注処理編 O-04・O-05）。
   * ブランド → 商品分類 → カラー → サイズ → JAN の順に画面で絞るため、絞り込みの材料をまとめて返す。
   * :id より前に置く（後ろだと sku-picker が受注の ID として読まれる）。
   */
  @Get('sku-picker')
  @RequirePermission('O-01', 'view')
  skuPicker(@Query(new ZodValidationPipe(SkuPickerQuerySchema)) query: SkuPickerQuery) {
    return this.orders.skuPicker(query.partner_id ?? null);
  }

  @Get(':id')
  @RequirePermission('O-03', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  /** 受注の修正。出荷指示を出す前だけ直せる（ご要望⑨⑩）。 */
  @Patch(':id')
  @RequirePermission('O-01', 'update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CreateOrderSchema.partial())) body: Partial<CreateOrderBody>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.update(id, body, user.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('O-01', 'delete')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.cancel(id, user.id);
  }

  /**
   * 引当（受注一覧・受注詳細の「引当」。2026-10-13 受注処理編 O-06・O-19 で受注は登録だけになり、ここで引き当てる）。
   * 押さえている分をいったん戻し、全量を引き当て直す。取れた分だけ押さえ、全部取れたら引当済。
   */
  @Post(':id/allocate')
  @HttpCode(200)
  @RequirePermission('D-01', 'create')
  allocate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.allocation.reallocate(id, user.id);
  }

  /**
   * 出荷指示（設定 ALLOCATION_TIMING=shipping_instruction のとき、ここで初めて在庫を押さえる）。
   * 登録だけ（manual。既定）・受注登録時に引き当てる設定（order_entry）では、引当（allocate）と同じ動きになる。
   */
  @Post(':id/shipping-instruction')
  @HttpCode(200)
  @RequirePermission('D-01', 'create')
  instruct(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.allocation.instruct(id, user.id);
  }

  /** 出荷指示の取消（引当解除）。有効在庫は戻るが実在庫は動かない。 */
  @Delete(':id/shipping-instruction')
  @RequirePermission('D-01', 'delete')
  release(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.allocation.release(id, user.id);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AllocationService } from '../shipping/allocation.service';
import { OrdersService } from './orders.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');

const LineSchema = z.object({
  line_no: z.number().int().min(1),
  parent_line_no: z.number().int().min(1).nullish(),
  line_type: z.enum(['商品', 'セット商品', '内訳商品', '販促品', '送料', '値引', '非商品']),
  sku_id: z.number().int().positive().nullish(),
  partner_product_id: z.number().int().positive().nullish(),
  item_name: z.string().trim().min(1, '品名を入力してください').max(200),
  qty: decimal,
  unit_price: decimal.default('0'),
  tax_rate: z.enum(['0.00', '8.00', '10.00']).optional(),
});

const CreateOrderSchema = z.object({
  order_type: z.enum(['卸', '直送', '通販', 'サンプル']),
  partner_id: z.number().int().positive(),
  delivery_destination_id: z.number().int().positive().nullish(),
  sales_category_id: z.number().int().positive(),
  trade_type: z.enum(['委託', '買取']).optional(),
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
  status: z.enum(['未確定', '引当済', '出荷指示済', '出荷済', '取消']).optional(),
  order_type: z.enum(['卸', '直送', '通販', 'サンプル']).optional(),
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

/** 機能ID O-01 受注登録／O-03 受注一覧／D-01 出荷指示 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly allocation: AllocationService,
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

  @Get(':id')
  @RequirePermission('O-03', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('O-01', 'delete')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.cancel(id, user.id);
  }

  /** 出荷指示。ここで初めて在庫を押さえる。 */
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

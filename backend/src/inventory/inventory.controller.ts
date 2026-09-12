import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { AdjustmentsService } from './adjustments.service';
import { ReceiptsService } from './receipts.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');
const positive = z.string().regex(/^\d+(\.\d+)?$/, '0 以上の数値で入力してください');
const quality = z.enum(['GOOD', 'DEFECTIVE', 'PENDING']);

const CreateReceiptSchema = z.object({
  warehouse_id: z.number().int().positive(),
  supplier_partner_id: z.number().int().positive().nullish(),
  planned_date: ymd.nullish(),
  note: z.string().nullish(),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().min(1),
        sku_id: z.number().int().positive(),
        qty: positive,
        lot_no: z.string().trim().max(40).nullish(),
        expiry_date: ymd.nullish(),
        cost_price: decimal.nullish(),
      }),
    )
    .min(1, '入荷明細を1行以上入力してください'),
});
type CreateReceiptBody = z.infer<typeof CreateReceiptSchema>;

const ReceiveSchema = z.object({ received_date: ymd.nullish() }).default({});
type ReceiveBody = z.infer<typeof ReceiveSchema>;

const ReceiptListSchema = z.object({
  status: z.enum(['指示', '入荷済', '取消']).optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ReceiptListQuery = z.infer<typeof ReceiptListSchema>;

const CreateAdjustmentSchema = z.object({
  warehouse_id: z.number().int().positive(),
  adjustment_date: ymd,
  reason_code: z.string().trim().min(1),
  note: z.string().nullish(),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().min(1),
        sku_id: z.number().int().positive(),
        qty: decimal,
        lot_no: z.string().trim().max(40).nullish(),
        from_quality: quality.nullish(),
        to_quality: quality.nullish(),
        note: z.string().nullish(),
      }),
    )
    .min(1, '調整明細を1行以上入力してください'),
});
type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentSchema>;

const AdjustmentListSchema = z.object({
  warehouse_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type AdjustmentListQuery = z.infer<typeof AdjustmentListSchema>;

const CreateReservationSchema = z.object({
  partner_id: z.number().int().positive(),
  sales_category_id: z.number().int().positive(),
  sku_id: z.number().int().positive(),
  period_from: ymd,
  period_to: ymd,
  reserved_qty: positive,
  note: z.string().nullish(),
});
type CreateReservationBody = z.infer<typeof CreateReservationSchema>;

const ReservationListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
  on: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ReservationListQuery = z.infer<typeof ReservationListSchema>;

/** 機能ID S-03 入荷登録／S-01 在庫調整／S-08 取引先別確保数 */
@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly receipts: ReceiptsService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  // ---- 入荷 ---------------------------------------------------------------
  @Post('receipts')
  @RequirePermission('S-03', 'create')
  createReceipt(
    @Body(new ZodValidationPipe(CreateReceiptSchema)) body: CreateReceiptBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.receipts.create(body, user.id);
  }

  @Get('receipts')
  @RequirePermission('S-03', 'view')
  listReceipts(@Query(new ZodValidationPipe(ReceiptListSchema)) query: ReceiptListQuery) {
    return this.receipts.list(query);
  }

  @Get('receipts/:id')
  @RequirePermission('S-03', 'view')
  findReceipt(@Param('id', ParseIntPipe) id: number) {
    return this.receipts.findOne(id);
  }

  /** 入荷確定。ここで実在庫が増える。在庫表に無い商品はこの時点で現れる。 */
  @Post('receipts/:id/receive')
  @HttpCode(200)
  @RequirePermission('S-03', 'update')
  receive(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ReceiveSchema)) body: ReceiveBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.receipts.receive(id, body.received_date ?? null, user.id);
  }

  // ---- 在庫調整 -----------------------------------------------------------
  @Post('adjustments')
  @RequirePermission('S-01', 'update')
  createAdjustment(
    @Body(new ZodValidationPipe(CreateAdjustmentSchema)) body: CreateAdjustmentBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.adjustments.create(body, user.id);
  }

  @Get('adjustments')
  @RequirePermission('S-01', 'view')
  listAdjustments(@Query(new ZodValidationPipe(AdjustmentListSchema)) query: AdjustmentListQuery) {
    return this.adjustments.list(query);
  }

  // ---- 取引先別確保数 -----------------------------------------------------
  /**
   * 確保数は期間で持つ。放送日ごとでも月ごとでも同じ形で登録できる。
   * 同じ取引先・販売カテゴリー・商品・開始日の組み合わせは1件だけ（データベース側の一意制約）。
   */
  @Post('reservations')
  @RequirePermission('S-08', 'create')
  async createReservation(
    @Body(new ZodValidationPipe(CreateReservationSchema)) body: CreateReservationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.db
      .insertInto('reservations')
      .values({
        partner_id: body.partner_id,
        sales_category_id: body.sales_category_id,
        sku_id: body.sku_id,
        period_from: body.period_from,
        period_to: body.period_to,
        reserved_qty: body.reserved_qty,
        note: body.note ?? null,
        created_by: user.id,
        updated_by: user.id,
      })
      .returning(['id', 'reserved_qty', 'consumed_qty'])
      .executeTakeFirstOrThrow();
  }

  @Get('reservations')
  @RequirePermission('S-08', 'view')
  async listReservations(@Query(new ZodValidationPipe(ReservationListSchema)) query: ReservationListQuery) {
    let base = this.db
      .selectFrom('reservations as r')
      .innerJoin('partners as p', 'p.id', 'r.partner_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'r.sales_category_id')
      .innerJoin('skus as s', 's.id', 'r.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id');

    if (query.partner_id !== undefined) base = base.where('r.partner_id', '=', query.partner_id);
    if (query.sku_id !== undefined) base = base.where('r.sku_id', '=', query.sku_id);
    if (query.on) {
      base = base.where('r.period_from', '<=', query.on).where('r.period_to', '>=', query.on);
    }

    const [items, total] = await Promise.all([
      base
        .select([
          'r.id as id',
          'p.name1 as partner_name',
          'sc.name as sales_category_name',
          's.sku_code as sku_code',
          'pr.product_name as product_name',
          'r.period_from as period_from',
          'r.period_to as period_to',
          'r.reserved_qty as reserved_qty',
          'r.consumed_qty as consumed_qty',
          sql<string>`r.reserved_qty - r.consumed_qty`.as('remaining_qty'),
        ])
        .orderBy('r.period_from', 'desc')
        .orderBy('s.sku_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }
}

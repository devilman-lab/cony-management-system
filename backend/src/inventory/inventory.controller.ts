import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { AdjustmentsService } from './adjustments.service';
import { ReceiptsService } from './receipts.service';
import { ReservationsService } from './reservations.service';

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
        // 符号はここで見ない。0 でも負数でも
        // 「1行目：数量は 0 より大きい数で入力してください」に揃えたいので、
        // 判定は受注と同じくサービス側（receipts.service.ts）にまとめている。
        qty: decimal,
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
  /** 既定では取り消した入荷を出さない。受注一覧と同じ指定の仕方にそろえる。 */
  include_cancelled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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

const ym = z.string().regex(/^\d{4}-\d{2}$/, '年月は YYYY-MM の形式で入力してください');

const CreateReservationSchema = z.object({
  /** 任意。空なら販売カテゴリー全体の枠（9/17 ご確認②） */
  partner_id: z.number().int().positive().nullish(),
  sales_category_id: z.number().int().positive(),
  sku_id: z.number().int().positive(),
  period_from: ymd,
  period_to: ymd,
  reserved_qty: positive,
  note: z.string().nullish(),
});
type CreateReservationBody = z.infer<typeof CreateReservationSchema>;

const UpdateReservationSchema = z.object({
  reserved_qty: positive.optional(),
  period_to: ymd.optional(),
  note: z.string().nullish(),
});
type UpdateReservationBody = z.infer<typeof UpdateReservationSchema>;

const CopyReservationSchema = z.object({ from_month: ym, to_month: ym });
type CopyReservationBody = z.infer<typeof CopyReservationSchema>;

const ReservationListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
  /** この日を含む枠だけ。単日で見たいとき。 */
  on: ymd.optional(),
  /** from〜to に少しでも重なる枠。月の一覧はこちらを使う（月の途中から始まる枠を取りこぼさないため）。 */
  from: ymd.optional(),
  to: ymd.optional(),
  sales_category_id: z.coerce.number().int().positive().optional(),
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
    private readonly reservations: ReservationsService,
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

  /** 入荷の取消。誤登録を消す手段。入荷確定して在庫が増えたあとは取り消せない。 */
  @Post('receipts/:id/cancel')
  @HttpCode(200)
  @RequirePermission('S-03', 'delete')
  cancelReceipt(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.receipts.cancel(id, user.id);
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
        partner_id: body.partner_id ?? null,
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
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'r.sales_category_id')
      .innerJoin('skus as s', 's.id', 'r.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id');

    if (query.partner_id !== undefined) base = base.where('r.partner_id', '=', query.partner_id);
    if (query.sku_id !== undefined) base = base.where('r.sku_id', '=', query.sku_id);
    if (query.sales_category_id !== undefined) base = base.where('r.sales_category_id', '=', query.sales_category_id);
    // 期間の重なりで絞る。単日（on）は from=to=on と同じ扱い。
    // 「月の15日を含む枠」だけを出す作りだと、月の途中から始まる枠が一覧に一度も出ず、
    // 画面から直せないのに受注の枠判定にだけ効く、という状態になる。
    const from = query.from ?? query.on;
    const to = query.to ?? query.on;
    if (from) base = base.where('r.period_to', '>=', from);
    if (to) base = base.where('r.period_from', '<=', to);

    const [items, total] = await Promise.all([
      base
        .select([
          'r.id as id',
          'r.partner_id as partner_id',
          'p.name1 as partner_name',
          'r.sales_category_id as sales_category_id',
          'r.sku_id as sku_id',
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

  /** 枠の数量・期間の変更。すでに使われた数より減らすことはできない。 */
  @Patch('reservations/:id')
  @RequirePermission('S-08', 'update')
  updateReservation(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateReservationSchema)) body: UpdateReservationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.update(id, body, user.id);
  }

  @Delete('reservations/:id')
  @RequirePermission('S-08', 'delete')
  removeReservation(@Param('id', ParseIntPipe) id: number) {
    return this.reservations.remove(id);
  }

  /** 前月の枠を翌月分として複写する。毎月の登録を数量の見直しだけで済ませるため。 */
  @Post('reservations/copy')
  @HttpCode(200)
  @RequirePermission('S-08', 'create')
  copyReservations(
    @Body(new ZodValidationPipe(CopyReservationSchema)) body: CopyReservationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.copyMonth(body, user.id);
  }
}

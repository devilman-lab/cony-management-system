import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdjustmentsService } from './adjustments.service';
import { CreateAdjustmentSchema, CreateReceiptSchema } from './inventory.controller';
import { ReceiptsService } from './receipts.service';

/** 入荷の編集。項目はすべて任意。明細を送ったときは明細をまるごと入れ替える。 */
const UpdateReceiptSchema = CreateReceiptSchema.partial();
type UpdateReceiptBody = z.infer<typeof UpdateReceiptSchema>;

/**
 * 在庫調整の編集。一覧で調整日・理由・備考だけを直すとき（Z-23）も、
 * 編集画面で明細ごと直すとき（Z-21）も、この1本で受ける。
 */
const UpdateAdjustmentSchema = CreateAdjustmentSchema.partial();
type UpdateAdjustmentBody = z.infer<typeof UpdateAdjustmentSchema>;

const ImportSchema = z.object({
  /** CSV の中身。画面から base64 で送る（マスタの CSV 取込と同じ） */
  content_base64: z.string().min(1, 'ファイルを選んでください'),
  /** true なら何も書かずに「こう登録されます」だけを返す */
  dry_run: z.boolean().default(true),
});
type ImportBody = z.infer<typeof ImportSchema>;

/**
 * 2026-10-09 在庫編で足した、入荷・在庫調整の操作（機能ID S-03 入荷登録／S-01 在庫調整）。
 *
 * 入荷・調整の登録と一覧は inventory.controller.ts にある。こちらは編集・「調整」・取消・CSV 取込。
 * 道は同じ `inventory` の下に置き、画面からは1つの API に見えるようにしている。
 * 注意: GET `inventory/receipts/:id` が先に登録されているので、入荷の下に文字の道は作らない
 * （`receipts/xxx` は :id に吸われて数値でないと 400 になる）。
 */
@Controller('inventory')
export class StockOperationsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  // ---- 入荷 ---------------------------------------------------------------
  /** 入荷倉庫として決め打ちにする「コニー倉庫」（Z-07）。画面はこの倉庫で登録する。 */
  @Get('receipt-warehouse')
  @RequirePermission('S-03', 'view')
  receiptWarehouse() {
    return this.receipts.receiptWarehouse();
  }

  /** 入荷の編集（Z-15）。入荷確定前（入荷予定）のものだけ。 */
  @Patch('receipts/:id')
  @RequirePermission('S-03', 'update')
  updateReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateReceiptSchema)) body: UpdateReceiptBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.receipts.update(id, body, user.id);
  }

  // ---- 在庫調整 -----------------------------------------------------------
  /** CSV で在庫調整を「登録」する（Z-24）。既定は下見。在庫は動かさない。 */
  @Post('adjustments/import')
  @HttpCode(200)
  @RequirePermission('S-01', 'update')
  importAdjustments(
    @Body(new ZodValidationPipe(ImportSchema)) body: ImportBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.adjustments.importCsv(body.content_base64, body.dry_run, user.id);
  }

  @Get('adjustments/:id')
  @RequirePermission('S-01', 'view')
  findAdjustment(@Param('id', ParseIntPipe) id: number) {
    return this.adjustments.findOne(id);
  }

  /** 編集（Z-21・Z-23）。在庫に反映する前（「登録」）のものだけ。 */
  @Patch('adjustments/:id')
  @RequirePermission('S-01', 'update')
  updateAdjustment(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateAdjustmentSchema)) body: UpdateAdjustmentBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.adjustments.update(id, body, user.id);
  }

  /** 「調整」。ここで在庫を動かし、状態を「確定」にする（Z-21）。 */
  @Post('adjustments/:id/confirm')
  @HttpCode(200)
  @RequirePermission('S-01', 'update')
  confirmAdjustment(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.adjustments.confirm(id, user.id);
  }

  /** 取消。確定済みなら在庫を元に戻してから取り消す（Z-21）。 */
  @Post('adjustments/:id/cancel')
  @HttpCode(200)
  @RequirePermission('S-01', 'update')
  cancelAdjustment(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.adjustments.cancel(id, user.id);
  }
}

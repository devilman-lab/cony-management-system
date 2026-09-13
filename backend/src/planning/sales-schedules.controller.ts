import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SalesSchedulesService } from './sales-schedules.service';

/** 月は YYYY-MM でも YYYY-MM-DD でも受ける（画面は月だけを入れる想定）。 */
const month = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, '年月は YYYY-MM の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');

const ListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, '年月は YYYY-MM の形式で入力してください').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;

const WriteSchema = z.object({
  partner_id: z.number().int().positive().nullish(),
  sales_category_id: z.number().int().positive().nullish(),
  sku_id: z.number().int().positive().nullish(),
  planned_sales_month: month.nullish(),
  planned_arrival_month: month.nullish(),
  planned_qty: decimal.nullish(),
  note: z.string().nullish(),
});
type WriteBody = z.infer<typeof WriteSchema>;

/**
 * 販売予定（販売スケジュール）。
 * 取引先別の確保数（S-08）と同じ画面群で使うため、権限もそこに合わせている。
 */
@Controller('sales-schedules')
export class SalesSchedulesController {
  constructor(private readonly schedules: SalesSchedulesService) {}

  @Get()
  @RequirePermission('S-08', 'view')
  list(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.schedules.list(query);
  }

  @Post()
  @RequirePermission('S-08', 'create')
  create(
    @Body(new ZodValidationPipe(WriteSchema)) body: WriteBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.schedules.create(body, user.id);
  }

  @Patch(':id')
  @RequirePermission('S-08', 'update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(WriteSchema)) body: WriteBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.schedules.update(id, body, user.id);
  }

  @Delete(':id')
  @RequirePermission('S-08', 'delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.schedules.remove(id);
  }
}

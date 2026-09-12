import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ShipmentsService } from './shipments.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');

const ListQuerySchema = z.object({
  status: z.enum(['未確定', '確定済', '印刷済', '出荷済']).optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

const ConfirmSchema = z.object({ ship_date: ymd.nullish() }).default({});
type ConfirmBody = z.infer<typeof ConfirmSchema>;

/** 機能ID D-01 出荷指示（出荷依頼一覧・出荷確定） */
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @RequirePermission('D-01', 'view')
  list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery) {
    return this.shipments.list(query);
  }

  @Get(':id')
  @RequirePermission('D-01', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.shipments.findOne(id);
  }

  /** 出荷確定。ここで初めて実在庫が減る。 */
  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('D-01', 'update')
  confirm(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ConfirmSchema)) body: ConfirmBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shipments.confirm(id, body.ship_date ?? null, user.id);
  }
}

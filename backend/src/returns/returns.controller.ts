import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReturnsService } from './returns.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const positive = z.string().regex(/^\d+(\.\d+)?$/, '0 以上の数値で入力してください');

const CreateSchema = z.object({
  return_type: z.enum(['販社返品', '顧客返品', 'プラットフォーム返金']),
  partner_id: z.number().int().positive().nullish(),
  original_shipment_id: z.number().int().positive().nullish(),
  warehouse_id: z.number().int().positive(),
  return_date: ymd,
  note: z.string().nullish(),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().min(1),
        sku_id: z.number().int().positive(),
        qty: positive,
        unit_price: positive.optional(),
        tax_rate: z.enum(['0.00', '8.00', '10.00']).optional(),
      }),
    )
    .min(1, '返品明細を1行以上入力してください'),
});
type CreateBody = z.infer<typeof CreateSchema>;

const InspectSchema = z.object({
  lines: z
    .array(
      z.object({
        return_line_id: z.number().int().positive(),
        good_qty: positive,
        defective_qty: positive,
        refurbish_cost: positive.nullish(),
        note: z.string().nullish(),
      }),
    )
    .min(1, '検品結果を1行以上入力してください'),
});
type InspectBody = z.infer<typeof InspectSchema>;

const ListSchema = z.object({
  status: z.enum(['受付', '検品済', '完了', '取消']).optional(),
  return_type: z.enum(['販社返品', '顧客返品', 'プラットフォーム返金']).optional(),
  partner_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;

/** 機能ID R-01 返品・再生 */
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post()
  @RequirePermission('R-01', 'create')
  create(
    @Body(new ZodValidationPipe(CreateSchema)) body: CreateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.returns.create(body, user.id);
  }

  @Get()
  @RequirePermission('R-01', 'view')
  list(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.returns.list(query);
  }

  @Get(':id')
  @RequirePermission('R-01', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.returns.findOne(id);
  }

  /** 検品（再生）。良品は在庫へ戻し、不良は不良在庫へ回す。 */
  @Post(':id/inspect')
  @HttpCode(200)
  @RequirePermission('R-01', 'update')
  inspect(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(InspectSchema)) body: InspectBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.returns.inspect(id, body.lines, user.id);
  }
}

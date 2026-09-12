import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StocksService } from './stocks.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  available_only: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const MovementQuerySchema = z.object({
  sku_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  movement_type: z
    .enum(['入荷', '出荷', '引当', '引当解除', '返品入庫', '再生', '不良振替', '倉庫間移動', '棚卸調整', '廃棄'])
    .optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type MovementQuery = z.infer<typeof MovementQuerySchema>;

/** 機能ID S-01 在庫表／S-05 入出荷履歴 */
@Controller('inventory/stocks')
export class StocksController {
  constructor(private readonly stocks: StocksService) {}

  @Get()
  @RequirePermission('S-01', 'view')
  list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery) {
    return this.stocks.list(query);
  }

  /** 1つの SKU を倉庫別に。受注入力の横で「今いくつ引き当てられるか」を見る。 */
  @Get('by-sku/:skuId')
  @RequirePermission('S-01', 'view')
  bySku(@Param('skuId', ParseIntPipe) skuId: number) {
    return this.stocks.summaryBySku(skuId);
  }

  /** 入出荷履歴（機能ID S-05）。追記専用なので、記録は後から変わらない。 */
  @Get('movements')
  @RequirePermission('S-05', 'view')
  movements(@Query(new ZodValidationPipe(MovementQuerySchema)) query: MovementQuery) {
    return this.stocks.movements(query);
  }
}

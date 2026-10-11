import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from '@nestjs/common';
import { z } from 'zod';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StocksService, type StockVisibility } from './stocks.service';

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

const UpdateNoteSchema = z.object({ note: z.string().max(2000).nullable() });
type UpdateNoteBody = z.infer<typeof UpdateNoteSchema>;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const MovementQuerySchema = z.object({
  sku_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  movement_type: z
    .enum(['入荷', '出荷', '出荷取消', '引当', '引当解除', '返品入庫', '再生', '不良振替', '倉庫間移動', '棚卸調整', '廃棄'])
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
  constructor(
    private readonly stocks: StocksService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 在庫表で何を返すかを権限で決める（在庫編 Z-02・Z-04）。
   * 「閲覧者」は役割の名前ではなく「在庫を更新できない人」で判定する。
   * 役割が増えても、在庫を直せる人には実在庫・引当済が見え、そうでない人には見えない。
   */
  private async visibility(userId: number): Promise<StockVisibility> {
    const [showQty, showCost] = await Promise.all([
      this.auth.can(userId, 'S-01', 'update'),
      this.auth.canSeeSensitive(userId),
    ]);
    return { showQty, showCost };
  }

  @Get()
  @RequirePermission('S-01', 'view')
  async list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.stocks.list(query, await this.visibility(user.id));
  }

  /** 1つの SKU を倉庫別に。受注入力の横で「今いくつ引き当てられるか」を見る。 */
  @Get('by-sku/:skuId')
  @RequirePermission('S-01', 'view')
  async bySku(@Param('skuId', ParseIntPipe) skuId: number, @CurrentUser() user: AuthenticatedUser) {
    const { showQty } = await this.visibility(user.id);
    return this.stocks.summaryBySku(skuId, showQty);
  }

  /** 入出荷履歴（機能ID S-05）。追記専用なので、記録は後から変わらない。 */
  @Get('movements')
  @RequirePermission('S-05', 'view')
  movements(@Query(new ZodValidationPipe(MovementQuerySchema)) query: MovementQuery) {
    return this.stocks.movements(query);
  }

  /** 在庫表の備考を一覧の中で直す（在庫編 Z-05）。数量は変えない。 */
  @Patch(':id')
  @RequirePermission('S-01', 'update')
  updateNote(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateNoteSchema)) body: UpdateNoteBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.stocks.updateNote(id, body.note, user.id);
  }
}

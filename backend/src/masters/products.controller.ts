import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { z } from 'zod';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProductsService } from './products.service';

const ListQuerySchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  brand_id: z.coerce.number().int().positive().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

const SkuSearchSchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
type SkuSearchQuery = z.infer<typeof SkuSearchSchema>;

/** 機能ID M-08 商品マスタ／M-09 SKUコードマスタ */
@Controller('masters')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 原価は「機微項目の参照」権限を持つ利用者にだけ返す。
   * 画面側で隠すのではなく、そもそも項目を返さない。
   */
  @Get('products')
  @RequirePermission('M-08', 'view')
  async list(
    @Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const showCost = await this.auth.canSeeSensitive(user.id);
    return this.products.list({ ...query, showCost });
  }

  @Get('products/:id')
  @RequirePermission('M-08', 'view')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    const showCost = await this.auth.canSeeSensitive(user.id);
    return this.products.findOne(id, showCost);
  }

  /** 受注入力から呼ぶ SKU 検索。SKUコード・JAN・商品名・商品コードで引ける。 */
  @Get('skus')
  @RequirePermission('M-09', 'view')
  searchSkus(@Query(new ZodValidationPipe(SkuSearchSchema)) query: SkuSearchQuery) {
    return this.products.searchSkus(query);
  }
}

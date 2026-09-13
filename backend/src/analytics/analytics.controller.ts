import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AnalyticsService, DIMENSIONS, MEASURES } from './analytics.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');

const dimension = z.enum(Object.keys(DIMENSIONS) as [string, ...string[]]);
const measure = z.enum(Object.keys(MEASURES) as [string, ...string[]]);

const SalesSchema = z.object({
  from: ymd,
  to: ymd,
  dimensions: z.array(dimension).min(1).max(3),
  measures: z.array(measure).min(1),
  partner_id: z.number().int().positive().optional(),
  brand_id: z.number().int().positive().optional(),
  order_type: z.enum(['卸', '直送', '通販', 'サンプル']).optional(),
  limit: z.number().int().min(1).max(5000).default(500),
});
type SalesBody = z.infer<typeof SalesSchema>;

const SaveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target: z.string().trim().min(1).max(40),
  conditions: z.unknown(),
  // private＝本人のみ／shared＝全体（データベース側の ck_saved_scope と同じ値）
  share_scope: z.enum(['private', 'shared']).default('private'),
});
type SaveBody = z.infer<typeof SaveSchema>;

/** 機能ID A-01 販売実績管理／A-03 汎用クエリ集計 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** 選べる軸と指標。画面の選択肢に使う。 */
  @Get('options')
  @RequirePermission('A-03', 'view')
  options() {
    return this.analytics.options();
  }

  /**
   * 販売実績の集計。軸と指標を選んで期間で絞る。
   * 任意の SQL は受け取らない（選択肢から選ばせる）。
   */
  @Post('sales')
  @RequirePermission('A-01', 'view')
  sales(@Body(new ZodValidationPipe(SalesSchema)) body: SalesBody) {
    return this.analytics.sales(body as never);
  }

  @Post('saved-queries')
  @RequirePermission('A-03', 'create')
  save(
    @Body(new ZodValidationPipe(SaveSchema)) body: SaveBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analytics.saveQuery(body, user.id);
  }

  @Get('saved-queries')
  @RequirePermission('A-03', 'view')
  listSaved(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.listSavedQueries(user.id);
  }

  /** Amazon決済レポートの集計。売上と経費の振り分けを確認する。 */
  @Get('amazon-summary')
  @RequirePermission('A-01', 'view')
  amazonSummary(
    @Query(new ZodValidationPipe(z.object({ from: ymd.optional(), to: ymd.optional() })))
    query: { from?: string; to?: string },
  ) {
    return this.analytics.amazonSummary(query);
  }
}

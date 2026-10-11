import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReservationsService } from './reservations.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const ym = z.string().regex(/^\d{4}-\d{2}$/, '年月は YYYY-MM の形式で入力してください');
const positive = z.string().regex(/^\d+(\.\d+)?$/, '確保数は 0 以上の数値で入力してください');
const id = z.number().int().positive();

const LineSchema = z.object({
  /** 既存の明細を直すときだけ付ける。無ければ新しい明細 */
  id: id.nullish(),
  sku_id: id,
  reserved_qty: positive,
});

const HeaderShape = {
  period_from: ymd,
  period_to: ymd,
  /** 取引先が空のとき、この媒体の取引先の受注で減らす */
  media_id: id.nullish(),
  /** 入っていれば、この取引先の受注だけで減らす */
  partner_id: id.nullish(),
  sales_category_id: id,
  /** 項目（楽楽販売の「集計」にあたる見出し）。当て方には使わない */
  item_label: z.string().trim().max(60, '項目は60文字までです').nullish(),
  product_class_id: id.nullish(),
  note: z.string().max(2000).nullish(),
};

const CreateGroupSchema = z.object({
  ...HeaderShape,
  lines: z.array(LineSchema).min(1, '明細（商品と確保数）を1行以上入力してください'),
});
type CreateGroupBody = z.infer<typeof CreateGroupSchema>;

/** 変更はすべての項目を任意に。lines を送ったときは「画面の明細がすべて」として入れ替える */
const UpdateGroupSchema = z.object({
  ...HeaderShape,
  period_from: ymd.optional(),
  period_to: ymd.optional(),
  sales_category_id: id.optional(),
  lines: z.array(LineSchema).min(1, '明細（商品と確保数）を1行以上入力してください').optional(),
});
type UpdateGroupBody = z.infer<typeof UpdateGroupSchema>;

const FilterShape = {
  /** 月の一覧は from〜to（その月に少しでもかかる確保） */
  from: ymd.optional(),
  to: ymd.optional(),
  sales_category_id: z.coerce.number().int().positive().optional(),
  media_id: z.coerce.number().int().positive().optional(),
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).max(60).optional(),
};
const ListSchema = z.object({
  ...FilterShape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;
const ExportSchema = z.object(FilterShape);
type ExportQuery = z.infer<typeof ExportSchema>;

const SkuOptionSchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  /** 見出しで商品分類を選んでいるとき、その分類の商品だけを候補にする（Z-26） */
  product_class_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
type SkuOptionQuery = z.infer<typeof SkuOptionSchema>;

const CopyMonthSchema = z.object({ from_month: ym, to_month: ym });
type CopyMonthBody = z.infer<typeof CopyMonthSchema>;

/**
 * 引当在庫の「確保」（見出し＋明細。在庫編 Z-25〜Z-32）。機能ID S-08（引当在庫＝取引先別確保数）。
 * 明細1行ずつの古い経路 /inventory/reservations も残してある（inventory.controller.ts）。
 * 決まった名前の経路（export・sku-options・copy-month）は :id より先に置く。
 */
@Controller('inventory/reservation-groups')
export class ReservationGroupsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @RequirePermission('S-08', 'view')
  list(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.reservations.listGroups(query);
  }

  /** 一覧の CSV（Z-29）。一覧と同じ列の並びで1明細1行。BOM 付き UTF-8。 */
  @Get('export')
  @RequirePermission('S-08', 'print')
  async export(@Query(new ZodValidationPipe(ExportSchema)) query: ExportQuery, @Res() res: Response): Promise<void> {
    const csv = await this.reservations.exportCsv(query);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const name = `引当在庫_${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="reservations-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.end(csv);
  }

  /** 明細の商品の候補。商品分類で絞れる。SKU の商品名・カラー・サイズを返す。 */
  @Get('sku-options')
  @RequirePermission('S-08', 'view')
  skuOptions(@Query(new ZodValidationPipe(SkuOptionSchema)) query: SkuOptionQuery) {
    return this.reservations.skuOptions(query);
  }

  /** 前月の確保を翌月分として複写する（見出しごと。明細も写し、使用数は 0 から）。 */
  @Post('copy-month')
  @HttpCode(200)
  @RequirePermission('S-08', 'create')
  copyMonth(@Body(new ZodValidationPipe(CopyMonthSchema)) body: CopyMonthBody, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.copyMonth(body, user.id);
  }

  @Get(':id')
  @RequirePermission('S-08', 'view')
  findOne(@Param('id', ParseIntPipe) groupId: number) {
    return this.reservations.findGroup(groupId);
  }

  @Post()
  @RequirePermission('S-08', 'create')
  create(@Body(new ZodValidationPipe(CreateGroupSchema)) body: CreateGroupBody, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.createGroup(body, user.id);
  }

  /**
   * 確保の変更（Z-32）。見出し・明細のすべてを直せる。
   * 使われている明細は、消せない・商品を変えられない・使用数より減らせない。
   */
  @Patch(':id')
  @RequirePermission('S-08', 'update')
  update(
    @Param('id', ParseIntPipe) groupId: number,
    @Body(new ZodValidationPipe(UpdateGroupSchema)) body: UpdateGroupBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.updateGroup(groupId, body, user.id);
  }

  /** 確保の削除（Z-28）。受注で使われている明細があれば消せない。 */
  @Delete(':id')
  @RequirePermission('S-08', 'delete')
  remove(@Param('id', ParseIntPipe) groupId: number) {
    return this.reservations.removeGroup(groupId);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrderListService, type IdFilter } from './order-list.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

/** カンマ区切りの値（状態・区分を複数選ぶ）。選択肢にない値は 400 */
const valueList = (values: readonly string[], label: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const items = (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (items.length === 0) return undefined;
      const bad = items.filter((s) => !values.includes(s));
      if (bad.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}に使えない値です（${bad.join('、')}）` });
        return z.NEVER;
      }
      return items;
    });

/** カンマ区切りの ID（取引先・納品先・販売カテゴリー・販売担当を複数選ぶ）。none は「値が空」 */
const idList = (label: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx): IdFilter | undefined => {
      const items = (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (items.length === 0) return undefined;
      const out: IdFilter = { ids: [], none: false };
      for (const s of items) {
        if (s === 'none') out.none = true;
        else if (/^\d{1,15}$/.test(s) && Number(s) > 0) out.ids.push(Number(s));
        else {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}の指定が正しくありません（${s}）` });
          return z.NEVER;
        }
      }
      return out;
    });

const FilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: valueList(['未確定', '引当待ち', '引当済', '出荷指示済', '出荷済', '取消'], '状態'),
  order_type: valueList(['卸', '直送', '通販', '社内移動', 'サンプル', '返品'], '受注区分'),
  partner_ids: idList('取引先'),
  destination_ids: idList('納品先'),
  sales_category_ids: idList('販売カテゴリー'),
  sales_staff_ids: idList('販売担当'),
  ship_from: ymd.optional(),
  ship_to: ymd.optional(),
  delivery_from: ymd.optional(),
  delivery_to: ymd.optional(),
  include_cancelled: flag,
});

const ListQuerySchema = FilterSchema.extend({
  sort: z.enum(['ship_date', 'order_no']).default('ship_date'),
  with_lines: flag,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

const FacetQuerySchema = FilterSchema.extend({
  field: z.enum(['type', 'partner', 'destination', 'category', 'staff', 'status']),
});
type FacetQuery = z.infer<typeof FacetQuerySchema>;

const AllocateSchema = z.object({
  order_ids: z.array(z.number().int().positive()).min(1, '受注を選んでください').max(500, '一度に引き当てられるのは 500 件までです'),
});
type AllocateBody = z.infer<typeof AllocateSchema>;

/** 日付は空にできる（空文字も空として受ける） */
const optionalDate = z
  .union([ymd, z.literal(''), z.null()])
  .transform((v) => (v ? v : null))
  .optional();
/** 備考（複数行）。空白だけなら空 */
const remarks = z
  .string()
  .max(2000, '2000 文字以内で入力してください')
  .nullable()
  .transform((v) => (v === null || v.trim() === '' ? null : v.replace(/\s+$/, '')))
  .optional();
/** 明細の出荷依頼書適用・納品書適用（各 200 字） */
const lineNote = z
  .string()
  .max(200, '200 文字以内で入力してください')
  .nullable()
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))
  .optional();

const PatchSchema = z
  .object({
    ship_date: optionalDate,
    delivery_date: optionalDate,
    delivery_time_code_id: z.number().int().positive().nullable().optional(),
    shipping_remarks: remarks,
    delivery_note_remarks: remarks,
    lines: z
      .array(z.object({ id: z.number().int().positive(), shipping_note: lineNote, delivery_slip_note: lineNote }).strict())
      .max(500)
      .optional(),
  })
  .strict();
type PatchBody = z.infer<typeof PatchSchema>;

/**
 * 受注一覧（2026-10-13 受注処理編 O-15〜O-22）。
 * 受注の登録・修正・取消（/orders）とは別の経路にしてある。権限は今の受注一覧・引当・受注の修正と同じ。
 */
@Controller('order-list')
export class OrderListController {
  constructor(private readonly list: OrderListService) {}

  /** 一覧（O-15〜O-18・O-20・O-21） */
  @Get()
  @RequirePermission('O-03', 'view')
  find(@Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery) {
    return this.list.list(query);
  }

  /** 列の絞り込みの値の一覧と件数（O-20） */
  @Get('facets')
  @RequirePermission('O-03', 'view')
  facets(@Query(new ZodValidationPipe(FacetQuerySchema)) query: FacetQuery) {
    return this.list.facets(query.field, query);
  }

  /** 納品時間の選択肢（編集モードの欄。O-22） */
  @Get('delivery-times')
  @RequirePermission('O-03', 'view')
  deliveryTimes() {
    return this.list.deliveryTimes();
  }

  /** まとめて引当（O-19）。受注ごとの結果を返す（失敗した受注があってもほかは続ける） */
  @Post('allocate')
  @HttpCode(200)
  @RequirePermission('D-01', 'create')
  allocate(@Body(new ZodValidationPipe(AllocateSchema)) body: AllocateBody, @CurrentUser() user: AuthenticatedUser) {
    return this.list.allocateMany(body.order_ids, user.id);
  }

  /** 一覧のまま直す（O-22）。直したあとの一覧の1行（明細つき）を返す */
  @Patch(':id')
  @RequirePermission('O-01', 'update')
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PatchSchema)) body: PatchBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.list.patch(id, body, user.id);
  }
}

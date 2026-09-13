import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BillingService } from './billing.service';
import { RoyaltyService } from './royalty.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const ym = z.string().regex(/^\d{4}-\d{2}$/, '対象年月は YYYY-MM の形式で入力してください');
const positive = z.string().regex(/^\d+(\.\d+)?$/, '0 以上の数値で入力してください');
/** 調整欄は値引きも入れるため負数を許す。 */
const amount = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');

const ClosingSchema = z.object({
  target_month: ym,
  partner_id: z.number().int().positive().nullish(),
});
type ClosingBody = z.infer<typeof ClosingSchema>;

const InvoiceListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['未発行', '発行済', '取消']).optional(),
  period_to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type InvoiceListQuery = z.infer<typeof InvoiceListSchema>;

const CashReceiptSchema = z.object({
  partner_id: z.number().int().positive(),
  receipt_date: ymd,
  amount: positive,
  invoice_id: z.number().int().positive().nullish(),
  applied_amount: positive.nullish(),
  note: z.string().nullish(),
});
type CashReceiptBody = z.infer<typeof CashReceiptSchema>;

const CashReceiptListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type CashReceiptListQuery = z.infer<typeof CashReceiptListSchema>;

/** 請求の手入力欄。定義が固まるまで手で入れていただく項目（要件定義書 第10章）。 */
const InvoiceUpdateSchema = z.object({
  unposted_10: amount.optional(),
  unposted_8: amount.optional(),
  adjust_10: amount.optional(),
  adjust_8: amount.optional(),
  fee_amount: amount.optional(),
  shipping_fee_amount: amount.optional(),
  po_no: z.string().trim().max(40).nullish(),
});
type InvoiceUpdateBody = z.infer<typeof InvoiceUpdateSchema>;

const RoyaltyCalcSchema = z.object({ target_month: ym });
type RoyaltyCalcBody = z.infer<typeof RoyaltyCalcSchema>;

const RoyaltyListSchema = z.object({
  target_month: ym.optional(),
  payee_partner_id: z.coerce.number().int().positive().optional(),
});
type RoyaltyListQuery = z.infer<typeof RoyaltyListSchema>;

/** 機能ID B-01 締め処理／B-02 請求書発行／B-04 売掛残高一覧／B-05 入金登録・消込／Y-02 ロイヤリティ計算 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly royalty: RoyaltyService,
  ) {}

  /** 締め処理。取引先ごとの締め日で期間を切って集計する。 */
  @Post('closings')
  @HttpCode(200)
  @RequirePermission('B-01', 'create')
  close(
    @Body(new ZodValidationPipe(ClosingSchema)) body: ClosingBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.close(body, user.id);
  }

  @Get('invoices')
  @RequirePermission('B-02', 'view')
  listInvoices(@Query(new ZodValidationPipe(InvoiceListSchema)) query: InvoiceListQuery) {
    return this.billing.listInvoices(query);
  }

  @Get('invoices/:id')
  @RequirePermission('B-02', 'view')
  findInvoice(@Param('id', ParseIntPipe) id: number) {
    return this.billing.findInvoice(id);
  }

  /** 未計上・調整・手数料・送料の手入力。直すと当月請求額と残高を計算し直す。 */
  @Patch('invoices/:id')
  @RequirePermission('B-02', 'update')
  updateInvoice(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(InvoiceUpdateSchema)) body: InvoiceUpdateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.updateInvoice(id, body, user.id);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermission('B-02', 'print')
  issue(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.billing.issueInvoice(id, user.id);
  }

  /** 売掛残高一覧。現行と同じ12項目を同じ並びで返す。 */
  @Get('ar-balances')
  @RequirePermission('B-04', 'view')
  arBalances(@Query(new ZodValidationPipe(InvoiceListSchema)) query: InvoiceListQuery) {
    return this.billing.listInvoices(query);
  }

  @Post('cash-receipts')
  @RequirePermission('B-05', 'create')
  createCashReceipt(
    @Body(new ZodValidationPipe(CashReceiptSchema)) body: CashReceiptBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.createCashReceipt(body, user.id);
  }

  @Get('cash-receipts')
  @RequirePermission('B-05', 'view')
  listCashReceipts(@Query(new ZodValidationPipe(CashReceiptListSchema)) query: CashReceiptListQuery) {
    return this.billing.listCashReceipts(query);
  }

  // ---- ロイヤリティ -------------------------------------------------------
  @Post('royalties/calculate')
  @HttpCode(200)
  @RequirePermission('Y-02', 'create')
  calculateRoyalty(
    @Body(new ZodValidationPipe(RoyaltyCalcSchema)) body: RoyaltyCalcBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.royalty.calculate(body.target_month, user.id);
  }

  @Get('royalties')
  @RequirePermission('Y-02', 'view')
  listRoyalties(@Query(new ZodValidationPipe(RoyaltyListSchema)) query: RoyaltyListQuery) {
    return this.royalty.list(query);
  }

  @Get('royalties/:id')
  @RequirePermission('Y-02', 'view')
  findRoyalty(@Param('id', ParseIntPipe) id: number) {
    return this.royalty.findOne(id);
  }

  @Post('royalties/:id/confirm')
  @HttpCode(200)
  @RequirePermission('Y-02', 'update')
  confirmRoyalty(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.royalty.confirm(id, user.id);
  }
}

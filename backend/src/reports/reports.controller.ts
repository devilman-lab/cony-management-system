import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  DELIVERY_NOTE_FORMS,
  PRINT_DOCUMENTS,
  ReportsService,
  type PrintResult,
} from './reports.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');

/** 「1,2,3」を数値の配列にする。一括印刷なので複数指定が既定。 */
const idList = (label: string) =>
  z
    .string()
    .min(1, `${label}を選んでください`)
    .transform((v, ctx) => {
      const ids = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
      if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}の指定が正しくありません` });
        return z.NEVER;
      }
      return ids;
    });

const ShipmentIdsSchema = z.object({ shipment_ids: idList('出荷') });
type ShipmentIdsQuery = z.infer<typeof ShipmentIdsSchema>;

const DeliveryNoteSchema = z.object({
  shipment_ids: idList('出荷'),
  form: z.enum(DELIVERY_NOTE_FORMS).optional(),
});
type DeliveryNoteQuery = z.infer<typeof DeliveryNoteSchema>;

const ConfirmAndPrintSchema = z.object({
  shipment_ids: z.array(z.number().int().positive()).min(1, '出荷を選んでください'),
  /** 一緒に出す帳票。既定は出荷指示書と納品書。 */
  documents: z.array(z.enum(PRINT_DOCUMENTS)).min(1).default(['出荷指示書', '納品書']),
  form: z.enum(DELIVERY_NOTE_FORMS).optional(),
  ship_date: ymd.nullish(),
  include_attachments: z.boolean().default(true),
});
type ConfirmAndPrintBody = z.infer<typeof ConfirmAndPrintSchema>;

const InvoiceIdsSchema = z.object({ invoice_ids: idList('請求書') });
type InvoiceIdsQuery = z.infer<typeof InvoiceIdsSchema>;

/**
 * 機能ID D-03 帳票一括印刷。
 *
 * 選んだ伝票をまとめて1つの PDF にする。1件1ページで、
 * 明細が入りきらないときだけ見出しごと次ページへ繰り越す。
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 出荷確定と印刷を同時に行う（物流PCの「出荷確定」ボタン。9/15 ご確認②）。
   * 出荷確定（D-01:update）と印刷（D-03:print）の両方の権限が要る。
   * 応答は PDF。一緒に印刷できなかった添付があれば X-Skipped-Attachments で知らせる。
   */
  @Post('confirm-and-print')
  @HttpCode(200)
  @RequirePermission('D-01', 'update')
  async confirmAndPrint(
    @Body(new ZodValidationPipe(ConfirmAndPrintSchema)) body: ConfirmAndPrintBody,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.auth.can(user.id, 'D-03', 'print'))) {
      throw new ForbiddenException('帳票を印刷する権限がありません');
    }
    const result = await this.reports.confirmAndPrint(body, user.id);
    res.setHeader('X-Confirmed-Shipments', result.confirmed.map((c) => c.shipment_no).join(','));
    send(res, result);
  }

  @Get('shipping-instructions')
  @RequirePermission('D-03', 'print')
  async shippingInstructions(
    @Query(new ZodValidationPipe(ShipmentIdsSchema)) query: ShipmentIdsQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.reports.shippingInstructions(query.shipment_ids, user.id));
  }

  @Get('picking-list')
  @RequirePermission('D-03', 'print')
  async pickingList(
    @Query(new ZodValidationPipe(ShipmentIdsSchema)) query: ShipmentIdsQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.reports.pickingList(query.shipment_ids, user.id));
  }

  @Get('delivery-notes')
  @RequirePermission('D-03', 'print')
  async deliveryNotes(
    @Query(new ZodValidationPipe(DeliveryNoteSchema)) query: DeliveryNoteQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.reports.deliveryNotes(query.shipment_ids, query.form, user.id));
  }

  @Get('invoices')
  @RequirePermission('D-03', 'print')
  async invoices(
    @Query(new ZodValidationPipe(InvoiceIdsSchema)) query: InvoiceIdsQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.reports.invoices(query.invoice_ids, user.id));
  }
}

/** ファイル名に日本語を使うため、RFC 5987 の形でも添える。 */
function send(res: Response, result: PrintResult): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
  );
  if (result.skipped && result.skipped.length > 0) {
    res.setHeader('X-Skipped-Attachments', encodeURIComponent(result.skipped.join(',')));
  }
  res.setHeader('Content-Length', String(result.pdf.length));
  res.end(result.pdf);
}

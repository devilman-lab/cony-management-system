import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AmazonImportService } from './amazon-import.service';
import { OmsImportService } from './oms-import.service';
import { PartnerOrderImportService } from './partner-order-import.service';

const ImportSchema = z.object({
  template_code: z.string().trim().min(1).max(40),
  file_name: z.string().trim().min(1).max(255),
  content_base64: z.string().min(1, 'ファイルの中身が空です'),
  /** 読めるかどうかだけ確かめて登録しない。取込前の確認に使う。 */
  dry_run: z.boolean().optional(),
});
type ImportBody = z.infer<typeof ImportSchema>;

const ListSchema = z.object({
  import_type: z.enum(['PARTNER_ORDER', 'OMS_ORDER', 'AMAZON_TRANSACTION']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;

const OmsSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  content_base64: z.string().min(1, 'ファイルの中身が空です'),
  encoding: z.string().trim().min(1).max(20).optional(),
  dry_run: z.boolean().optional(),
});
type OmsBody = z.infer<typeof OmsSchema>;

/** 機能ID I-01 CSV取込 */
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly partnerOrders: PartnerOrderImportService,
    private readonly oms: OmsImportService,
    private readonly amazon: AmazonImportService,
  ) {}

  /**
   * 販社の発注CSVを取り込む。
   * 書式は取込テンプレートに登録してあり、この処理は販社名を知らない。
   * Shift-JIS をそのまま渡せるよう、中身は base64 で受け取る。
   */
  @Post('partner-orders')
  @HttpCode(200)
  @RequirePermission('I-01', 'create')
  importPartnerOrders(
    @Body(new ZodValidationPipe(ImportSchema)) body: ImportBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.partnerOrders.import(body, user.id);
  }

  /**
   * 通販（OMS）受注CSVを取り込む。貴社ご回答により出荷済みのデータとして扱う。
   * 見出し名で列を対応させるため、63列の並びが変わっても読める。
   */
  @Post('oms-orders')
  @HttpCode(200)
  @RequirePermission('I-01', 'create')
  importOmsOrders(
    @Body(new ZodValidationPipe(OmsSchema)) body: OmsBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.oms.import(body, user.id);
  }

  /**
   * Amazon の決済レポートを取り込む。
   * 先頭の説明文の行数は月によって変わるため、見出し行は内容で探す。
   */
  @Post('amazon-transactions')
  @HttpCode(200)
  @RequirePermission('I-01', 'create')
  importAmazon(
    @Body(new ZodValidationPipe(OmsSchema)) body: OmsBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.amazon.import(body, user.id);
  }

  @Get('batches')
  @RequirePermission('I-01', 'view')
  listBatches(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.partnerOrders.listBatches(query);
  }

  /** 取り込んだが受注にできていないもの。マスタ登録が済んだら取り込み直す。 */
  @Get('pending')
  @RequirePermission('I-01', 'view')
  listPending(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.partnerOrders.listPending(query);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PostalCodesService } from './postal-codes.service';

const SearchSchema = z.object({
  q: z.string().trim().min(1, '住所の一部を入力してください').max(60),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
type SearchQuery = z.infer<typeof SearchSchema>;

const ImportSchema = z.object({
  /** 取込履歴に残すファイル名。画面から送られる。 */
  file_name: z.string().trim().min(1).max(255).optional(),
  content_base64: z.string().min(1, 'ファイルの中身が空です'),
  encoding: z.string().trim().min(1).max(20).optional(),
  /** 取り込んだ版。YYYYMM */
  data_version: z
    .string()
    .regex(/^\d{6}$/, '版は YYYYMM の6桁で入力してください')
    .optional(),
  // 12万件を一気に置き換える取込のため、件数を見てから本番に流せるようにする。
  // ここに無いと画面の「確認だけ」が捨てられ、そのまま登録されてしまう。
  dry_run: z.boolean().optional(),
});
type ImportBody = z.infer<typeof ImportSchema>;

/**
 * 郵便番号から住所を引く。
 *
 * 受注・納品先・取引先の住所入力から呼ぶ共通の参照で、個人情報は含まない
 * 公開データのため、ログインしていれば誰でも引けるようにしている。
 * 取り込み（保守契約の定期更新）だけは取込権限が要る。
 */
@Controller('postal-codes')
export class PostalCodesController {
  constructor(private readonly postal: PostalCodesService) {}

  /** 住所の一部から探す（逆引き）。`:code` より先に置く。 */
  @Get('search')
  search(@Query(new ZodValidationPipe(SearchSchema)) query: SearchQuery) {
    return this.postal.search(query.q, query.limit);
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermission('I-01', 'create')
  import(
    @Body(new ZodValidationPipe(ImportSchema)) body: ImportBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.postal.importKenAll(body, user.id);
  }

  /** 同じ郵便番号に複数の町域があるため、必ず配列で返す。 */
  @Get(':code')
  lookup(@Param('code') code: string) {
    return this.postal.lookup(code);
  }
}

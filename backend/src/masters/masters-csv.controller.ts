import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MastersCsvService } from './masters-csv.service';
import { CSV_SLUGS, MASTER_CSV } from './masters-csv';

const ExportSchema = z.object({
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
type ExportQuery = z.infer<typeof ExportSchema>;

const RowsSchema = ExportSchema.extend({
  q: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type RowsQuery = z.infer<typeof RowsSchema>;

const ImportSchema = z.object({
  /** CSV の中身。画面から base64 で送る */
  content_base64: z.string().min(1, 'ファイルを選んでください'),
  /** true なら何も書かずに「こうなります」だけを返す */
  dry_run: z.boolean().default(true),
});
type ImportBody = z.infer<typeof ImportSchema>;

/**
 * マスタの CSV 書き出し・取り込み（2026-10-01 ご要望）。
 *
 * **権限はここで自分で確かめます。**
 * 扱うマスタが URL で変わるため `@RequirePermission` の固定指定が使えません。
 * 付け忘れると素通しになるので、すべての経路の先頭で必ず `assert` を通しています。
 */
@Controller('masters/csv')
export class MastersCsvController {
  constructor(
    private readonly csv: MastersCsvService,
    private readonly auth: AuthService,
  ) {}

  /** この人がこのマスタをこの操作でよいか。だめなら 403。 */
  private async assert(user: AuthenticatedUser, slug: string, action: 'print' | 'update'): Promise<void> {
    const def = this.csv.def(slug);
    const ok = await this.auth.can(user.id, def.functionId, action);
    if (!ok) throw new ForbiddenException(`${def.label}マスタの${action === 'print' ? '書き出し' : '取り込み'}を行う権限がありません`);
  }

  /** 書き出せるマスタの一覧。画面のボタンの出し分けに使う。 */
  @Get()
  list() {
    return {
      items: CSV_SLUGS.map((slug) => ({
        slug,
        label: MASTER_CSV[slug].label,
        function_id: MASTER_CSV[slug].functionId,
        key_labels: MASTER_CSV[slug].keyFields.map(
          (f) => MASTER_CSV[slug].columns.find((c) => c.field === f)?.label ?? f,
        ),
      })),
    };
  }

  /** 見出しと欄の説明。取り込み画面で「どの列が使えるか」を出すのに使う。 */
  @Get(':slug/columns')
  async columns(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser) {
    await this.assert(user, slug, 'print');
    const def = this.csv.def(slug);
    const showSensitive = await this.auth.canSeeSensitive(user.id);
    return {
      label: def.label,
      key_labels: def.keyFields.map((f) => def.columns.find((c) => c.field === f)?.label ?? f),
      columns: def.columns
        .filter((c) => !c.sensitive || showSensitive)
        .map((c) => ({ label: c.label, kind: c.kind ?? 'text', ref: c.ref?.label ?? null, read_only: c.readOnly ?? false })),
    };
  }

  /**
   * 一覧内編集の行（2026-10-01 ご要望）。CSV と同じ欄・同じ見方で返す。
   * 見るだけなので print の権限で読める。書き込みは取り込みの経路を通る。
   */
  @Get(':slug/rows')
  async rows(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(RowsSchema)) query: RowsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.assert(user, slug, 'print');
    const showSensitive = await this.auth.canSeeSensitive(user.id);
    return this.csv.gridRows(slug, {
      includeInactive: query.include_inactive,
      showSensitive,
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** CSV を書き出す。Excel がそのまま開ける形（BOM付き・CRLF）で返す。 */
  @Get(':slug/export')
  async export(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(ExportSchema)) query: ExportQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.assert(user, slug, 'print');
    const def = this.csv.def(slug);
    const showSensitive = await this.auth.canSeeSensitive(user.id);
    const csv = await this.csv.exportCsv(slug, query.include_inactive, showSensitive);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const name = `${def.label}_${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${slug}-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.end(csv);
  }

  /**
   * CSV を取り込む。
   * 既定は下見（dry_run）。画面で中身を確かめてから、もう一度 dry_run=false で送ります。
   */
  @Post(':slug/import')
  @HttpCode(200)
  async import(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(ImportSchema)) body: ImportBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.assert(user, slug, 'update');
    const showSensitive = await this.auth.canSeeSensitive(user.id);
    return this.csv.importCsv(slug, body.content_base64, body.dry_run, showSensitive, user.id);
  }
}

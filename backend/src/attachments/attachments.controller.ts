import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ATTACHABLE, AttachmentsService } from './attachments.service';

const refTable = z.enum(Object.keys(ATTACHABLE) as [string, ...string[]], {
  errorMap: () => ({ message: `添付できるのは ${Object.values(ATTACHABLE).join('・')} です` }),
});

const ListSchema = z.object({
  ref_table: refTable,
  ref_id: z.coerce.number().int().positive(),
});
type ListQuery = z.infer<typeof ListSchema>;

const CreateSchema = z.object({
  ref_table: refTable,
  ref_id: z.number().int().positive(),
  file_name: z.string().trim().min(1, 'ファイル名を入れてください').max(255),
  content_base64: z.string().min(1, 'ファイルの中身が空です'),
  mime_type: z.string().trim().max(120).nullish(),
  is_print_target: z.boolean().optional(),
});
type CreateBody = z.infer<typeof CreateSchema>;

/**
 * 添付ファイル。**実体はディスクに置き、データベースには目録だけを持つ。**
 * 置き場所は環境変数 ATTACHMENT_DIR で変えられる。
 *
 * 受注・出荷に付けたものは出荷指示のときに一緒に印刷する対象になるため、
 * 権限は出荷指示（D-01）に合わせている。
 */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @RequirePermission('D-01', 'view')
  list(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    return this.attachments.list(query.ref_table as never, query.ref_id);
  }

  @Post()
  @RequirePermission('D-01', 'update')
  create(
    @Body(new ZodValidationPipe(CreateSchema)) body: CreateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attachments.create(body as never, user.id);
  }

  @Get(':id/content')
  @RequirePermission('D-01', 'view')
  async content(@Param('id', ParseIntPipe) id: number, @Res() res: Response): Promise<void> {
    const file = await this.attachments.read(id);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.end(file.content);
  }

  @Delete(':id')
  @RequirePermission('D-01', 'delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.attachments.remove(id);
  }
}

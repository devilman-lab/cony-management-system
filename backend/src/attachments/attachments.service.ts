import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

import { env } from '../config/env';
import { KYSELY, type ConyDatabase } from '../db/database.module';

/**
 * 添付できる伝票の種類。
 * ここに無いものは受け付けない。`ref_table` をそのまま信じると、
 * 存在しない表の名前でいくらでも行が作れてしまうため。
 */
export const ATTACHABLE = {
  sales_orders: '受注',
  shipments: '出荷',
  purchases: '仕入',
  returns: '返品',
  partners: '取引先',
  products: '商品',
} as const;

export type AttachableTable = keyof typeof ATTACHABLE;

export interface AttachmentInput {
  ref_table: AttachableTable;
  ref_id: number;
  file_name: string;
  content_base64: string;
  mime_type?: string | null;
  /** 出荷指示のときに一緒に印刷するかどうか。 */
  is_print_target?: boolean;
}

@Injectable()
export class AttachmentsService {
  private readonly root = resolve(env.ATTACHMENT_DIR);

  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async list(refTable: AttachableTable, refId: number) {
    return this.db
      .selectFrom('attachments as a')
      .leftJoin('users as u', 'u.id', 'a.created_by')
      .select([
        'a.id',
        'a.ref_table',
        'a.ref_id',
        'a.file_name',
        'a.mime_type',
        'a.byte_size',
        'a.is_print_target',
        'a.created_at',
        'u.name as created_by_name',
      ])
      .where('a.ref_table', '=', refTable)
      .where('a.ref_id', '=', refId)
      .orderBy('a.id')
      .execute();
  }

  async create(input: AttachmentInput, userId: number) {
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('ファイルの中身が空です');

    const limit = env.MAX_UPLOAD_MB * 1024 * 1024;
    if (bytes.length > limit) {
      throw new BadRequestException(`ファイルが大きすぎます（上限 ${env.MAX_UPLOAD_MB}MB）`);
    }

    await this.assertRefExists(input.ref_table, input.ref_id);

    // 保存名はこちらで決める。利用者が付けた名前をそのままパスに使うと、
    // ../ を含む名前で外に書き出せてしまう。元の名前は file_name に持つ。
    const ext = extname(input.file_name).slice(0, 16).replace(/[^.\w]/g, '');
    const relative = join(input.ref_table, String(input.ref_id), `${randomUUID()}${ext}`);
    const full = join(this.root, relative);

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);

    return this.db
      .insertInto('attachments')
      .values({
        ref_table: input.ref_table,
        ref_id: input.ref_id,
        file_name: input.file_name,
        storage_path: relative.replace(/\\/g, '/'),
        mime_type: input.mime_type ?? null,
        byte_size: bytes.length,
        is_print_target: input.is_print_target ?? true,
        created_by: userId,
      })
      .returning([
        'id',
        'ref_table',
        'ref_id',
        'file_name',
        'mime_type',
        'byte_size',
        'is_print_target',
      ])
      .executeTakeFirstOrThrow();
  }

  async read(id: number): Promise<{ file_name: string; mime_type: string; content: Buffer }> {
    const row = await this.db
      .selectFrom('attachments')
      .select(['file_name', 'storage_path', 'mime_type'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`添付ファイルが見つかりません（ID: ${id}）`);

    const full = resolve(this.root, row.storage_path);
    if (!full.startsWith(this.root)) {
      throw new NotFoundException('添付ファイルの置き場所が正しくありません');
    }

    try {
      return {
        file_name: row.file_name,
        mime_type: row.mime_type ?? 'application/octet-stream',
        content: await readFile(full),
      };
    } catch {
      throw new NotFoundException(
        `添付ファイルの実体が見当たりません（${row.file_name}）。保存先の設定をご確認ください`,
      );
    }
  }

  /** 行を消し、実体も消す。実体が既に無くても行は消す。 */
  async remove(id: number) {
    const row = await this.db
      .deleteFrom('attachments')
      .where('id', '=', id)
      .returning(['id', 'storage_path', 'file_name'])
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`添付ファイルが見つかりません（ID: ${id}）`);

    const full = resolve(this.root, row.storage_path);
    if (full.startsWith(this.root)) await unlink(full).catch(() => undefined);

    return { id: row.id, file_name: row.file_name, deleted: true };
  }

  /** 添付先の伝票が実在することを確かめる。消えた伝票にぶら下げないため。 */
  private async assertRefExists(refTable: AttachableTable, refId: number): Promise<void> {
    const row = await this.db
      .selectFrom(refTable)
      .select('id')
      .where('id', '=', refId)
      .executeTakeFirst();

    if (!row) {
      throw new BadRequestException(
        `${ATTACHABLE[refTable]}が見つかりません（ID: ${refId}）。先に登録してください`,
      );
    }
  }
}

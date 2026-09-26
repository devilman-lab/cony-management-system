import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';

import { Public } from '../auth/guards';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { env } from '../config/env';
import { findJapaneseFont, fontSearchTrace } from '../reports/pdf-font';

interface DbHealth {
  status: 'ok' | 'ng';
  schema: string;
  tables: number;
  expected_tables: number;
  seed: {
    code_categories: number;
    system_settings: number;
    import_templates: number;
    warehouses: number;
  };
  /** 帳票PDFに使う日本語書体。稼働先によって入っているものが違うため、ここで見えるようにする。 */
  pdf_font: {
    status: 'ok' | 'ng';
    path: string | null;
    /** pdfkit に渡す名前（postscriptName）。単体ファイルのときは無し。 */
    name: string | null;
    /** 見つからなかったときに、どこを探したか。 */
    looked: string[];
  };
  notes: string[];
}

@Controller('health')
export class HealthController {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  @Public()
  @Get()
  live(): { status: string; time: string } {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /**
   * アプリが見ているデータベースが、SQL で構築したものと同じかを確かめる。
   * 接続先を間違えたまま開発を進めるのが一番やっかいなので、数で照合する。
   *
   * 中身の件数を返すため、こちらはログインを必要とする。
   * 監視から叩く生存確認は上の `/api/health`（ログイン不要）を使う。
   */
  @Get('db')
  async database(): Promise<DbHealth> {
    // information_schema は生成した型に含めていないため、素の SQL で数える
    const tableCount = await sql<{ n: number }>`
      select count(*)::int as n
        from information_schema.tables
       where table_schema = ${env.DB_SCHEMA}
         and table_type = 'BASE TABLE'
    `.execute(this.db);

    const [codeCategories, settings, templates, warehouses] = await Promise.all([
      this.count('code_categories'),
      this.count('system_settings'),
      this.count('import_templates'),
      this.count('warehouses'),
    ]);

    const tables = Number(tableCount.rows[0]?.n ?? 0);
    const notes: string[] = [];
    if (tables !== 70) notes.push(`テーブル数が ${tables} 件です（期待 70 件）。02-schema.sql を適用してください。`);
    if (settings === 0) notes.push('システム設定が空です。03-seed-data.sql を適用してください。');

    // 帳票の書体。無いと納品書・請求書が出せないので、稼働先で真っ先に確かめられるようにする。
    const font = findJapaneseFont();
    if (!font) {
      notes.push(
        '帳票PDFの日本語書体が見つかりません。納品書・請求書・ピッキングリストが出せません。' +
          'PDF_FONT_PATH を設定するか、サーバーに日本語フォントを入れてください。',
      );
    }

    return {
      status: tables === 70 && settings > 0 && font ? 'ok' : 'ng',
      schema: env.DB_SCHEMA,
      tables,
      expected_tables: 70,
      seed: {
        code_categories: codeCategories,
        system_settings: settings,
        import_templates: templates,
        warehouses,
      },
      pdf_font: {
        status: font ? 'ok' : 'ng',
        path: font?.path ?? null,
        name: font?.family ?? null,
        looked: font ? [] : fontSearchTrace(),
      },
      notes,
    };
  }

  private async count(table: 'code_categories' | 'system_settings' | 'import_templates' | 'warehouses'): Promise<number> {
    const row = await this.db
      .selectFrom(table)
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}

import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';

import { Public } from '../auth/guards';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { env } from '../config/env';

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
   */
  @Public()
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
    if (tables !== 69) notes.push(`テーブル数が ${tables} 件です（期待 69 件）。02-schema.sql を適用してください。`);
    if (settings === 0) notes.push('システム設定が空です。03-seed-data.sql を適用してください。');

    return {
      status: tables === 69 && settings > 0 ? 'ok' : 'ng',
      schema: env.DB_SCHEMA,
      tables,
      expected_tables: 69,
      seed: {
        code_categories: codeCategories,
        system_settings: settings,
        import_templates: templates,
        warehouses,
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

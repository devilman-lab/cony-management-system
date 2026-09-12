import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';

import { env } from '../config/env';
import type { DB } from './schema';

/**
 * node-postgres の型変換をここで一度だけ決める。
 *
 *  int8 (20)   -> number  : 行IDと count(*)。2^53 まで正確なので実用上問題ない。
 *  date (1082) -> string  : 日付に時刻はない。Date にすると時差でずれるため触らない。
 *  numeric     -> 既定のまま文字列。金額を float に通さないための要。
 */
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.DATE, (v) => v);

export const KYSELY = Symbol('KYSELY');
export type ConyDatabase = Kysely<DB>;

const provider = {
  provide: KYSELY,
  useFactory: (): ConyDatabase => {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
      // 検索パスを固定する。アプリから public のオブジェクトは見に行かない。
      options: `-c search_path=${env.DB_SCHEMA},public`,
      application_name: 'cony-backend',
    });

    return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  },
};

@Global()
@Module({
  providers: [provider],
  exports: [provider],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  /** 終了時に接続を閉じる。閉じ忘れるとコンテナが止まらない。 */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

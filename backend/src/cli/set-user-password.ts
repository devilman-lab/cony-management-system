/**
 * 利用者のパスワードを設定する。
 *
 * 03-seed-data.sql が入れる admin の password_hash は差し替え前提の文字列で、
 * そのままではログインできない。導入時にこれで実際の値を入れる。
 *
 *   npm run user:password -- admin "実際のパスワード"
 */
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';

import { env } from '../config/env';
import type { DB } from '../db/schema';

types.setTypeParser(types.builtins.INT8, (v) => Number(v));

async function main(): Promise<void> {
  const [loginId, password] = process.argv.slice(2);

  if (!loginId || !password) {
    console.error('使い方: npm run user:password -- <ログインID> <パスワード>');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('パスワードは10文字以上にしてください。');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
    options: `-c search_path=${env.DB_SCHEMA},public`,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await db
      .updateTable('users')
      .set({ password_hash: hash, updated_at: new Date() })
      .where('login_id', '=', loginId)
      .executeTakeFirst();

    if (Number(result.numUpdatedRows) === 0) {
      console.error(`ログインID「${loginId}」の利用者が見つかりません。`);
      process.exitCode = 1;
      return;
    }
    console.log(`「${loginId}」のパスワードを設定しました。`);
  } finally {
    await db.destroy();
  }
}

void main();

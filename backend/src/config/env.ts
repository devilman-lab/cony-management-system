import 'dotenv/config';
import { z } from 'zod';

/**
 * 環境変数はここで一度だけ読み、型を付けて配る。
 * 稼働先を決めていないため、環境に依存する値はすべてここに集約する。
 * 起動時に検証し、足りなければ立ち上がらずに落とす（動いてから気づくのを防ぐ）。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  /** 例: postgres://postgres:pass@localhost:5432/cony_dev */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL を設定してください'),
  /** 全テーブルは cony スキーマに置く。public は使わない。 */
  DB_SCHEMA: z.string().min(1).default('cony'),
  DB_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  /** クラウドのマネージドDBを使う場合に true。VM上の同居構成では false。 */
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** 取込CSVの上限（MB）。base64 で送るため実ファイルの約1.4倍を見込む。 */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(20),

  /** 添付ファイルの実体を置く場所。DB にはメタデータだけを持つ。 */
  ATTACHMENT_DIR: z.string().default('./storage/attachments'),

  /**
   * 帳票PDFに埋め込む日本語フォントのファイル（.ttf / .otf / .ttc）。
   * フォントは配布条件があるため同梱しない。未設定のときは稼働先にあるものを探す。
   */
  PDF_FONT_PATH: z.string().optional(),
  /** .ttc のように複数書体を含むファイルで、使う書体の名前。 */
  PDF_FONT_FAMILY: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET は32文字以上にしてください'),
  /** ログインの有効時間（秒）。既定は8時間＝1営業日。 */
  JWT_EXPIRES_SECONDS: z.coerce.number().int().positive().default(28_800),

  /** フロント（Next.js）のオリジン。カンマ区切りで複数可。 */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  // Nest のロガーはまだ起動していないため、素の出力で落とす
  console.error('環境変数の設定に誤りがあります。\n' + lines.join('\n'));
  console.error('backend/.env.example を .env にコピーして設定してください。');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

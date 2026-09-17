import { existsSync } from 'node:fs';

import { env } from '../config/env';

export interface JapaneseFont {
  path: string;
  /** .ttc など複数書体を含むファイルのときだけ必要。 */
  family?: string;
}

/**
 * 日本語フォントの在り処。
 *
 * **フォントはリポジトリに同梱しない。**書体には再配布の条件があり、
 * 稼働先（Windows／Linux）によって入っているものも違うためである。
 * PDF_FONT_PATH で明示できるようにしたうえで、未設定なら下の候補を順に探す。
 */
const CANDIDATES: JapaneseFont[] = [
  // Windows
  { path: 'C:\\Windows\\Fonts\\meiryo.ttc', family: 'Meiryo' },
  { path: 'C:\\Windows\\Fonts\\YuGothM.ttc', family: 'Yu Gothic Medium' },
  { path: 'C:\\Windows\\Fonts\\msgothic.ttc', family: 'MS Gothic' },
  // Linux（Noto CJK / IPAex）
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK JP' },
  // Alpine（Docker イメージ。apk add font-noto-cjk）
  { path: '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK JP' },
  { path: '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf' },
  { path: '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf' },
  { path: '/usr/share/fonts/truetype/ipafont-gothic/ipagp.ttf' },
  // macOS
  { path: '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc', family: 'Hiragino Sans W3' },
];

let resolved: JapaneseFont | null | undefined;

export function findJapaneseFont(): JapaneseFont | null {
  if (resolved !== undefined) return resolved;

  if (env.PDF_FONT_PATH) {
    resolved = existsSync(env.PDF_FONT_PATH)
      ? { path: env.PDF_FONT_PATH, family: env.PDF_FONT_FAMILY }
      : null;
    return resolved;
  }

  resolved = CANDIDATES.find((c) => existsSync(c.path)) ?? null;
  return resolved;
}

export const FONT_MISSING_MESSAGE =
  '帳票に使う日本語フォントが見つかりません。' +
  'サーバーの .env に PDF_FONT_PATH（.ttf / .otf / .ttc のファイルパス）を設定してください。' +
  'フォントは配布条件があるためシステムには同梱していません。';

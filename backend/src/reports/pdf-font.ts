import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import fontkit from 'fontkit';

import { env } from '../config/env';

export interface JapaneseFont {
  path: string;
  /**
   * .ttc / .otc のように複数書体を含むファイルのときに、どれを使うかの名前。
   *
   * **pdfkit は postscriptName で照合する。**familyName ではない。
   * 例）meiryo.ttc は "Meiryo"（postscript）は通るが "Meiryo UI"（family）は
   * 「Not a supported font format or standard PDF font.」で落ちる。
   * Noto Sans CJK も family は "Noto Sans CJK JP" だが postscript は
   * "NotoSansCJKjp-Regular" なので、family を渡すと落ちる。
   * 名前は決め打ちにせず、下の inspect() が fontkit で実物から読み取る。
   */
  family?: string;
}

/**
 * 日本語フォントの在り処。
 *
 * **フォントはリポジトリに同梱しない。**書体には再配布の条件があり、
 * 稼働先（Windows／Linux／Docker）によって入っているものも違うためである。
 *
 * 探し方は3段構え。先に見つかったものを使う。
 *   1. PDF_FONT_PATH の指定（明示が最優先）
 *   2. よくある置き場所の決め打ち（速い）
 *   3. フォント置き場を実際に走査（ディストリが変わっても拾えるように）
 * どの段でも「日本語の字形を本当に持っているか」を fontkit で確かめてから採用する。
 */

/** よくある置き場所。書体名は書かない（実物から読み取るため）。 */
const CANDIDATE_PATHS = [
  // Windows
  'C:\\Windows\\Fonts\\meiryo.ttc',
  'C:\\Windows\\Fonts\\YuGothM.ttc',
  'C:\\Windows\\Fonts\\YuGothR.ttc',
  'C:\\Windows\\Fonts\\msgothic.ttc',
  // Debian／Ubuntu
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
  '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
  '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
  '/usr/share/fonts/truetype/ipafont-gothic/ipagp.ttf',
  // Alpine（Docker イメージ。apk add font-noto-cjk）
  '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto/NotoSansJP-Regular.ttf',
  // macOS
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
];

/** 3段目で走査する置き場所。 */
const FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/usr/share/fonts/truetype',
  'C:\\Windows\\Fonts',
  '/System/Library/Fonts',
  '/Library/Fonts',
];

/** 走査で拾う拡張子。 */
const FONT_EXT = /\.(ttc|otc|ttf|otf)$/i;

/** 日本語書体らしい名前。総当たりを避けるための足切り。 */
const LIKELY_JP = /(noto.*cjk|noto.*jp|cjk|gothic|mincho|ipa|meiryo|yugoth|hiragino|sourcehan|源ノ|ヒラギノ)/i;

/** 走査で開くファイル数の上限（起動を遅くしないため）。 */
const MAX_SCAN = 40;

/** 日本語の字形を本当に持っているか。ひらがな・漢字の両方で見る。 */
function hasJapanese(font: unknown): boolean {
  const f = font as { hasGlyphForCodePoint?: (cp: number) => boolean };
  if (typeof f.hasGlyphForCodePoint !== 'function') return false;
  try {
    // あ(U+3042) と 漢(U+6F22)。かなだけ／漢字だけの書体を弾く。
    return f.hasGlyphForCodePoint(0x3042) && f.hasGlyphForCodePoint(0x6f22);
  } catch {
    return false;
  }
}

/**
 * フォントファイルを実際に開いて、使える書体を1つ選ぶ。
 * .ttc のときは中を全部見て、日本語が出せるものの postscriptName を返す。
 */
function inspect(path: string): JapaneseFont | null {
  try {
    const opened = fontkit.openSync(path) as unknown as {
      fonts?: unknown[];
      postscriptName?: string;
    };

    if (Array.isArray(opened.fonts)) {
      for (const sub of opened.fonts) {
        if (!hasJapanese(sub)) continue;
        const name = (sub as { postscriptName?: string }).postscriptName;
        if (name) return { path, family: name };
      }
      return null;
    }

    // 単体のファイルは書体名を渡さなくてよい（渡すとかえって落ちる）。
    return hasJapanese(opened) ? { path } : null;
  } catch {
    return null;
  }
}

/** フォント置き場を浅く走査して、日本語書体らしいファイルを集める。 */
function scan(): string[] {
  const found: string[] = [];
  for (const dir of FONT_DIRS) {
    if (found.length >= MAX_SCAN) break;
    if (!existsSync(dir)) continue;
    walk(dir, 0, found);
  }
  return found;
}

function walk(dir: string, depth: number, found: string[]): void {
  if (depth > 3 || found.length >= MAX_SCAN) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (found.length >= MAX_SCAN) return;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, depth + 1, found);
    else if (FONT_EXT.test(name) && LIKELY_JP.test(name)) found.push(full);
  }
}

let resolved: JapaneseFont | null | undefined;
/** 見つからなかったときに、どこを探したかを案内に混ぜるため。 */
let looked: string[] = [];

export function findJapaneseFont(): JapaneseFont | null {
  if (resolved !== undefined) return resolved;

  // 1) 明示の指定。書体名まで指定されていればそのまま信じる。
  if (env.PDF_FONT_PATH) {
    looked = [env.PDF_FONT_PATH];
    if (!existsSync(env.PDF_FONT_PATH)) {
      resolved = null;
      return resolved;
    }
    resolved = env.PDF_FONT_FAMILY
      ? { path: env.PDF_FONT_PATH, family: env.PDF_FONT_FAMILY }
      : (inspect(env.PDF_FONT_PATH) ?? { path: env.PDF_FONT_PATH });
    return resolved;
  }

  // 2) よくある置き場所
  looked = [];
  for (const path of CANDIDATE_PATHS) {
    if (!existsSync(path)) continue;
    looked.push(path);
    const hit = inspect(path);
    if (hit) {
      resolved = hit;
      return resolved;
    }
  }

  // 3) 走査
  for (const path of scan()) {
    if (looked.includes(path)) continue;
    looked.push(path);
    const hit = inspect(path);
    if (hit) {
      resolved = hit;
      return resolved;
    }
  }

  resolved = null;
  return resolved;
}

/** 試したものを検証や問い合わせのときに見られるように。 */
export function fontSearchTrace(): string[] {
  return looked;
}

/** 検証用。探し直させる。 */
export function resetJapaneseFont(): void {
  resolved = undefined;
  looked = [];
}

export const FONT_MISSING_MESSAGE =
  '帳票に使う日本語フォントが見つかりません。' +
  'サーバーの .env に PDF_FONT_PATH（.ttf / .otf / .ttc のファイルパス）を設定してください。' +
  'フォントは配布条件があるためシステムには同梱していません。';

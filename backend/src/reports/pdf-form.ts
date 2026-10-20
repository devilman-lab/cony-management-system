/**
 * 貴社の様式（Excel の帳票）を A4 横に描くための部品（2026-10-13 受注処理編 O-26〜O-30）。
 *
 * 出荷依頼書・ピッキングリスト・納品書は、罫線の枠に決まった行数の表を置く様式なので、
 * 「表が続けば次のページへ」の ReportDoc（請求書が使う）ではなく、座標を決めて
 * 枠・網掛け・二重線・文字を置いていく。座標は頂いた様式の画像から測った値（pt）。
 *
 * 文字は欄の中に収める。入りきらなければ少し縮め、それでも入らなければ折り返す
 * （品名の末尾の (W)・キャップ付・カラー・サイズが読めなくなるので「…」では切らない）。
 * 日本語の書体に太字が無いことがある（本番は Noto Sans CJK の標準だけ）ため、
 * 太字は文字の輪郭を細くなぞって太く見せる（faux bold）。
 */

/** A4 横の大きさ（pt）。 */
export const PAGE_WIDTH = 841.89;
export const PAGE_HEIGHT = 595.28;

/** 罫線の太さ。Excel の細線・太線に合わせる。 */
export const THIN = 0.5;
export const THICK = 1.4;

/** 見出しの網掛け。納品書は Excel の「白, 背景1, 黒+基本色 25%」、出荷依頼書・ピッキングリストは薄い灰色。 */
export const GRAY = '#C0C0C0';
export const LIGHT_GRAY = '#EDEDED';

const INK = '#000000';
/** 行の高さ（文字の大きさに対する割合）。書体の行間（メイリオは 1.5 倍）ではなく、欄に詰めて置く。 */
const LINE_RATIO = 1.18;
/** 和文の字面の上端（ベースラインから上へ、文字の大きさに対する割合）。縦の中央に置くのに使う。 */
const ASCENT_RATIO = 0.88;
/** 行頭に来てはいけない文字（半角の濁点・句読点・閉じ括弧・長音）。前の行に残す。 */
const NO_LINE_START = new Set(Array.from('ﾞﾟ、。，．,.)）」』】〕〉》ーｰ・：:；;！!？?%％'));

export interface TextStyle {
  /** 文字の大きさ（pt）。 */
  size: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  bold?: boolean;
  /** 左右の余白（既定 2pt）。 */
  padX?: number;
  /** 上下の余白（既定 1pt）。 */
  padY?: number;
  /** 入りきらないときに縮めてよい下限（既定は元の 60%、5pt 未満にはしない）。 */
  minSize?: number;
  /** 折り返してよい行数（既定 2）。1 なら折り返さずに縮めるだけ。 */
  maxLines?: number;
  /** 折り返す前に1行のまま縮めてよい大きさ（既定は元の 80%）。宛名のように1行で読ませたい欄で小さくする。 */
  oneLineMin?: number;
  /** 字間（「納 品 書」のように字を離すとき）。 */
  spacing?: number;
  color?: string;
}

export interface BoxStyle {
  /** 網掛けの色。 */
  fill?: string;
  /** 枠の太さ。0 なら枠なし（網掛けだけ）。 */
  line?: number;
}

/**
 * 1ページに枠と文字を置く道具。座標はすべて pt（左上が原点、下に向かって y が増える）。
 */
export class FormPainter {
  /** 1pt の大きさでの1文字の幅。文字ごとに測って使い回す（長い品名の折り返しを速くするため）。 */
  private readonly widths = new Map<string, number>();

  constructor(private readonly doc: PDFKit.PDFDocument) {}

  /** 長方形。網掛けと枠を一度に描く。 */
  box(x: number, y: number, w: number, h: number, style: BoxStyle = {}): void {
    const line = style.line ?? THIN;
    if (style.fill) this.doc.save().rect(x, y, w, h).fill(style.fill).restore();
    if (line > 0) this.doc.save().lineWidth(line).strokeColor(INK).rect(x, y, w, h).stroke().restore();
  }

  /** 横線。 */
  hline(x1: number, x2: number, y: number, width = THIN): void {
    this.doc.save().lineWidth(width).strokeColor(INK).moveTo(x1, y).lineTo(x2, y).stroke().restore();
  }

  /** 縦線。 */
  vline(x: number, y1: number, y2: number, width = THIN): void {
    this.doc.save().lineWidth(width).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke().restore();
  }

  /** 二重線（横）。y が上の線、gap だけ下にもう1本。 */
  doubleH(x1: number, x2: number, y: number, gap = 2.2, width = 0.6): void {
    this.hline(x1, x2, y, width);
    this.hline(x1, x2, y + gap, width);
  }

  /** 二重線（縦）。x が左の線。 */
  doubleV(x: number, y1: number, y2: number, gap = 2, width = THIN): void {
    this.vline(x, y1, y2, width);
    this.vline(x + gap, y1, y2, width);
  }

  /**
   * 文字を欄（x, y, w, h）の中に置く。入りきらなければ縮め、それでも入らなければ折り返す。
   * 改行（\n）はそのまま改行として扱う。
   */
  text(value: string | null | undefined, x: number, y: number, w: number, h: number, style: TextStyle): void {
    const text = (value ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (text === '') return;
    const padX = style.padX ?? 2;
    const padY = style.padY ?? 1;
    const spacing = style.spacing ?? 0;
    const innerW = Math.max(1, w - padX * 2);
    const innerH = Math.max(1, h - padY * 2);
    const { size, lines } = this.fit(text, innerW, innerH, style);
    const lineH = size * LINE_RATIO;
    const blockH = lines.length * lineH;
    const valign = style.valign ?? 'middle';
    const top =
      valign === 'top' ? y + padY : valign === 'bottom' ? y + h - padY - blockH : y + (h - blockH) / 2;

    lines.forEach((line, i) => {
      const lineW = this.measure(line, size, spacing);
      const align = style.align ?? 'left';
      const lx = align === 'right' ? x + w - padX - lineW : align === 'center' ? x + (w - lineW) / 2 : x + padX;
      // 字面（ベースラインから上 0.88、下 0.12）を行の高さの中央に置く
      const baseline = top + i * lineH + (lineH - size) / 2 + size * ASCENT_RATIO;
      this.draw(line, lx, baseline, size, style);
    });
  }

  /** 位置を決めて1行だけ置く（見出しの横の「（返品）」・ページ番号など）。x は左端、y はベースライン。 */
  label(value: string, x: number, baseline: number, style: TextStyle): number {
    if (!value) return 0;
    this.draw(value, x, baseline, style.size, style);
    return this.measure(value, style.size, style.spacing ?? 0);
  }

  /** 文字の幅（pt）。 */
  measure(text: string, size: number, spacing = 0): number {
    let w = 0;
    let n = 0;
    for (const ch of Array.from(text)) {
      w += this.unitWidth(ch) * size;
      n += 1;
    }
    return w + spacing * Math.max(0, n - 1);
  }

  // --------------------------------------------------------------------------

  private draw(line: string, x: number, baseline: number, size: number, style: TextStyle): void {
    const color = style.color ?? INK;
    const options: PDFKit.Mixins.TextOptions = { lineBreak: false, baseline: 'alphabetic' };
    if (style.spacing) options.characterSpacing = style.spacing;
    this.doc.save();
    this.doc.fontSize(size).fillColor(color);
    if (style.bold) {
      // 輪郭を細くなぞって太く見せる。線の端は丸めて、字の角が尖らないように
      this.doc.lineWidth(Math.max(0.15, size * 0.045)).strokeColor(color).lineJoin('round');
      options.fill = true;
      options.stroke = true;
    }
    this.doc.text(line, x, baseline, options);
    this.doc.restore();
  }

  /**
   * 大きさと折り返しを決める。
   * 1) 1行のまま、元の大きさの 80% まで縮める
   * 2) 折り返して（maxLines 行まで）、下限まで縮める
   * 3) それでも入らなければ下限の大きさで入るだけの行にし、最後の行の末尾を「…」にする
   */
  private fit(text: string, w: number, h: number, style: TextStyle): { size: number; lines: string[] } {
    const base = style.size;
    const min = Math.min(base, style.minSize ?? Math.max(5, base * 0.6));
    const maxLines = Math.max(1, style.maxLines ?? 2);
    const spacing = style.spacing ?? 0;
    const paragraphs = text.split('\n').length;
    // 行の幅も確かめる。行頭に来られない文字（ー・ッ など）は前の行に付けて折り返すので、幅を越えた行ができることがある。
    // 高さだけを見ていたため、カラー「アッシュグレー」が枠をはみ出して隣のサイズの欄に重なっていた（2026-10-20 受入テスト T4）
    const fits = (lines: string[], size: number) =>
      lines.length * size * LINE_RATIO <= h + 0.01 && lines.every((l) => this.measure(l, size, spacing) <= w + 0.01);

    const shrinkFloor = Math.max(min, style.oneLineMin ?? base * 0.8);
    for (let size = base; size >= shrinkFloor - 1e-6; size -= 0.25) {
      const lines = this.wrap(text, w, size, spacing);
      if (lines.length <= paragraphs && fits(lines, size)) return { size, lines };
    }
    for (let size = base; size >= min - 1e-6; size -= 0.25) {
      const lines = this.wrap(text, w, size, spacing);
      if (lines.length <= Math.max(maxLines, paragraphs) && fits(lines, size)) return { size, lines };
    }
    const lines = this.wrap(text, w, min, spacing);
    const room = Math.max(1, Math.floor((h + 0.01) / (min * LINE_RATIO)));
    if (lines.length <= room) return { size: min, lines };
    const kept = lines.slice(0, room);
    let last = kept[room - 1];
    while (last.length > 0 && this.measure(`${last}…`, min, spacing) > w) last = Array.from(last).slice(0, -1).join('');
    kept[room - 1] = `${last}…`;
    return { size: min, lines: kept };
  }

  /** 幅 w に収まるように折り返す。和文は1文字ずつ、英数字の語は語の切れ目で折り返す。 */
  private wrap(text: string, w: number, size: number, spacing: number): string[] {
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      let lineW = 0;
      for (const ch of Array.from(paragraph)) {
        const chW = this.unitWidth(ch) * size;
        if (line !== '' && lineW + spacing + chW > w) {
          if (NO_LINE_START.has(ch)) {
            line += ch;
            lineW += spacing + chW;
            continue;
          }
          // 英数字の語の途中なら、その行の最後の空白で切って語ごと次の行へ送る
          const word = /^(.*\s)([!-~]+)$/.exec(line);
          if (word && /[!-~]/.test(ch) && word[1].trim() !== '') {
            out.push(word[1].trimEnd());
            line = word[2];
            lineW = this.measure(line, size, spacing);
          } else {
            out.push(line.trimEnd());
            line = '';
            lineW = 0;
          }
          if (line === '' && /\s/.test(ch)) continue; // 行頭の空白は捨てる
        }
        lineW += line === '' ? chW : spacing + chW;
        line += ch;
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  private unitWidth(ch: string): number {
    let w = this.widths.get(ch);
    if (w === undefined) {
      this.doc.fontSize(100);
      w = this.doc.widthOfString(ch) / 100;
      this.widths.set(ch, w);
    }
    return w;
  }
}

// ----------------------------------------------------------------------------
// 帳票に印字する日付・時刻（日本時間）
// ----------------------------------------------------------------------------

/** 日本時間の年月日時分秒。サーバーの時刻帯に左右されないように、UTC に 9 時間足して読む。 */
function jstParts(at: Date): { y: number; m: number; d: number; hh: number; mi: number; ss: number } {
  const t = new Date(at.getTime() + 9 * 3600 * 1000);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    hh: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    ss: t.getUTCSeconds(),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 「2026/8/25」（様式の依頼日・作成年月日の書き方）。 */
export function shortDate(at: Date = new Date()): string {
  const p = jstParts(at);
  return `${p.y}/${p.m}/${p.d}`;
}

/** 「2026-08-25 10:43:38」（ピッキングリストの依頼日時の書き方）。 */
export function dateTime(at: Date = new Date()): string {
  const p = jstParts(at);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
}

/** 「2026/08/28」（出庫日・納期・納品日の書き方）。DATE は文字列で来るので時差でずらさない。 */
export function slashDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) {
    const p = jstParts(value);
    return `${p.y}/${pad2(p.m)}/${pad2(p.d)}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[1]}/${m[2]}/${m[3]}` : String(value);
}

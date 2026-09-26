/**
 * fontkit の型定義。本体が型を同梱していないため、**使う分だけ**ここに書く。
 *
 * 帳票の書体選びで、.ttc（複数書体を1ファイルにまとめたもの）の中から
 * 「日本語の字形を持つもの」を探し、その postscriptName を取り出すために使う。
 * pdfkit の registerFont は familyName ではなく postscriptName で照合するので、
 * 名前を決め打ちにせず実物から読む必要がある（詳しくは pdf-font.ts）。
 */
declare module 'fontkit' {
  export interface FontkitFont {
    /** pdfkit の registerFont に渡す名前はこれ。 */
    postscriptName?: string;
    familyName?: string;
    /** その符号位置の字形を持っているか。日本語が出せるかの判定に使う。 */
    hasGlyphForCodePoint?(codePoint: number): boolean;
  }

  /** .ttc / .otc のように複数の書体を含むファイル。 */
  export interface FontkitCollection {
    fonts: FontkitFont[];
  }

  export function openSync(path: string, postscriptName?: string): FontkitFont | FontkitCollection;

  const fontkit: {
    openSync: typeof openSync;
  };
  export default fontkit;
}

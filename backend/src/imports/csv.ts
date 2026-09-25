import { BadRequestException } from '@nestjs/common';

/**
 * CSV を行と列に分ける（RFC 4180）。
 * 引用符の中の改行・カンマ・二重引用符をそのまま扱う。
 * 販社のCSVは備考欄に改行が入ることがあるため、行を単純に分割してはいけない。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // 先頭の BOM は落とす
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // CRLF の CR は読み飛ばす
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 全列が空の行は落とす（末尾の空行対策）
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** 文字コードを指定して復号する。販社3社は Shift-JIS（CP932）。 */
export function decode(bytes: Buffer, encoding: string): string {
  const label = encoding.toUpperCase();
  if (label === 'UTF8' || label === 'UTF-8') return bytes.toString('utf8');

  try {
    // Node の公式ビルドは full ICU なので shift_jis を扱える
    return new TextDecoder('shift_jis', { fatal: false }).decode(bytes);
  } catch {
    throw new BadRequestException(
      `文字コード ${encoding} を読めませんでした。UTF-8 に変換してからお試しください`,
    );
  }
}

/** 画面やエラー文に出す文字コードの呼び名。英語のラベルをそのまま出さない。 */
export type DetectedEncoding = 'UTF-8' | 'Shift-JIS(CP932)';

/**
 * 文字コードを自動で見分けて復号する。
 *
 * 通販（OMS）のCSVは、助ネコからの出力そのままなら Shift-JIS だが、
 * Excel や他のツールを通すと UTF-8 で保存されて届くことがある。
 * 決め打ちにすると「見出しが無い」という見当違いのエラーになり、
 * 担当者が本当の原因（文字コード）に辿り着けない。
 *
 * 見分け方: BOM があれば UTF-8 で確定。無ければ UTF-8 として厳密に読んでみて、
 * 成り立たない並びがあれば Shift-JIS(CP932) として読み直す。
 * （Shift-JIS の日本語は UTF-8 としてはまず成り立たないため、この順で判別できる）
 */
export function decodeAuto(bytes: Buffer): { text: string; encoding: DetectedEncoding } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.toString('utf8'), encoding: 'UTF-8' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    return { text: decode(bytes, 'CP932'), encoding: 'Shift-JIS(CP932)' };
  }
}

/** 取込テンプレート等で指定された文字コードを、画面に出す呼び名に直す。 */
export function encodingLabel(encoding: string): DetectedEncoding {
  const label = encoding.toUpperCase();
  return label === 'UTF8' || label === 'UTF-8' ? 'UTF-8' : 'Shift-JIS(CP932)';
}

/** 全角数字を半角にし、桁区切りと空白を落とす。 */
function normalizeDigits(value: string): string {
  return value
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,\s　]/g, '');
}

const pad = (n: string): string => (n.length === 1 ? `0${n}` : n);

/**
 * 取込テンプレートの transform を適用する。
 * 販社ごとの書式の違いは、ここと import_template_columns だけで吸収する。
 */
export function applyTransform(raw: string, transform: string | null, field: string): string | null {
  const value = raw ?? '';

  switch (transform) {
    case null:
    case undefined:
      return value.trim() === '' ? null : value;

    case 'trim':
      return value.trim() === '' ? null : value.trim();

    case 'number': {
      const n = normalizeDigits(value);
      if (n === '' || n === '-') return null;
      if (!/^-?\d+(\.\d+)?$/.test(n)) {
        throw new Error(`${field}「${value}」を数値として読めません`);
      }
      return n;
    }

    case 'date_slash': {
      // 2026/9/8 や 2026/09/08
      const v = normalizeDigits(value).replace(/[.\-]/g, '/');
      if (v === '') return null;
      const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
      if (!m) throw new Error(`${field}「${value}」を日付として読めません`);
      return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    }

    case 'date_ymd': {
      // 20260908
      const v = normalizeDigits(value);
      if (v === '') return null;
      if (!/^\d{8}$/.test(v)) throw new Error(`${field}「${value}」を日付として読めません`);
      return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }

    case 'date_yymmdd': {
      // 260909（ビックカメラの納品予定日）
      const v = normalizeDigits(value);
      if (v === '') return null;
      if (!/^\d{6}$/.test(v)) throw new Error(`${field}「${value}」を日付として読めません`);
      return `20${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
    }

    case 'jan13': {
      const v = normalizeDigits(value).trim();
      if (v === '') return null;
      // Excel で開いて保存すると 4.57349E+12 や 4,573,490,000,000.00 に変わり、
      // 下位の桁が失われて元に戻せない。取り込まずにここで止める。
      if (/[eE]\+?\d/.test(value) || /\.\d/.test(v)) {
        throw new Error(
          `${field}「${value}」は指数表記に変わっています。Excelで開かずに保存したファイルをお使いください`,
        );
      }
      if (!/^\d{8}$|^\d{13}$/.test(v)) {
        throw new Error(`${field}「${value}」は13桁（または8桁）のJANコードではありません`);
      }
      return v;
    }

    default:
      throw new Error(`未知の変換方法「${transform}」が取込テンプレートに設定されています`);
  }
}

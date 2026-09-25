import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodType, ZodTypeDef } from 'zod';

/**
 * 項目名の日本語。画面のエラー表示にそのまま出るので、利用者の言葉にしておく。
 * ここに無い項目は英語のまま出る（見つけたら足す）。
 */
const FIELD_LABELS: Record<string, string> = {
  sku_id: '商品',
  partner_id: '取引先',
  supplier_partner_id: '仕入先',
  payee_partner_id: '支払先',
  customer_partner_id: '販売先',
  delivery_destination_id: '納品先',
  warehouse_id: '倉庫',
  from_warehouse_id: '移動元の倉庫',
  to_warehouse_id: '移動先の倉庫',
  sales_category_id: '販売カテゴリー',
  sales_staff_id: '販売担当',
  qty: '数量',
  unit_price: '単価',
  unit_cost: '単価',
  cost_price: '原価',
  retail_price: '上代',
  amount: '金額',
  applied_amount: '消込額',
  fee_amount: '手数料',
  adjustment_amount: '調整額',
  // 一覧のしぼり込み。画面からは正しい値しか送らないが、URLを直接いじったときに英語のキー名が出ないように。
  exclude_cancelled: '取消を除く',
  include_cancelled: '取消を含む',
  status: '状態',
  from: '開始日',
  to: '終了日',
  limit: '取得件数',
  offset: '開始位置',
  order_type: '受注区分',
  order_date: '受注日',
  ship_date: '出荷日',
  delivery_date: '納品日',
  planned_date: '入荷予定日',
  received_date: '入荷日',
  payment_date: '支払日',
  receipt_date: '入金日',
  closing_date: '締め日',
  target_month: '対象月',
  period_from: '期間（開始）',
  period_to: '期間（終了）',
  valid_from: '適用開始',
  valid_to: '適用終了',
  reserved_qty: '確保数',
  lines: '明細',
  line_no: '行番号',
  line_type: '種別',
  item_name: '品名',
  tax_rate: '税率',
  code: 'コード',
  name: '名称',
  name1: '名称1',
  login_id: 'ログインID',
  password: 'パスワード',
  role_ids: '役割',
  partner_code: '取引先コード',
  delivery_code: '納品先コード',
  product_code: '品番',
  product_name: '商品名',
  sku_code: 'SKUコード',
  jan: 'JANコード',
  warehouse_code: '倉庫コード',
  short_name: '略称',
  purchase_code: '仕入コード',
  file_name: 'ファイル名',
  content_base64: 'ファイルの中身',
  template_code: '取込テンプレート',
  reason_code_id: '理由',
  note: '備考',
};

/** zod が英語で出す既定のメッセージを日本語にする。スキーマに日本語を書いてあればそちらが優先。 */
function translateMessage(issue: ZodIssue): string {
  const m = issue.message;
  if (m === 'Required') return '入力してください';
  if (/^Expected number, received string$/.test(m)) return '数値で入力してください';
  if (/^Expected string, received/.test(m)) return '文字で入力してください';
  if (/^Expected boolean, received/.test(m)) return 'はい／いいえで指定してください';
  if (/^Expected array, received/.test(m)) return '一覧の形で送ってください';
  if (/^Expected object, received/.test(m)) return '入力の形が違います';
  if (/^Invalid enum value/.test(m)) {
    const opts = m
      .match(/Expected (.+), received/)?.[1]
      ?.replace(/'([^']*)'/g, '「$1」')
      .replace(/ \| /g, '／');
    return opts ? `次のいずれかを選んでください：${opts}` : '選択肢にない値です';
  }
  if (/^Invalid$/.test(m)) return '形式が正しくありません';
  if (/^Invalid date$/.test(m)) return '日付の形式が正しくありません';
  if (/^Invalid email$/.test(m)) return 'メールアドレスの形式が正しくありません';
  const tooSmall = m.match(/^(?:String|Array) must contain at least (\d+) (?:character|element)\(s\)$/);
  if (tooSmall) return `${tooSmall[1]} 文字以上で入力してください`;
  const tooBig = m.match(/^(?:String|Array) must contain at most (\d+) (?:character|element)\(s\)$/);
  if (tooBig) return `${tooBig[1]} 文字以内で入力してください`;
  const ge = m.match(/^Number must be greater than or equal to (\S+)$/);
  if (ge) return `${ge[1]} 以上で入力してください`;
  const gt = m.match(/^Number must be greater than (\S+)$/);
  if (gt) return `${gt[1]} より大きい値で入力してください`;
  const le = m.match(/^Number must be less than or equal to (\S+)$/);
  if (le) return `${le[1]} 以下で入力してください`;
  if (/^Expected integer/.test(m)) return '整数で入力してください';
  if (/^Unrecognized key/.test(m)) return '不明な項目があります';
  return m;
}

/** lines.0.sku_id → 「明細1行目 商品」 のように読める形にする。 */
function describePath(path: (string | number)[]): string {
  if (path.length === 0) return '(全体)';
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (typeof p === 'number') {
      const prev = parts.pop();
      parts.push(`${prev ?? ''}${p + 1}行目`);
    } else {
      parts.push(FIELD_LABELS[p] ?? p);
    }
  }
  return parts.join(' ');
}

/**
 * 受け取った値を zod で検証して、型の付いた値に変換する。
 * 検証を通らなかった項目は、どの項目がなぜ駄目なのかを日本語で返す。
 *
 * 入口の型（TIn）と出口の型（TOut）を分けているのは、既定値や型変換を
 * 使うスキーマでは両者が一致しないため（例: limit は文字列で来て数値になる）。
 */
@Injectable()
export class ZodValidationPipe<TOut, TIn = unknown> implements PipeTransform<unknown, TOut> {
  constructor(private readonly schema: ZodType<TOut, ZodTypeDef, TIn>) {}

  transform(value: unknown): TOut {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      message: '入力内容に誤りがあります',
      errors: result.error.issues.map((issue) => ({
        field: describePath(issue.path),
        path: issue.path.join('.'),
        reason: translateMessage(issue),
      })),
    });
  }
}

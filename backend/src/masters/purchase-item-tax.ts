import { BadRequestException } from '@nestjs/common';

import type { ConyDatabase } from '../db/database.module';

/**
 * 税区分から決まる税率。課税10%→10、軽減8%→8、非課税・不課税・免税→0。
 * 区分値の画面で足した区分（コードが決まっていないもの）は名前で見る。決められなければ undefined。
 * 仕入・経費の登録（purchasing.service の TAX_RATE_BY_DIVISION）と同じ対応。
 */
export function rateForTaxDivision(code: string, name: string): string | undefined {
  const byCode: Record<string, string> = { TAX10: '10.00', TAX8: '8.00', EXEMPT: '0.00', NON_TAX: '0.00' };
  if (byCode[code]) return byCode[code];
  if (/非課税|不課税|免税|対象外/.test(name)) return '0.00';
  if (/8\s*[%％]/.test(name) || name.includes('軽減')) return '8.00';
  if (/10\s*[%％]/.test(name)) return '10.00';
  return undefined;
}

/**
 * 仕入品目の税率と税区分の食い違いを断る（2026-10-12 T3 No.32 D10）。
 * 以前は「税率 10%・税区分 非課税」のような組み合わせがそのまま登録できた。
 *
 *   ・税区分を選んで税率を空で送ったときは、税区分から税率を決めて入れる
 *   ・税区分と違う税率を送ったときは 400
 *   ・更新で片方だけ送ったときは、もう片方は今の値と突き合わせる。税区分だけを直したときは税率をそれに合わせる
 *   ・どちらも送っていない更新（備考だけ直すなど）は見ない
 * 戻り値は、税率を補った登録・更新の中身。
 */
export async function assertPurchaseItemTax<T extends { new_tax_rate?: string | null; new_tax_class_code_id?: number | null }>(
  db: ConyDatabase,
  body: T,
  current?: { new_tax_rate: string | null; new_tax_class_code_id: number | null },
): Promise<T> {
  const sentRate = body.new_tax_rate !== undefined;
  const sentClass = body.new_tax_class_code_id !== undefined;
  if (!sentRate && !sentClass) return body;

  const classId = sentClass ? (body.new_tax_class_code_id ?? null) : (current?.new_tax_class_code_id ?? null);
  if (classId === null) return body;

  const division = await db
    .selectFrom('codes as c')
    .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
    .select(['c.code as code', 'c.name as name'])
    .where('c.id', '=', classId)
    .where('cc.code', '=', 'TAX_DIVISION')
    .executeTakeFirst();
  if (!division) throw new BadRequestException('税区分が見つかりません');

  const expected = rateForTaxDivision(division.code, division.name);
  if (expected === undefined) return body;

  const rate = sentRate ? (body.new_tax_rate ?? null) : null;
  if (rate !== null && Number(rate) !== Number(expected)) {
    throw new BadRequestException(
      `税区分「${division.name}」の税率は ${Number(expected)}% です（入力は ${Number(rate)}%）。税率を直すか、税区分を選び直してください`,
    );
  }
  return { ...body, new_tax_rate: expected };
}

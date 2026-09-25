import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * 支払の画面で使っている欄の名前。
 *
 * 共通の項目名（common/zod-validation.pipe.ts の FIELD_LABELS）では
 * amount を「金額」としている。そちらは入金・入出金とも共有しているので直さず、
 * 支払の入口でだけ読み替える。画面の欄は「支払額」なので、「金額：…」と出ると
 * どの欄を直せばよいのか分からなくなるため。
 */
export const PAYMENT_FIELD_LABELS: Record<string, string> = {
  partner_id: '仕入先',
  payment_date: '支払日',
  amount: '支払額',
  applied_amount: '消込額',
  purchase_id: '対象の仕入',
};

/** 入出金の画面で使っている欄の名前。英語の項目名がそのまま出ないようにする。 */
export const CASH_FIELD_LABELS: Record<string, string> = {
  division: '区分',
  target_month: '対象月',
  transaction_date: '日付',
  scheduled_date: '入金・出金の予定日',
  partner_id: '取引先',
  partner_contact: '先方の担当者',
  sales_staff_name: '販売担当',
  currency: '通貨',
  cash_amount: '現金',
  transfer_amount: '振込',
  card_amount: 'カード',
  bill_amount1: '手形①',
  bill_due_date1: '手形①の決済日',
  bill_amount2: '手形②',
  bill_due_date2: '手形②の決済日',
  offset_amount: '相殺',
  check_amount: '小切手',
  collection_amount: '集金',
  overseas_usd: '海外送金 (USD)',
  overseas_cny: '海外送金 (CNY)',
  fee_amount: '手数料',
  note: '備考',
};

interface FieldError {
  field: string;
  path: string;
  reason: string;
}

/**
 * 入力検証。中身は共通の検証（ZodValidationPipe）と同じで、
 * 返す誤りの「項目名」だけを、その画面での呼び方に差し替える。
 */
export class FieldLabelPipe<TOut, TIn = unknown> implements PipeTransform<unknown, TOut> {
  private readonly inner: ZodValidationPipe<TOut, TIn>;

  constructor(
    schema: ZodType<TOut, ZodTypeDef, TIn>,
    private readonly labels: Record<string, string>,
  ) {
    this.inner = new ZodValidationPipe(schema);
  }

  transform(value: unknown): TOut {
    try {
      return this.inner.transform(value);
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      const res = e.getResponse();
      if (typeof res !== 'object' || res === null) throw e;
      const body = res as { message?: unknown; errors?: unknown };
      if (!Array.isArray(body.errors)) throw e;

      const errors = (body.errors as FieldError[]).map((x) => ({
        ...x,
        field: this.labels[x.path] ?? x.field,
      }));
      throw new BadRequestException({ ...body, errors });
    }
  }
}

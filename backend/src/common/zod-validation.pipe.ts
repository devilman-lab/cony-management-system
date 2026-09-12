import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * 受け取った値を zod で検証して、型の付いた値に変換する。
 * 検証を通らなかった項目は、どの項目がなぜ駄目なのかを返す。
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
        field: issue.path.join('.') || '(全体)',
        reason: issue.message,
      })),
    });
  }
}

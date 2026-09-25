import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { NumberingService } from '../common/numbering.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { CASH_FIELD_LABELS, FieldLabelPipe, PAYMENT_FIELD_LABELS } from './field-label.pipe';
import { PurchasingService, assertCashAmounts } from './purchasing.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const ym = z.string().regex(/^\d{4}-\d{2}$/, '対象年月は YYYY-MM の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');
const positive = z.string().regex(/^\d+(\.\d+)?$/, '0 以上の数値で入力してください');
/** クエリ文字列の true／false。z.coerce.boolean() は "false" まで true と読むので使わない。 */
const boolQuery = z
  .enum(['true', 'false'], { errorMap: () => ({ message: 'true か false で指定してください' }) })
  .transform((v) => v === 'true');

const CreatePurchaseSchema = z.object({
  division: z.enum(['仕入', '経費']),
  supplier_partner_id: z.number().int().positive(),
  purchase_date: ymd,
  delivery_date: ymd.nullish(),
  payment_date1: ymd.nullish(),
  payment_date2: ymd.nullish(),
  currency: z.string().length(3).optional(),
  note: z.string().nullish(),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().min(1),
        purchase_item_id: z.number().int().positive().nullish(),
        item_name: z.string().trim().min(1).max(200),
        // 数量は 0・マイナスもいったん受け取り、受注・入荷と同じ文言で止める（purchasing.service.ts）。
        // ここで弾くと「明細1行目 数量：…」と別の言い方になり、画面ごとに文言が割れてしまう。
        qty: decimal.optional(),
        // 単価のマイナスは通す。値引・返金を1行で書く使い方があるため。
        unit_cost: decimal,
        target_product_id: z.number().int().positive().nullish(),
        target_brand_id: z.number().int().positive().nullish(),
        target_product_class_id: z.number().int().positive().nullish(),
        tax_rate: z.enum(['0.00', '8.00', '10.00']).optional(),
        note: z.string().nullish(),
      }),
    )
    .min(1, '明細を1行以上入力してください'),
});
type CreatePurchaseBody = z.infer<typeof CreatePurchaseSchema>;

const PurchaseListSchema = z.object({
  division: z.enum(['仕入', '経費']).optional(),
  supplier_partner_id: z.coerce.number().int().positive().optional(),
  /** 状態でしぼり込む。指定しなければ取消済みも含めて返す（仕入一覧の見え方は今までどおり）。 */
  status: z.enum(['登録', '確定', '取消']).optional(),
  /** 取消済みを外す。支払の消込先のように、選ばせてはいけない場面で使う。 */
  exclude_cancelled: boolQuery.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type PurchaseListQuery = z.infer<typeof PurchaseListSchema>;

/**
 * 支払額。マイナスのときに「数値で…」と「0 より大きい…」の2件が並ばないよう、
 * どちらか1件だけを返す。欄の名前は FieldLabelPipe が「支払額」に直す。
 */
const paymentAmount = z.string().superRefine((v, ctx) => {
  if (!/^-?\d+(\.\d+)?$/.test(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '金額を数字で入力してください' });
  } else if (Number(v) <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '0 より大きい金額で入力してください' });
  }
});

const PaymentSchema = z.object({
  partner_id: z.number().int().positive(),
  payment_date: ymd,
  amount: paymentAmount,
  purchase_id: z.number().int().positive().nullish(),
  applied_amount: positive.nullish(),
  note: z.string().nullish(),
});
type PaymentBody = z.infer<typeof PaymentSchema>;

/** 支払の訂正。渡された項目だけを直すので、すべて任意にしてある。 */
const PaymentUpdateSchema = z
  .object({
    payment_date: ymd.optional(),
    // 0 円の支払は登録の間違いなので、直すときも通さない
    amount: paymentAmount.optional(),
    // null を送ると消込を外す。項目ごと省略したときは今の消込先を残す。
    purchase_id: z.number().int().positive().nullish(),
    note: z.string().nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, '直す項目を1つ以上入力してください');
type PaymentUpdateBody = z.infer<typeof PaymentUpdateSchema>;

const PaymentListSchema = z.object({
  partner_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type PaymentListQuery = z.infer<typeof PaymentListSchema>;

const PeriodSchema = z.object({ from: ymd, to: ymd });
type PeriodQuery = z.infer<typeof PeriodSchema>;

const CashTransactionSchema = z.object({
  // 入出金の区分は 入金／出金（データベース側の ck_cash_div と同じ値）
  division: z.enum(['入金', '出金']),
  target_month: ym,
  transaction_date: ymd.nullish(),
  scheduled_date: ymd.nullish(),
  partner_id: z.number().int().positive().nullish(),
  partner_contact: z.string().trim().max(60).nullish(),
  sales_staff_name: z.string().trim().max(60).nullish(),
  currency: z.string().length(3).optional(),
  /** 手段ごとの内訳。合計は入力された内訳から求める。 */
  cash_amount: decimal.nullish(),
  transfer_amount: decimal.nullish(),
  /** カード（9/15 ご要望）。振込・現金と並ぶ入金手段。 */
  card_amount: decimal.nullish(),
  bill_amount1: decimal.nullish(),
  bill_due_date1: ymd.nullish(),
  bill_amount2: decimal.nullish(),
  bill_due_date2: ymd.nullish(),
  offset_amount: decimal.nullish(),
  check_amount: decimal.nullish(),
  collection_amount: decimal.nullish(),
  overseas_usd: decimal.nullish(),
  overseas_cny: decimal.nullish(),
  fee_amount: decimal.nullish(),
  note: z.string().nullish(),
});
type CashTransactionBody = z.infer<typeof CashTransactionSchema>;

/** 入出金の訂正。渡された項目だけを直すので、すべて任意にしてある。 */
const CashTransactionUpdateSchema = CashTransactionSchema.partial().refine(
  (b) => Object.keys(b).length > 0,
  '直す項目を1つ以上入力してください',
);
type CashTransactionUpdateBody = z.infer<typeof CashTransactionUpdateSchema>;

/** 機能ID P-01 仕入・経費登録／P-03 買掛残高一覧／C-01 入出金処理 */
@Controller()
export class PurchasingController {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly purchasing: PurchasingService,
    private readonly numbering: NumberingService,
  ) {}

  @Post('purchases')
  @RequirePermission('P-01', 'create')
  create(
    @Body(new ZodValidationPipe(CreatePurchaseSchema)) body: CreatePurchaseBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasing.create(body, user.id);
  }

  @Get('purchases')
  @RequirePermission('P-01', 'view')
  list(@Query(new ZodValidationPipe(PurchaseListSchema)) query: PurchaseListQuery) {
    return this.purchasing.list(query);
  }

  /** 商品別の経費集計。経費の明細に品番を持たせているので、ここで積み上げられる。 */
  @Get('purchases/expense-by-product')
  @RequirePermission('P-01', 'view')
  expenseByProduct(@Query(new ZodValidationPipe(PeriodSchema.partial())) query: Partial<PeriodQuery>) {
    return this.purchasing.expenseByProduct(query);
  }

  @Get('purchases/:id')
  @RequirePermission('P-01', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.purchasing.findOne(id);
  }

  @Post('payments')
  @RequirePermission('P-01', 'create')
  createPayment(
    @Body(new FieldLabelPipe(PaymentSchema, PAYMENT_FIELD_LABELS)) body: PaymentBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasing.createPayment(body, user.id);
  }

  /** 仕入・経費の取消。誤って登録したものを画面から直せるようにするため。 */
  @Post('purchases/:id/cancel')
  @HttpCode(200)
  @RequirePermission('P-01', 'delete')
  cancelPurchase(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.purchasing.cancel(id, user.id);
  }

  /** 支払の一覧。訂正・取消の前に、どの支払かを画面で選べるようにするため。 */
  @Get('payments')
  @RequirePermission('P-01', 'view')
  listPayments(@Query(new ZodValidationPipe(PaymentListSchema)) query: PaymentListQuery) {
    return this.purchasing.listPayments(query);
  }

  @Patch('payments/:id')
  @RequirePermission('P-01', 'update')
  updatePayment(
    @Param('id', ParseIntPipe) id: number,
    @Body(new FieldLabelPipe(PaymentUpdateSchema, PAYMENT_FIELD_LABELS)) body: PaymentUpdateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasing.updatePayment(id, body, user.id);
  }

  /** 支払の取消。消した分だけ買掛残高が戻る。 */
  @Delete('payments/:id')
  @RequirePermission('P-01', 'delete')
  removePayment(@Param('id', ParseIntPipe) id: number) {
    return this.purchasing.removePayment(id);
  }

  @Get('ap-balances')
  @RequirePermission('P-03', 'view')
  apBalances(@Query(new ZodValidationPipe(PeriodSchema)) query: PeriodQuery) {
    return this.purchasing.apBalances(query);
  }

  // ---- 入出金処理 ---------------------------------------------------------
  /**
   * 入出金は1件ずつの登録を基本とする。
   * 手形①②・相殺・小切手・集金・海外送金（USD／CNY）を1件の中に持てる。
   */
  @Post('cash-transactions')
  @RequirePermission('C-01', 'create')
  async createCashTransaction(
    @Body(new FieldLabelPipe(CashTransactionSchema, CASH_FIELD_LABELS)) body: CashTransactionBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 訂正（PATCH）と同じ検査を登録にも掛ける。片方だけだと、同じ画面なのに
    // 「登録では通るのに編集では直せない」0円・マイナスの行ができてしまう。
    assertCashAmounts(body);

    return this.db.transaction().execute(async (trx) => {
      const no = await this.numbering.next(trx, 'cash_transaction');
      const created = await trx
        .insertInto('cash_transactions')
        .values({
          cash_transaction_no: no,
          division: body.division,
          target_month: `${body.target_month}-01`,
          transaction_date: body.transaction_date ?? null,
          scheduled_date: body.scheduled_date ?? null,
          partner_id: body.partner_id ?? null,
          partner_contact: body.partner_contact ?? null,
          sales_staff_name: body.sales_staff_name ?? null,
          currency: body.currency ?? undefined,
          cash_amount: body.cash_amount ?? null,
          transfer_amount: body.transfer_amount ?? null,
          card_amount: body.card_amount ?? null,
          bill_amount1: body.bill_amount1 ?? null,
          bill_due_date1: body.bill_due_date1 ?? null,
          bill_amount2: body.bill_amount2 ?? null,
          bill_due_date2: body.bill_due_date2 ?? null,
          offset_amount: body.offset_amount ?? null,
          check_amount: body.check_amount ?? null,
          collection_amount: body.collection_amount ?? null,
          overseas_usd: body.overseas_usd ?? null,
          overseas_cny: body.overseas_cny ?? null,
          fee_amount: body.fee_amount ?? null,
          note: body.note ?? null,
          created_by: user.id,
          updated_by: user.id,
        })
        .returning(['id', 'cash_transaction_no'])
        .executeTakeFirstOrThrow();

      // 合計は入力された手段の合計。金額の足し算は SQL 側で行う。
      await trx
        .updateTable('cash_transactions')
        .set({
          amount: sql<string>`coalesce(cash_amount,0) + coalesce(transfer_amount,0) + coalesce(card_amount,0) + coalesce(bill_amount1,0)
                            + coalesce(bill_amount2,0) + coalesce(offset_amount,0) + coalesce(check_amount,0)
                            + coalesce(collection_amount,0) + coalesce(overseas_usd,0) + coalesce(overseas_cny,0)`,
        })
        .where('id', '=', created.id)
        .execute();

      return trx
        .selectFrom('cash_transactions')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
    });
  }

  @Get('cash-transactions')
  @RequirePermission('C-01', 'view')
  async listCashTransactions(
    @Query(new ZodValidationPipe(z.object({ target_month: ym.optional(), division: z.enum(['入金', '出金']).optional() })))
    query: { target_month?: string; division?: string },
  ) {
    let base = this.db
      .selectFrom('cash_transactions as c')
      .leftJoin('partners as p', 'p.id', 'c.partner_id');
    if (query.target_month) base = base.where('c.target_month', '=', `${query.target_month}-01`);
    if (query.division) base = base.where('c.division', '=', query.division);

    return base
      .select([
        'c.id as id',
        'c.cash_transaction_no as cash_transaction_no',
        'c.division as division',
        'c.target_month as target_month',
        'c.transaction_date as transaction_date',
        'c.partner_id as partner_id',
        'p.name1 as partner_name',
        'c.amount as amount',
        'c.cash_amount as cash_amount',
        'c.transfer_amount as transfer_amount',
        'c.card_amount as card_amount',
        // 画面（入出金処理）に手数料の列があるため、一覧でも返す
        'c.fee_amount as fee_amount',
        'c.bill_amount1 as bill_amount1',
        'c.bill_amount2 as bill_amount2',
        'c.offset_amount as offset_amount',
        'c.check_amount as check_amount',
        'c.collection_amount as collection_amount',
        'c.overseas_usd as overseas_usd',
        'c.overseas_cny as overseas_cny',
        // 訂正の画面に今の値を出すため、手形の決済日と備考も返す
        'c.bill_due_date1 as bill_due_date1',
        'c.bill_due_date2 as bill_due_date2',
        'c.note as note',
      ])
      .orderBy('c.target_month', 'desc')
      .orderBy('c.cash_transaction_no', 'desc')
      .execute();
  }

  /** 入出金の訂正。金額の打ち間違いを画面から直せるようにするため。 */
  @Patch('cash-transactions/:id')
  @RequirePermission('C-01', 'update')
  updateCashTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body(new FieldLabelPipe(CashTransactionUpdateSchema, CASH_FIELD_LABELS)) body: CashTransactionUpdateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchasing.updateCashTransaction(id, body, user.id);
  }

  /** 入出金の取消。消した分だけ、その月の入出金の合計から差し引かれる。 */
  @Delete('cash-transactions/:id')
  @RequirePermission('C-01', 'delete')
  removeCashTransaction(@Param('id', ParseIntPipe) id: number) {
    return this.purchasing.removeCashTransaction(id);
  }
}

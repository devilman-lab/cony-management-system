import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';

export interface PurchaseLineInput {
  line_no: number;
  purchase_item_id?: number | null;
  item_name: string;
  qty?: string;
  unit_cost: string;
  /** 経費の明細は SKU ではなく商品（品番）単位で持つ。商品別経費集計のもとになる。 */
  target_product_id?: number | null;
  target_brand_id?: number | null;
  target_product_class_id?: number | null;
  tax_rate?: string;
  note?: string | null;
}

export interface CreatePurchaseInput {
  division: '仕入' | '経費';
  supplier_partner_id: number;
  purchase_date: string;
  delivery_date?: string | null;
  payment_date1?: string | null;
  payment_date2?: string | null;
  currency?: string;
  note?: string | null;
  lines: PurchaseLineInput[];
}

export interface CashPaymentInput {
  partner_id: number;
  payment_date: string;
  amount: string;
  purchase_id?: number | null;
  applied_amount?: string | null;
  note?: string | null;
}

/** 支払の訂正。渡された項目だけを直す（省略した項目はそのまま）。 */
export interface UpdateCashPaymentInput {
  payment_date?: string;
  amount?: string;
  /** null を渡すと消込を外す。省略のときは今の消込先を残す。 */
  purchase_id?: number | null;
  note?: string | null;
}

/** 入出金の金額欄。呼び方は画面（入出金処理）に出ているものに合わせる。 */
const CASH_MEANS = [
  { key: 'transfer_amount', label: '振込' },
  { key: 'cash_amount', label: '現金' },
  { key: 'card_amount', label: 'カード' },
  { key: 'bill_amount1', label: '手形①' },
  { key: 'bill_amount2', label: '手形②' },
  { key: 'offset_amount', label: '相殺' },
  { key: 'check_amount', label: '小切手' },
  { key: 'collection_amount', label: '集金' },
  { key: 'overseas_usd', label: '海外送金 (USD)' },
  { key: 'overseas_cny', label: '海外送金 (CNY)' },
] as const;

/** 手数料は差し引きなので合計には入れない（画面の但し書きと同じ）。0 以上かどうかだけ見る。 */
const CASH_FEE = { key: 'fee_amount', label: '手数料' } as const;

/**
 * 入出金の金額を検める。**登録と訂正の両方から呼ぶこと。**
 * 片方にしか入っていないと、同じ画面なのに入口によって通る値が変わる。
 *
 * 手段ごとの内訳はマイナスにできない（打ち間違い。合計が合わなくなる）。
 * 合計（手数料を除く）は 0 より大きいこと。0 円の入出金は記録する意味がなく、
 * 「手数料だけ入れて金額を入れ忘れた」を拾うためでもある。
 */
export function assertCashAmounts(values: Partial<Record<CashMeansKey, string | null | undefined>>): void {
  for (const m of [...CASH_MEANS, CASH_FEE]) {
    const value = values[m.key];
    const n = value === null || value === undefined ? 0 : Number(value);
    if (!Number.isFinite(n)) throw new BadRequestException(`${m.label}は数字で入力してください`);
    if (n < 0) throw new BadRequestException(`${m.label}は 0 以上の金額で入力してください`);
  }
  const total = CASH_MEANS.reduce((a, m) => {
    const v = values[m.key];
    return a + (v === null || v === undefined ? 0 : Number(v));
  }, 0);
  if (total <= 0) {
    throw new BadRequestException(
      '合計は 0 より大きい金額で入力してください。振込・現金・カードなどの内訳をご確認ください（手数料は合計に含みません）',
    );
  }
}

type CashMeansKey = (typeof CASH_MEANS)[number]['key'] | (typeof CASH_FEE)['key'];

/** 入出金の訂正。渡された項目だけを直す（省略した項目はそのまま）。 */
export type UpdateCashTransactionInput = {
  division?: '入金' | '出金';
  /** YYYY-MM。日付に直すのはこの中で行う。 */
  target_month?: string;
  transaction_date?: string | null;
  scheduled_date?: string | null;
  partner_id?: number | null;
  partner_contact?: string | null;
  sales_staff_name?: string | null;
  currency?: string;
  bill_due_date1?: string | null;
  bill_due_date2?: string | null;
  note?: string | null;
} & { [K in CashMeansKey]?: string | null };

/** 機能ID P-01 仕入・経費登録／P-03 買掛残高一覧 */
@Injectable()
export class PurchasingService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
  ) {}

  async create(input: CreatePurchaseInput, userId: number) {
    if (input.lines.length === 0) throw new BadRequestException('明細を1行以上入力してください');

    // 数量 0 の明細を通すと、合計 0 円の仕入伝票だけが残り、何を仕入れたのか分からなくなる。
    // 文言は受注（orders.service.ts）・入荷（receipts.service.ts）と揃える。
    // 単価のマイナスは通す。値引・返金を1行で書く使い方があるため。
    for (const line of input.lines) {
      const qty = Number(line.qty ?? '1');
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException(`${line.line_no}行目：数量は 0 より大きい数で入力してください`);
      }
    }

    return this.db.transaction().execute(async (trx) => {
      const purchaseNo = await this.numbering.next(trx, 'purchase');

      const purchase = await trx
        .insertInto('purchases')
        .values({
          purchase_no: purchaseNo,
          division: input.division,
          supplier_partner_id: input.supplier_partner_id,
          purchase_date: input.purchase_date,
          delivery_date: input.delivery_date ?? null,
          payment_date1: input.payment_date1 ?? null,
          payment_date2: input.payment_date2 ?? null,
          currency: input.currency ?? undefined,
          note: input.note ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'purchase_no'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('purchase_lines')
        .values(
          input.lines.map((l) => ({
            purchase_id: purchase.id,
            line_no: l.line_no,
            purchase_item_id: l.purchase_item_id ?? null,
            item_name: l.item_name,
            qty: l.qty ?? '1',
            unit_cost: l.unit_cost,
            subtotal: sql<string>`${l.qty ?? '1'}::numeric * ${l.unit_cost}::numeric`,
            tax_rate: l.tax_rate ?? undefined,
            target_product_id: l.target_product_id ?? null,
            target_brand_id: l.target_brand_id ?? null,
            target_product_class_id: l.target_product_class_id ?? null,
            note: l.note ?? null,
            created_by: userId,
          })),
        )
        .execute();

      await trx
        .updateTable('purchases')
        .set({
          total_amount: sql<string>`(select coalesce(sum(subtotal),0) from purchase_lines where purchase_id = ${purchase.id})`,
        })
        .where('id', '=', purchase.id)
        .execute();

      const saved = await trx
        .selectFrom('purchases')
        .select(['id', 'purchase_no', 'total_amount'])
        .where('id', '=', purchase.id)
        .executeTakeFirstOrThrow();

      return saved;
    });
  }

  async list(query: {
    division?: string;
    supplier_partner_id?: number;
    status?: string;
    exclude_cancelled?: boolean;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('purchases as p')
      .innerJoin('partners as s', 's.id', 'p.supplier_partner_id');

    if (query.division) base = base.where('p.division', '=', query.division);
    if (query.supplier_partner_id !== undefined) base = base.where('p.supplier_partner_id', '=', query.supplier_partner_id);
    if (query.status) base = base.where('p.status', '=', query.status);
    // 支払の消込先を選ぶときのように、取消済みを並べてはいけない場面で使う。
    // 何も指定しなければ取消済みも返すので、仕入一覧の見え方は変わらない。
    if (query.exclude_cancelled) base = base.where('p.status', '<>', '取消');
    if (query.from) base = base.where('p.purchase_date', '>=', query.from);
    if (query.to) base = base.where('p.purchase_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'p.id as id',
          'p.purchase_no as purchase_no',
          'p.division as division',
          'p.purchase_date as purchase_date',
          'p.total_amount as total_amount',
          'p.status as status',
          's.name1 as supplier_name',
        ])
        .orderBy('p.purchase_date', 'desc')
        .orderBy('p.purchase_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const purchase = await this.db
      .selectFrom('purchases as p')
      .innerJoin('partners as s', 's.id', 'p.supplier_partner_id')
      .selectAll('p')
      .select('s.name1 as supplier_name')
      .where('p.id', '=', id)
      .executeTakeFirst();

    if (!purchase) throw new NotFoundException(`仕入・経費が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('purchase_lines as l')
      .leftJoin('products as pr', 'pr.id', 'l.target_product_id')
      .leftJoin('brands as b', 'b.id', 'l.target_brand_id')
      .select([
        'l.line_no as line_no',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_cost as unit_cost',
        'l.subtotal as subtotal',
        'l.tax_rate as tax_rate',
        'pr.product_code as target_product_code',
        'pr.product_name as target_product_name',
        'b.name as target_brand_name',
      ])
      .where('l.purchase_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...purchase, lines };
  }

  /**
   * 商品別の経費集計。
   * 経費の明細に商品（品番）を持たせているので、ここが集計のもとになる。
   */
  async expenseByProduct(query: { from?: string; to?: string }) {
    let base = this.db
      .selectFrom('purchase_lines as l')
      .innerJoin('purchases as p', 'p.id', 'l.purchase_id')
      .leftJoin('products as pr', 'pr.id', 'l.target_product_id')
      .where('p.division', '=', '経費')
      // 取り消した経費は按分の対象から外す（買掛残高から外すのと揃える）
      .where('p.status', '<>', '取消');

    if (query.from) base = base.where('p.purchase_date', '>=', query.from);
    if (query.to) base = base.where('p.purchase_date', '<=', query.to);

    return base
      .select([
        'pr.product_code as product_code',
        'pr.product_name as product_name',
        sql<string>`sum(l.subtotal)`.as('amount'),
        sql<number>`count(*)::int`.as('line_count'),
      ])
      .groupBy(['pr.product_code', 'pr.product_name'])
      .orderBy(sql`sum(l.subtotal)`, 'desc')
      .execute();
  }

  /** 支払の登録と消込。 */
  async createPayment(input: CashPaymentInput, userId: number) {
    if (input.purchase_id) {
      const purchase = await this.db
        .selectFrom('purchases')
        .select(['id', 'purchase_no', 'supplier_partner_id', 'status'])
        .where('id', '=', input.purchase_id)
        .executeTakeFirst();
      if (!purchase) throw new NotFoundException('消込先の仕入が見つかりません');
      if (purchase.supplier_partner_id !== input.partner_id) {
        throw new BadRequestException('支払の取引先と仕入の取引先が違います');
      }
      // 取消済みの仕入は買掛の集計から外しているので、そこへ消し込ませると残高が合わなくなる
      if (purchase.status === '取消') {
        throw new ConflictException(
          `仕入「${purchase.purchase_no}」は取消済みです。別の仕入を選ぶか、消込先を空にしてください`,
        );
      }
    }

    const applied = input.applied_amount ?? (input.purchase_id ? input.amount : '0');
    if (Number(applied) > Number(input.amount)) {
      throw new BadRequestException('消込額が支払額を超えています');
    }

    return this.db
      .insertInto('cash_payments')
      .values({
        partner_id: input.partner_id,
        payment_date: input.payment_date,
        amount: input.amount,
        purchase_id: input.purchase_id ?? null,
        applied_amount: applied,
        note: input.note ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'amount', 'applied_amount'])
      .executeTakeFirstOrThrow();
  }

  /**
   * 支払の一覧。画面で「どの支払を直すか／消すか」を選べるようにするために返す。
   * 消込先の仕入番号まで返すのは、同じ日・同じ金額の支払が並んだときに見分けがつかないため。
   */
  async listPayments(query: {
    partner_id?: number;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('cash_payments as cp')
      .innerJoin('partners as s', 's.id', 'cp.partner_id')
      .leftJoin('purchases as pu', 'pu.id', 'cp.purchase_id');

    if (query.partner_id !== undefined) base = base.where('cp.partner_id', '=', query.partner_id);
    if (query.from) base = base.where('cp.payment_date', '>=', query.from);
    if (query.to) base = base.where('cp.payment_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'cp.id as id',
          'cp.payment_date as payment_date',
          'cp.partner_id as partner_id',
          's.partner_code as partner_code',
          's.name1 as supplier_name',
          'cp.amount as amount',
          'cp.applied_amount as applied_amount',
          'cp.purchase_id as purchase_id',
          'pu.purchase_no as purchase_no',
          'pu.status as purchase_status',
          'cp.cash_transaction_id as cash_transaction_id',
          'cp.note as note',
        ])
        .orderBy('cp.payment_date', 'desc')
        .orderBy('cp.id', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 支払の訂正。日付・金額・消込先・備考を直せる。
   * purchase_id は「項目ごと省略＝そのまま」「null＝消込を外す」と読み分ける。
   * 省略と null を同じ扱いにすると、備考だけ直したつもりで消込が外れてしまうため。
   */
  async updatePayment(id: number, input: UpdateCashPaymentInput, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('cash_payments')
        .select(['id', 'partner_id', 'amount', 'applied_amount', 'purchase_id'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException(`支払が見つかりません（ID: ${id}）`);

      const nextAmount = input.amount ?? current.amount;
      if (Number(nextAmount) <= 0) {
        throw new BadRequestException('支払額は 0 より大きい金額で入力してください');
      }

      const nextPurchaseId = input.purchase_id === undefined ? current.purchase_id : input.purchase_id;

      if (nextPurchaseId !== null) {
        const purchase = await trx
          .selectFrom('purchases')
          .select(['id', 'purchase_no', 'supplier_partner_id', 'status'])
          .where('id', '=', nextPurchaseId)
          .executeTakeFirst();
        if (!purchase) throw new NotFoundException('消込先の仕入が見つかりません');
        if (purchase.supplier_partner_id !== current.partner_id) {
          throw new BadRequestException('支払の取引先と仕入の取引先が違います');
        }
        // 取消済みの仕入は買掛の集計から外しているので、そこへ消し込ませると残高が合わなくなる
        if (purchase.status === '取消') {
          throw new ConflictException(
            `仕入「${purchase.purchase_no}」は取消済みです。別の仕入を選ぶか、消込先を空にしてください`,
          );
        }
      }

      // 金額か消込先を触ったときだけ消込額を引き直す。一部消込にしてある額を勝手に戻さないため。
      const amountChanged = input.amount !== undefined && input.amount !== current.amount;
      const purchaseChanged = nextPurchaseId !== current.purchase_id;
      let applied = current.applied_amount;
      if (nextPurchaseId === null) applied = '0';
      else if (amountChanged || purchaseChanged) applied = nextAmount;
      if (Number(applied) > Number(nextAmount)) applied = nextAmount;

      // 触っていない項目まで書き換えないよう、渡された項目だけを更新対象にする
      const patch: Record<string, unknown> = {
        amount: nextAmount,
        purchase_id: nextPurchaseId,
        applied_amount: applied,
        updated_by: userId,
        updated_at: new Date(),
      };
      if (input.payment_date !== undefined) patch.payment_date = input.payment_date;
      if (input.note !== undefined) patch.note = input.note ?? null;

      await trx
        .updateTable('cash_payments')
        .set(patch as never)
        .where('id', '=', id)
        .execute();

      return trx.selectFrom('cash_payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  /**
   * 支払の取消。cash_payments には状態の列が無いので、行ごと消す。
   * 消した分は買掛残高にそのまま戻る（残高はそのつど集計しているため）。
   * 入出金処理（C-01）に取り込み済みのものは、そちらとずれるので消させない。
   */
  async removePayment(id: number) {
    const row = await this.db
      .selectFrom('cash_payments')
      .select(['id', 'cash_transaction_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`支払が見つかりません（ID: ${id}）`);
    if (row.cash_transaction_id !== null) {
      throw new ConflictException(
        'この支払は入出金処理に取り込まれています。先に入出金の側を取り消してください',
      );
    }

    await this.db.deleteFrom('cash_payments').where('id', '=', id).execute();
    return { id: row.id, deleted: true };
  }

  /**
   * 仕入・経費の取消。行は残して状態だけ「取消」にする（伝票番号に欠番を作らないため）。
   * 支払がひも付いているものは取り消せない。支払だけが残ると買掛残高がマイナスに見えるので、
   * 先に支払を消していただく。
   */
  async cancel(id: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const purchase = await trx
        .selectFrom('purchases')
        .select(['id', 'purchase_no', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!purchase) throw new NotFoundException(`仕入・経費が見つかりません（ID: ${id}）`);
      if (purchase.status === '取消') throw new ConflictException('すでに取り消されています');

      const paid = await trx
        .selectFrom('cash_payments')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('purchase_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(paid.n) > 0) {
        throw new ConflictException(
          `この仕入には支払が ${paid.n} 件ひも付いています。支払の一覧で先に支払を取り消してから、もう一度お試しください`,
        );
      }

      await trx
        .updateTable('purchases')
        .set({ status: '取消', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { id, purchase_no: purchase.purchase_no, status: '取消' };
    });
  }

  /**
   * 入出金の訂正。金額の打ち間違いを画面から直せるようにする。
   * 手段ごとの内訳は、渡された欄だけ差し替えて組み直す（触っていない欄は今の値を残す）。
   * 合計は登録のときと同じく内訳から引き直す（手数料は差し引きなので含めない）。
   */
  async updateCashTransaction(id: number, input: UpdateCashTransactionInput, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('cash_transactions')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException(`入出金が見つかりません（ID: ${id}）`);

      // 渡された欄だけ差し替え、触っていない欄は今の値を残したうえで検める。
      const means: Record<string, string | null> = {};
      for (const m of [...CASH_MEANS, CASH_FEE]) {
        const given = input[m.key];
        means[m.key] = given === undefined ? current[m.key] : (given ?? null);
      }
      assertCashAmounts(means);

      // 触っていない項目まで書き換えないよう、渡された項目だけを更新対象にする
      const patch: Record<string, unknown> = { ...means, updated_by: userId, updated_at: new Date() };
      if (input.division !== undefined) patch.division = input.division;
      if (input.target_month !== undefined) patch.target_month = `${input.target_month}-01`;
      if (input.transaction_date !== undefined) patch.transaction_date = input.transaction_date ?? null;
      if (input.scheduled_date !== undefined) patch.scheduled_date = input.scheduled_date ?? null;
      if (input.partner_id !== undefined) patch.partner_id = input.partner_id ?? null;
      if (input.partner_contact !== undefined) patch.partner_contact = input.partner_contact ?? null;
      if (input.sales_staff_name !== undefined) patch.sales_staff_name = input.sales_staff_name ?? null;
      if (input.currency !== undefined) patch.currency = input.currency;
      if (input.bill_due_date1 !== undefined) patch.bill_due_date1 = input.bill_due_date1 ?? null;
      if (input.bill_due_date2 !== undefined) patch.bill_due_date2 = input.bill_due_date2 ?? null;
      if (input.note !== undefined) patch.note = input.note ?? null;

      await trx
        .updateTable('cash_transactions')
        .set(patch as never)
        .where('id', '=', id)
        .execute();

      // 合計は登録のときと同じ組み立て。金額の足し算は SQL 側で行う。
      await trx
        .updateTable('cash_transactions')
        .set({
          amount: sql<string>`coalesce(cash_amount,0) + coalesce(transfer_amount,0) + coalesce(card_amount,0) + coalesce(bill_amount1,0)
                            + coalesce(bill_amount2,0) + coalesce(offset_amount,0) + coalesce(check_amount,0)
                            + coalesce(collection_amount,0) + coalesce(overseas_usd,0) + coalesce(overseas_cny,0)`,
        })
        .where('id', '=', id)
        .execute();

      return trx.selectFrom('cash_transactions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  /**
   * 入出金の取消。cash_transactions には状態の列が無いので、行ごと消す。
   * 消した分は、その月の入出金一覧と合計からそのまま外れる。
   * 入金・支払から取り込んだものは、そちらの消込先が無くなるので消させない。
   */
  async removeCashTransaction(id: number) {
    const row = await this.db
      .selectFrom('cash_transactions')
      .select(['id', 'cash_transaction_no'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`入出金が見つかりません（ID: ${id}）`);

    const [payments, receipts] = await Promise.all([
      this.db
        .selectFrom('cash_payments')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('cash_transaction_id', '=', id)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('cash_receipts')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('cash_transaction_id', '=', id)
        .executeTakeFirstOrThrow(),
    ]);
    const linked = Number(payments.n) + Number(receipts.n);
    if (linked > 0) {
      throw new ConflictException(
        `この入出金には入金・支払が ${linked} 件ひも付いています。先にそちらを取り消してから、もう一度お試しください`,
      );
    }

    await this.db.deleteFrom('cash_transactions').where('id', '=', id).execute();
    return { id: row.id, cash_transaction_no: row.cash_transaction_no, deleted: true };
  }

  /**
   * 買掛残高一覧。期間の仕入額と支払額から残高を出す。
   * 売掛のように締め伝票を作るのではなく、そのつど集計して見せる。
   *
   * 期間内だけを見ると、前月に仕入れて当月に払う取引先は残高がマイナスに見えてしまうので、
   * 期間開始前の「仕入−支払」を繰越として持たせ、残高＝繰越＋期間内仕入−期間内支払 とする。
   * 取り消した仕入は繰越にも期間内にも入れない。
   */
  async apBalances(query: { from: string; to: string }) {
    return this.db
      .selectFrom((eb) =>
        eb
          .selectFrom('partners as p')
          .select([
            'p.id as partner_id',
            'p.partner_code as partner_code',
            'p.name1 as partner_name',
            sql<string>`(select coalesce(sum(pu.total_amount),0) from purchases pu
                          where pu.supplier_partner_id = p.id and pu.status <> '取消'
                            and pu.purchase_date < ${query.from})
                      - (select coalesce(sum(cp.amount),0) from cash_payments cp
                          where cp.partner_id = p.id and cp.payment_date < ${query.from})`.as('carryover_amount'),
            sql<string>`(select coalesce(sum(pu.total_amount),0) from purchases pu
                          where pu.supplier_partner_id = p.id and pu.status <> '取消'
                            and pu.purchase_date >= ${query.from} and pu.purchase_date <= ${query.to})`.as('purchase_amount'),
            sql<string>`(select coalesce(sum(cp.amount),0) from cash_payments cp
                          where cp.partner_id = p.id
                            and cp.payment_date >= ${query.from} and cp.payment_date <= ${query.to})`.as('payment_amount'),
          ])
          .where('p.is_supplier', '=', true)
          .where('p.is_active', '=', true)
          .as('ap'),
      )
      .select([
        'ap.partner_id',
        'ap.partner_code',
        'ap.partner_name',
        'ap.carryover_amount',
        'ap.purchase_amount',
        'ap.payment_amount',
        sql<string>`ap.carryover_amount + ap.purchase_amount - ap.payment_amount`.as('balance'),
      ])
      .orderBy('ap.partner_code', 'asc')
      .execute();
  }
}

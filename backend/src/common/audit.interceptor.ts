import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Observable, from } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { RequestWithUser } from '../auth/guards';
import { SIMPLE_MASTERS } from '../masters/masters-crud.service';

/**
 * 操作履歴（audit_logs）を残す。
 *
 * 画面「ユーザー・権限 ＞ 操作履歴」は「誰が・いつ・何を変えたか。変更前後の内容も残ります」と
 * 案内しているが、読む側だけ作られていて書く側が無かったため、ここで埋める。
 *
 * 決めごと:
 *  - 記録するのは **下の表に載せた経路だけ**。ref_table は表に書いた文字列（＝実在のテーブル名）
 *    しか使わないので、URL の文字がそのまま SQL に渡ることはない。
 *  - 変更前後は **その行をそのまま** 写す。伝票（受注・入荷・返品・仕入・請求など）は明細も付ける。
 *    受注の数量を 3 → 5 に直しても見出し側は何も変わらないため、明細が無いと差が読めない。
 *  - 失敗した操作は残さない。audit_logs の決まり（action は insert/update/delete）に合わないため。
 *  - 履歴の書き込みでつまずいても、業務の操作は止めない（握りつぶして警告だけ出す）。
 */

/** 行IDの取り出し方。param＝URLの:id、response＝返ってきた本体のid、none＝行が1つに決まらない操作。 */
type IdFrom = 'param' | 'response' | 'none';

interface Rule {
  /** 実在のテーブル名。'kind' のときは URL の :kind（分類マスタ）を使う。 */
  table: string | 'kind';
  action: 'insert' | 'update' | 'delete';
  idFrom: IdFrom;
  /** idFrom が param のときの、URL の変数名。既定は id。 */
  param?: string;
}

/**
 * 「メソッド + コントローラの道 + 関数の道」で引く表。
 * 書き込みの経路はすべてここに載っている。新しく足したときはここにも足すこと。
 */
const RULES: Record<string, Rule> = {
  // 利用者・役割
  'POST admin/users': { table: 'users', action: 'insert', idFrom: 'response' },
  'PATCH admin/users/:id': { table: 'users', action: 'update', idFrom: 'param' },
  'POST admin/users/:id/password': { table: 'users', action: 'update', idFrom: 'param' },
  'PUT admin/users/:id/roles': { table: 'users', action: 'update', idFrom: 'param' },
  'POST admin/users/:id/deactivate': { table: 'users', action: 'update', idFrom: 'param' },
  'PUT admin/roles/:id/permissions': { table: 'roles', action: 'update', idFrom: 'param' },

  // 保存した集計条件・添付
  'POST analytics/saved-queries': { table: 'saved_queries', action: 'insert', idFrom: 'response' },
  'POST attachments': { table: 'attachments', action: 'insert', idFrom: 'response' },
  'DELETE attachments/:id': { table: 'attachments', action: 'delete', idFrom: 'param' },

  // 請求・入金・ロイヤリティ
  'POST billing/closings': { table: 'invoices', action: 'insert', idFrom: 'none' },
  'PATCH billing/invoices/:id': { table: 'invoices', action: 'update', idFrom: 'param' },
  'POST billing/invoices/:id/issue': { table: 'invoices', action: 'update', idFrom: 'param' },
  'POST billing/invoices/:id/cancel': { table: 'invoices', action: 'update', idFrom: 'param' },
  'POST billing/cash-receipts': { table: 'cash_receipts', action: 'insert', idFrom: 'response' },
  'PATCH billing/cash-receipts/:id': { table: 'cash_receipts', action: 'update', idFrom: 'param' },
  'DELETE billing/cash-receipts/:id': { table: 'cash_receipts', action: 'delete', idFrom: 'param' },
  'POST billing/royalties/calculate': { table: 'royalty_calculations', action: 'insert', idFrom: 'none' },
  'POST billing/royalties/:id/confirm': { table: 'royalty_calculations', action: 'update', idFrom: 'param' },

  // 取込
  'POST imports/partner-orders': { table: 'import_batches', action: 'insert', idFrom: 'none' },
  'POST imports/oms-orders': { table: 'import_batches', action: 'insert', idFrom: 'none' },
  'POST imports/amazon-transactions': { table: 'import_batches', action: 'insert', idFrom: 'none' },
  'POST postal-codes/import': { table: 'postal_codes', action: 'insert', idFrom: 'none' },

  // 在庫
  'POST inventory/receipts': { table: 'receipts', action: 'insert', idFrom: 'response' },
  'POST inventory/receipts/:id/receive': { table: 'receipts', action: 'update', idFrom: 'param' },
  'POST inventory/receipts/:id/cancel': { table: 'receipts', action: 'update', idFrom: 'param' },
  'POST inventory/adjustments': { table: 'stock_adjustments', action: 'insert', idFrom: 'response' },
  'POST inventory/reservations': { table: 'reservations', action: 'insert', idFrom: 'response' },
  'PATCH inventory/reservations/:id': { table: 'reservations', action: 'update', idFrom: 'param' },
  'DELETE inventory/reservations/:id': { table: 'reservations', action: 'delete', idFrom: 'param' },
  'POST inventory/reservations/copy': { table: 'reservations', action: 'insert', idFrom: 'none' },

  // マスタ
  'POST masters/simple/:kind': { table: 'kind', action: 'insert', idFrom: 'response' },
  'PATCH masters/simple/:kind/:id': { table: 'kind', action: 'update', idFrom: 'param' },
  'POST masters/simple/:kind/:id/deactivate': { table: 'kind', action: 'update', idFrom: 'param' },
  'POST masters/partners': { table: 'partners', action: 'insert', idFrom: 'response' },
  'PATCH masters/partners/:id': { table: 'partners', action: 'update', idFrom: 'param' },
  'POST masters/partners/:id/deactivate': { table: 'partners', action: 'update', idFrom: 'param' },
  'POST masters/delivery-destinations': { table: 'delivery_destinations', action: 'insert', idFrom: 'response' },
  'PATCH masters/delivery-destinations/:id': { table: 'delivery_destinations', action: 'update', idFrom: 'param' },
  'POST masters/delivery-destinations/:id/deactivate': { table: 'delivery_destinations', action: 'update', idFrom: 'param' },
  'POST masters/products': { table: 'products', action: 'insert', idFrom: 'response' },
  'PATCH masters/products/:id': { table: 'products', action: 'update', idFrom: 'param' },
  'POST masters/products/:id/deactivate': { table: 'products', action: 'update', idFrom: 'param' },
  'POST masters/skus': { table: 'skus', action: 'insert', idFrom: 'response' },
  'PATCH masters/skus/:id': { table: 'skus', action: 'update', idFrom: 'param' },
  'POST masters/sets': { table: 'set_headers', action: 'insert', idFrom: 'none' },
  'POST masters/partner-products': { table: 'partner_products', action: 'insert', idFrom: 'response' },
  'PATCH masters/partner-products/:id': { table: 'partner_products', action: 'update', idFrom: 'param' },
  'POST masters/partner-products/:id/deactivate': { table: 'partner_products', action: 'update', idFrom: 'param' },
  'POST masters/warehouses': { table: 'warehouses', action: 'insert', idFrom: 'response' },
  'PATCH masters/warehouses/:id': { table: 'warehouses', action: 'update', idFrom: 'param' },
  'POST masters/warehouses/:id/deactivate': { table: 'warehouses', action: 'update', idFrom: 'param' },
  'POST masters/purchase-items': { table: 'purchase_items', action: 'insert', idFrom: 'response' },
  'PATCH masters/purchase-items/:id': { table: 'purchase_items', action: 'update', idFrom: 'param' },
  'POST masters/purchase-items/:id/deactivate': { table: 'purchase_items', action: 'update', idFrom: 'param' },
  'POST masters/codes': { table: 'codes', action: 'insert', idFrom: 'response' },
  'PATCH masters/codes/:id': { table: 'codes', action: 'update', idFrom: 'param' },
  'PATCH masters/settings/:key': { table: 'system_settings', action: 'update', idFrom: 'none' },
  'POST masters/royalty-rules': { table: 'royalty_rules', action: 'insert', idFrom: 'response' },
  'PATCH masters/royalty-rules/:id': { table: 'royalty_rules', action: 'update', idFrom: 'param' },
  'POST masters/royalty-rules/:id/deactivate': { table: 'royalty_rules', action: 'update', idFrom: 'param' },

  // 受注・出荷
  'POST orders': { table: 'sales_orders', action: 'insert', idFrom: 'response' },
  'PATCH orders/:id': { table: 'sales_orders', action: 'update', idFrom: 'param' },
  'POST orders/:id/cancel': { table: 'sales_orders', action: 'update', idFrom: 'param' },
  'POST orders/:id/allocate': { table: 'sales_orders', action: 'update', idFrom: 'param' },
  'POST orders/:id/shipping-instruction': { table: 'sales_orders', action: 'update', idFrom: 'param' },
  'DELETE orders/:id/shipping-instruction': { table: 'sales_orders', action: 'update', idFrom: 'param' },
  'POST shipments/:id/confirm': { table: 'shipments', action: 'update', idFrom: 'param' },
  'POST shipments/:id/unconfirm': { table: 'shipments', action: 'update', idFrom: 'param' },
  'POST shipments/consolidate': { table: 'shipments', action: 'update', idFrom: 'none' },
  'DELETE shipments/:id/consolidation': { table: 'shipments', action: 'update', idFrom: 'param' },
  'POST reports/confirm-and-print': { table: 'shipments', action: 'update', idFrom: 'none' },

  // 返品
  'POST returns': { table: 'returns', action: 'insert', idFrom: 'response' },
  'POST returns/:id/inspect': { table: 'returns', action: 'update', idFrom: 'param' },
  'POST returns/:id/cancel': { table: 'returns', action: 'update', idFrom: 'param' },

  // 仕入・支払・入出金
  'POST purchases': { table: 'purchases', action: 'insert', idFrom: 'response' },
  'POST purchases/:id/cancel': { table: 'purchases', action: 'update', idFrom: 'param' },
  'POST payments': { table: 'cash_payments', action: 'insert', idFrom: 'response' },
  'PATCH payments/:id': { table: 'cash_payments', action: 'update', idFrom: 'param' },
  'DELETE payments/:id': { table: 'cash_payments', action: 'delete', idFrom: 'param' },
  'POST cash-transactions': { table: 'cash_transactions', action: 'insert', idFrom: 'response' },
  'PATCH cash-transactions/:id': { table: 'cash_transactions', action: 'update', idFrom: 'param' },
  'DELETE cash-transactions/:id': { table: 'cash_transactions', action: 'delete', idFrom: 'param' },

  // 販売予定
  'POST sales-schedules': { table: 'sales_schedules', action: 'insert', idFrom: 'response' },
  'PATCH sales-schedules/:id': { table: 'sales_schedules', action: 'update', idFrom: 'param' },
  'DELETE sales-schedules/:id': { table: 'sales_schedules', action: 'delete', idFrom: 'param' },
};

/**
 * 見出しだけ写しても違いが出ない伝票。明細も一緒に写す。
 * 例：受注の数量を 3 → 5 に直しても sales_orders 側は何も変わらないため、
 * 明細を付けないと「変更前」と「変更後」が同じに見えてしまう。
 */
const CHILD_LINES: Record<string, { table: string; fk: string; order: string }> = {
  sales_orders: { table: 'sales_order_lines', fk: 'sales_order_id', order: 'line_no' },
  receipts: { table: 'receipt_lines', fk: 'receipt_id', order: 'line_no' },
  returns: { table: 'return_lines', fk: 'return_id', order: 'line_no' },
  purchases: { table: 'purchase_lines', fk: 'purchase_id', order: 'line_no' },
  invoices: { table: 'invoice_lines', fk: 'invoice_id', order: 'line_no' },
  stock_adjustments: { table: 'stock_adjustment_lines', fk: 'stock_adjustment_id', order: 'line_no' },
  set_headers: { table: 'set_components', fk: 'set_header_id', order: 'sort_order' },
};

/** 明細を写す上限。これを超える伝票は件数だけ残す（履歴が膨らむのを防ぐ）。 */
const MAX_LINES = 50;

/** 履歴に残さない列。パスワードなど、残すと危ないもの。 */
const MASKED = new Set(['password', 'new_password', 'current_password', 'password_hash', 'token', 'access_token']);

/**
 * 中身を写さない項目。
 * 取込の content_base64 には CSV がまるごと入っており、購入者の氏名・住所・電話番号を含む。
 * 履歴に写すと個人情報がもう一か所に増え、行も何MBにもなるため、名前だけ残して中身は捨てる。
 */
const BULKY = new Set(['content_base64', 'content', 'file_base64']);

/** 要求の本文に入っていた長い文字列は、そのまま残さず長さだけ残す。 */
const MAX_TEXT = 500;

/** 「変更前」「変更後」に写さない列。毎回変わるだけで読む意味がないもの。 */
const NOISE = new Set(['created_at', 'updated_at', 'created_by', 'updated_by', 'search_key']);

/** 道の前後のスラッシュを落とす。@Controller() のように空のこともある。 */
const trim = (s: unknown): string => String(s ?? '').replace(/^\/+|\/+$/g, '');

export function routeKey(method: string, controllerPath: unknown, handlerPath: unknown): string {
  const path = [trim(controllerPath), trim(handlerPath)].filter((p) => p.length > 0).join('/');
  return `${method} ${path}`;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const method = String(req.method ?? '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next.handle();

    const key = routeKey(
      method,
      Reflect.getMetadata(PATH_METADATA, context.getClass()) as unknown,
      Reflect.getMetadata(PATH_METADATA, context.getHandler()) as unknown,
    );
    const rule = RULES[key];
    if (!rule) return next.handle();

    // ログインしていない操作（ログインそのものなど）は残さない。
    const userId = req.user?.id;
    if (!userId) return next.handle();

    const table = this.resolveTable(rule, req);
    if (!table) return next.handle();

    // 「確認だけ（登録しない）」は何も変えないので残さない。
    // 残すと、1件も登録していない操作が履歴に「登録」と並んで紛らわしい。
    if ((req.body as { dry_run?: unknown } | undefined)?.dry_run === true) return next.handle();

    const refId = rule.idFrom === 'param' ? this.toId(req.params?.[rule.param ?? 'id']) : null;
    const before = rule.action === 'insert' ? null : await this.snapshot(table, refId);

    return next.handle().pipe(
      mergeMap((body) =>
        from(this.record(rule, table, req, refId, before, body)).pipe(map(() => body)),
      ),
    );
  }

  /** :kind（分類マスタ）は URL の文字だが、SIMPLE_MASTERS に載っているものしか通さない。 */
  private resolveTable(rule: Rule, req: RequestWithUser): string | null {
    if (rule.table !== 'kind') return rule.table;
    const kind = String(req.params?.kind ?? '');
    return kind in SIMPLE_MASTERS ? kind : null;
  }

  private toId(value: unknown): number | null {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** その行をそのまま写す。明細を持つ伝票は明細も付ける。見つからなければ null。 */
  private async snapshot(table: string, id: number | null): Promise<Record<string, unknown> | null> {
    if (id === null) return null;
    try {
      const row = await this.db
        // table はこのファイルの表に書いた文字列か SIMPLE_MASTERS のキーだけ。
        .selectFrom(table as never)
        .selectAll()
        .where('id' as never, '=', id as never)
        .executeTakeFirst();
      if (!row) return null;

      const snap = this.clean(row as Record<string, unknown>);
      const child = CHILD_LINES[table];
      if (child) snap.明細 = await this.lines(child.table, child.fk, child.order, id);
      return snap;
    } catch {
      return null;
    }
  }

  /** 伝票の明細を行番号の順に写す。 */
  private async lines(table: string, fk: string, order: string, id: number): Promise<unknown> {
    try {
      const rows = await this.db
        .selectFrom(table as never)
        .selectAll()
        .where(fk as never, '=', id as never)
        .orderBy(order as never)
        .limit(MAX_LINES + 1)
        .execute();
      if (rows.length > MAX_LINES) return `（明細が ${MAX_LINES} 行を超えるため省略）`;
      return (rows as Record<string, unknown>[]).map((r) => this.clean(r));
    } catch {
      return null;
    }
  }

  /** 履歴に残さない列を落とし、パスワードなどを伏せる。 */
  private clean(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (NOISE.has(k)) continue;
      out[k] = MASKED.has(k) ? '（伏せ字）' : v;
    }
    return out;
  }

  /**
   * 要求の本文を写す。
   * パスワードは伏せ、取込ファイルの中身（個人情報を含む）と長い文字列は捨てて大きさだけ残す。
   */
  private cleanBody(body: unknown): Record<string, unknown> | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (MASKED.has(k)) {
        out[k] = '（伏せ字）';
      } else if (BULKY.has(k)) {
        // base64 の文字数ではなく、元のファイルの大きさで書く（4文字で3バイト）。
        out[k] =
          typeof v === 'string'
            ? `（ファイルの中身は残しません：約 ${Math.round((v.length * 3) / 4 / 1024)} KB）`
            : '（中身は残しません）';
      } else if (typeof v === 'string' && v.length > MAX_TEXT) {
        out[k] = `（長いため省略：${v.length} 文字）`;
      } else if (Array.isArray(v) && v.length > MAX_LINES) {
        out[k] = `（${v.length} 件のため省略）`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private async record(
    rule: Rule,
    table: string,
    req: RequestWithUser,
    paramId: number | null,
    before: Record<string, unknown> | null,
    response: unknown,
  ): Promise<void> {
    try {
      let refId = paramId;
      let after: Record<string, unknown> | null = null;

      if (rule.idFrom === 'response') {
        const id = this.toId((response as { id?: unknown } | null)?.id);
        refId = id;
        after = await this.snapshot(table, id);
      } else if (rule.idFrom === 'param') {
        // 消したあとは読めないので、消す前の姿だけが残る。
        after = rule.action === 'delete' ? null : await this.snapshot(table, paramId);
      } else {
        // 行が1つに決まらない操作（締め処理・取込・同梱など）。
        // 何を頼んだか（要求）と、どういう結果になったか（件数など）を残す。
        after = {
          要求: this.cleanBody(req.body),
          結果: this.summarize(response),
        };
      }

      await this.db
        .insertInto('audit_logs')
        .values({
          user_id: req.user?.id ?? null,
          ref_table: table,
          ref_id: refId,
          action: rule.action,
          before_data: before ? (JSON.stringify(before) as never) : null,
          after_data: after ? (JSON.stringify(after) as never) : null,
        })
        .execute();
    } catch (e) {
      // 履歴が残せなくても業務の操作は止めない。
      console.warn('[audit] 操作履歴を残せませんでした', (e as Error).message);
    }
  }

  /** PDF などの中身は残さない。件数のような読める値だけ拾う。 */
  private summarize(response: unknown): unknown {
    if (response === null || response === undefined) return null;
    if (Buffer.isBuffer(response)) return '（帳票の中身は残しません）';
    if (typeof response !== 'object') return response;
    let text: string | undefined;
    try {
      text = JSON.stringify(response);
    } catch {
      return '（内容を写せませんでした）';
    }
    if (text === undefined) return null;
    if (text.length > 4000) return '（内容が大きいため省略）';
    return JSON.parse(text) as unknown;
  }
}

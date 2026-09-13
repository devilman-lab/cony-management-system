import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { decode, parseCsv } from './csv';

export interface AmazonImportInput {
  file_name: string;
  content_base64: string;
  encoding?: string;
  dry_run?: boolean;
}

export interface AmazonImportResult {
  file_name: string;
  dry_run: boolean;
  header_row: number;
  total_rows: number;
  inserted: number;
  skipped: number;
  transaction_types: Record<string, number>;
  /** トランザクションの種類ごとの、本システムでの振り分け先 */
  routing: Record<string, string>;
  unresolved_skus: string[];
  total_amount: string;
  warnings: string[];
}

/**
 * トランザクションの種類と、本システムでの扱い。
 * レポートには注文以外の行（手数料・返金・振込み）が混ざっているため、
 * 売上として計上するものと経費として計上するものを分ける。
 */
const ROUTING: Record<string, string> = {
  注文: '売上（プラットフォーム取引）',
  返金: '返金（売上のマイナス）',
  注文外料金: '経費（Amazon手数料）',
  FBA手数料: '経費（FBA手数料）',
  Amazon手数料: '経費（Amazon手数料）',
  調整: '調整（手入力で確認）',
  振込み: '入金（売掛の消込対象）',
};

const need = (row: Record<string, string>, key: string): string => (row[key] ?? '').trim();

/**
 * 機能ID I-01 CSV取込（Amazon 決済レポート）
 *
 * 先頭に説明文が数行入り、見出し行の位置が固定でない。
 * 「日付/時間」から始まる行を見出しとして探す。
 */
@Injectable()
export class AmazonImportService {
  private readonly logger = new Logger(AmazonImportService.name);

  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly settings: SettingsService,
  ) {}

  async import(input: AmazonImportInput, userId: number): Promise<AmazonImportResult> {
    const text = decode(Buffer.from(input.content_base64, 'base64'), input.encoding ?? 'UTF8');
    const rows = parseCsv(text);

    // 説明文の行数は月によって変わる。見出しを内容で探す。
    const headerRow = rows.findIndex((r) => r[0]?.trim() === '日付/時間' && r.includes('SKU'));
    if (headerRow < 0) {
      throw new BadRequestException(
        'Amazonの決済レポートの見出し行（「日付/時間」で始まる行）が見つかりません',
      );
    }

    const header = rows[headerRow].map((h) => h.trim());
    const records = rows.slice(headerRow + 1).map((cells) => {
      const rec: Record<string, string> = {};
      header.forEach((h, i) => (rec[h] = cells[i] ?? ''));
      return rec;
    });

    const types: Record<string, number> = {};
    const warnings: string[] = [];
    for (const r of records) {
      const t = need(r, 'トランザクションの種類') || '（空）';
      types[t] = (types[t] ?? 0) + 1;
      if (!ROUTING[t]) warnings.push(`トランザクションの種類「${t}」の扱いが決まっていません`);
    }

    const partnerCode = await this.settings.text('AMAZON_PARTNER_CODE', 'AMZN');
    const partner = await this.db
      .selectFrom('partners')
      .select('id')
      .where('partner_code', '=', partnerCode)
      .executeTakeFirst();

    if (!partner) {
      throw new BadRequestException(
        `Amazonの取引先（コード ${partnerCode}）が取引先マスタに登録されていません`,
      );
    }

    // SKU は Amazon 専用コード。取引先別商品マスタで自社SKUに読み替える。
    const skuCodes = [...new Set(records.map((r) => need(r, 'SKU')).filter(Boolean))];
    const mapping = new Map<string, number>();
    if (skuCodes.length > 0) {
      const found = await this.db
        .selectFrom('partner_products')
        .select(['partner_product_code', 'sku_id'])
        .where('partner_id', '=', partner.id)
        .where('partner_product_code', 'in', skuCodes)
        .execute();
      for (const f of found) {
        if (f.partner_product_code) mapping.set(f.partner_product_code, f.sku_id);
      }
    }
    const unresolved = skuCodes.filter((c) => !mapping.has(c));

    const total = records.reduce((sum, r) => sum + Number(this.num(need(r, '合計')) ?? 0), 0);

    const result: AmazonImportResult = {
      file_name: input.file_name,
      dry_run: input.dry_run ?? false,
      header_row: headerRow + 1,
      total_rows: records.length,
      inserted: 0,
      skipped: 0,
      transaction_types: types,
      routing: Object.fromEntries(Object.keys(types).map((t) => [t, ROUTING[t] ?? '未定（要確認）'])),
      unresolved_skus: unresolved,
      total_amount: total.toFixed(4),
      warnings: [...new Set(warnings)],
    };

    if (input.dry_run) return result;

    const batch = await this.db
      .insertInto('import_batches')
      .values({
        import_type: 'AMAZON_TRANSACTION',
        file_name: input.file_name,
        total_count: records.length,
        imported_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // 1,000件を超えるため、まとめて投入する。
    // 決済番号＋注文番号＋SKU＋日時が同じ行は同一とみなし、再取込では増やさない。
    const values = records
      // 種類のない行（空行や集計行）は取り込まない
      .filter((r) => need(r, 'トランザクションの種類') !== '')
      .map((r, i) => {
        const settlementNo = need(r, '決済番号');
        const orderNo = need(r, '注文番号');
        const skuCode = need(r, 'SKU');
        const transactedAt = this.toTimestamp(need(r, '日付/時間'));

        return {
          import_batch_id: batch.id,
          platform: 'Amazon',
          settlement_no: settlementNo || null,
          external_order_no: orderNo || `(${settlementNo || 'no-settlement'})-${i + 1}`,
          transaction_type: need(r, 'トランザクションの種類'),
          transaction_at: transactedAt,
          external_sku_code: skuCode || null,
          sku_id: skuCode ? (mapping.get(skuCode) ?? null) : null,
          description: need(r, '説明') || null,
          qty: this.num(need(r, '数量')),
          product_sales: this.num(need(r, '商品売上')),
          product_sales_tax: this.num(need(r, '商品の売上税')),
          shipping_fee: this.num(need(r, '配送料')),
          shipping_tax: this.num(need(r, '配送料の税金')),
          promo_discount: this.num(need(r, 'プロモーション割引額')),
          promo_discount_tax: this.num(need(r, 'プロモーション割引の税金')),
          points_cost: this.num(need(r, 'Amazonポイントの費用')),
          commission_fee: this.num(need(r, '手数料')),
          fba_fee: this.num(need(r, 'FBA 手数料')),
          other_fee: this.num(need(r, 'トランザクションに関するその他の手数料')),
          other_amount: this.num(need(r, 'その他')),
          total_amount: this.num(need(r, '合計')),
          raw_data: JSON.stringify(r) as unknown as object,
        };
      });

    const CHUNK = 200;
    for (let i = 0; i < values.length; i += CHUNK) {
      const inserted = await this.db
        .insertInto('platform_transactions')
        .values(values.slice(i, i + CHUNK))
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .execute();
      result.inserted += inserted.length;
    }
    result.skipped = values.length - result.inserted;

    await this.db
      .updateTable('import_batches')
      .set({ success_count: result.inserted, error_count: 0 })
      .where('id', '=', batch.id)
      .execute();

    this.logger.log(`Amazon決済レポート ${input.file_name}：${result.inserted} 件を登録`);
    return result;
  }

  /**
   * 種類ごとの集計。売上と経費の振り分けを画面で確認するためのもの。
   * 商品別の売上は自社SKUに読み替えたうえで積み上げる。
   */
  async summary(query: { from?: string; to?: string }) {
    let base = this.db.selectFrom('platform_transactions as t').where('t.platform', '=', 'Amazon');
    if (query.from) base = base.where('t.transaction_at', '>=', new Date(`${query.from}T00:00:00+09:00`));
    if (query.to) base = base.where('t.transaction_at', '<=', new Date(`${query.to}T23:59:59+09:00`));

    const byType = await base
      .select([
        't.transaction_type as transaction_type',
        sql<number>`count(*)::int`.as('rows'),
        sql<string>`coalesce(sum(t.total_amount),0)`.as('total_amount'),
        sql<string>`coalesce(sum(t.product_sales),0)`.as('product_sales'),
        sql<string>`coalesce(sum(t.commission_fee),0)`.as('commission_fee'),
        sql<string>`coalesce(sum(t.fba_fee),0)`.as('fba_fee'),
      ])
      .groupBy('t.transaction_type')
      .orderBy(sql`count(*)`, 'desc')
      .execute();

    const bySku = await base
      .leftJoin('skus as s', 's.id', 't.sku_id')
      .leftJoin('products as p', 'p.id', 's.product_id')
      .select([
        't.external_sku_code as amazon_sku',
        's.sku_code as sku_code',
        'p.product_name as product_name',
        sql<string>`coalesce(sum(t.qty),0)`.as('qty'),
        sql<string>`coalesce(sum(t.product_sales),0)`.as('product_sales'),
        sql<string>`coalesce(sum(t.total_amount),0)`.as('total_amount'),
      ])
      .where('t.transaction_type', 'in', ['注文', '返金'])
      .groupBy(['t.external_sku_code', 's.sku_code', 'p.product_name'])
      .orderBy(sql`coalesce(sum(t.product_sales),0)`, 'desc')
      .execute();

    return {
      routing: ROUTING,
      by_transaction_type: byType.map((r) => ({
        ...r,
        routed_to: ROUTING[r.transaction_type ?? ''] ?? '未定（要確認）',
      })),
      by_sku: bySku,
    };
  }

  /** 「2026/08/01 1:53:14 JST」を日時にする。読めなければ null。 */
  private toTimestamp(value: string): Date | null {
    const v = value.trim().replace(/\s*JST\s*$/, '');
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(v);
    if (!m) return null;
    const pad = (s: string) => s.padStart(2, '0');
    const dt = new Date(
      `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] ?? '00'}+09:00`,
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  private num(value: string): string | null {
    const v = value.replace(/[,\s¥￥]/g, '');
    if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return null;
    return v;
  }
}

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { CONSTRAINT_MESSAGES, UNIQUE_MESSAGES, skuJanTriggerMessage } from '../common/database-exception.filter';
import { decodeAuto, parseCsv } from '../imports/csv';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import {
  MASTER_CSV,
  MASTER_CSV_EXPORT_ONLY,
  MULTI_SEPARATOR,
  type CsvColumn,
  type MasterCsvDef,
  type MasterCsvExportOnly,
} from './masters-csv';
import { skuJanChecker } from './products.service';
import { IS_ROYALTY_HISTORY } from './royalty-rule-history';
import { readRuleGroup } from './royalty-rule-group';

/** 取り込みの下見・実行の結果。1行ごとに何が起きる（起きた）かを返す。 */
export interface ImportRowResult {
  /** CSV の行番号（見出しを 1 とする） */
  line: number;
  key: string;
  action: '追加' | '変更' | '変更なし' | 'エラー';
  /** 変更になる欄。「原価 1000 → 1200」の形 */
  changes: string[];
  /** エラーの理由。「欄名：理由」を「。」でつないだもの */
  message?: string;
}

export interface ImportResult {
  label: string;
  dry_run: boolean;
  encoding: string;
  /** CSV にあった見出しのうち、取り込みに使ったもの */
  used_columns: string[];
  ignored_columns: string[];
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  rows: ImportRowResult[];
}

/** 取り込みでこの人にできること（2026-10-12 受入 No.3 D-2）。 */
export interface ImportPermissions {
  /** 新しい行を作れるか（作成の権限） */
  canCreate: boolean;
  /** 有効→無効（非表示）にできるか（MasterCsvDef.deactivateAction の権限） */
  canDeactivate: boolean;
}

/** データベースの列の決まり。下見で確定と同じ検査をするために読む。 */
interface DbColumn {
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  hasDefault: boolean;
}

/** 1回で取り込める行数の上限。これを超えるCSVは分けてもらう。 */
const MAX_ROWS = 5000;
/** 確定で止めたとき、エラー文に並べる行の数 */
const MAX_ERRORS_IN_MESSAGE = 10;
/** どの表にもある、取り込みで触らない列 */
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** 整数の列の範囲（データベースの型ごと） */
const INT_RANGE: Record<string, [number, number]> = {
  smallint: [-32768, 32767],
  integer: [-2147483648, 2147483647],
};

/** 下見のときに、書いたものを最後に取り消すための合図 */
class DryRunRollback extends Error {}

/** 1行ぶんの書き込み */
interface PendingWrite {
  /** results の何番目か（データベースで弾かれたらその行をエラーにする） */
  resultIndex: number;
  line: number;
  values: Record<string, unknown>;
  existing: Record<string, unknown> | undefined;
  /** 書き換える欄（更新のとき）。追加のときは CSV に載っている欄すべて */
  fields: CsvColumn[];
}

@Injectable()
export class MastersCsvService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  /** 列の決まりは変わることがまれなので、しばらく覚えておく */
  private readonly metaCache = new Map<string, { at: number; cols: Map<string, DbColumn> }>();

  def(slug: string): MasterCsvDef {
    const d = MASTER_CSV[slug];
    if (!d) throw new NotFoundException(`${slug} は CSV に対応していません`);
    return d;
  }

  /** 書き出し・取り込みのどちらかができるマスタの、名前と権限の機能ID。 */
  meta(slug: string): { label: string; functionId: string; exportOnly: boolean } {
    const d = MASTER_CSV[slug];
    if (d) return { label: d.label, functionId: d.functionId, exportOnly: false };
    const e: MasterCsvExportOnly | undefined = MASTER_CSV_EXPORT_ONLY[slug];
    if (e) return { label: e.label, functionId: e.functionId, exportOnly: true };
    throw new NotFoundException(`${slug} は CSV に対応していません`);
  }

  /** 権限に応じて、出し入れしてよい欄だけに絞る。 */
  private columnsFor(def: MasterCsvDef, showSensitive: boolean): CsvColumn[] {
    return def.columns.filter((c) => !c.sensitive || showSensitive);
  }

  /** 表の列の決まり（文字数の上限・空にできるか・数の型）。 */
  private async dbColumns(table: string): Promise<Map<string, DbColumn>> {
    const hit = this.metaCache.get(table);
    if (hit && Date.now() - hit.at < 60_000) return hit.cols;
    const { rows } = await sql<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
    }>`
      select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
             is_nullable, column_default, is_identity
        from information_schema.columns
       where table_schema = current_schema() and table_name = ${table}
    `.execute(this.db);
    const cols = new Map<string, DbColumn>();
    for (const r of rows) {
      cols.set(r.column_name, {
        dataType: r.data_type,
        maxLength: r.character_maximum_length === null ? null : Number(r.character_maximum_length),
        precision: r.numeric_precision === null ? null : Number(r.numeric_precision),
        scale: r.numeric_scale === null ? null : Number(r.numeric_scale),
        nullable: r.is_nullable === 'YES',
        hasDefault: r.column_default !== null || r.is_identity === 'YES',
      });
    }
    this.metaCache.set(table, { at: Date.now(), cols });
    return cols;
  }

  /* ------------------------------------------------------------------ */
  /* 書き出し                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * CSV を組み立てる。Excel がそのまま開けるよう BOM 付き・CRLF で返す。
   *
   * 相手のマスタを指す欄は、内部の番号ではなくコードで書き出す。
   * そうしないと直して取り込むことができない。
   */
  async exportCsv(slug: string, includeInactive: boolean, showSensitive: boolean, scope?: string): Promise<string> {
    if (MASTER_CSV_EXPORT_ONLY[slug]) return this.exportOnly(slug, includeInactive);

    const def = this.def(slug);
    const cols = this.columnsFor(def, showSensitive);

    let q = this.db.selectFrom(def.table as never).selectAll();
    if (!includeInactive) q = q.where(sql`is_active`, '=', true) as typeof q;
    const sid = await this.scopeId(def, scope);
    if (sid !== undefined) q = q.where(sql.ref(def.scopeField!), '=', sid) as typeof q;
    const rows = (await q.execute()) as Record<string, unknown>[];

    // 参照先のコードをまとめて引く（行ごとに引くと件数ぶん問い合わせが飛ぶ）
    const codeOf = await this.buildCodeLookup(cols, rows);
    const multiOf = await this.buildMultiLookup(cols, rows);

    const cell = (c: CsvColumn, row: Record<string, unknown>): string => {
      const raw = row[c.field];
      if (c.multi) return excel(multiOf.get(`${c.field}:${Number(row.id)}`) ?? '');
      if (c.ref) {
        const id = raw === null || raw === undefined ? null : Number(raw);
        // コードは数字だけのこともある（カラー 03 など）。Excel に頭の 0 を落とされないよう ="..." で書く（受入 No.3 D-7）
        return excel(id === null ? '' : (codeOf.get(`${c.ref.table}:${id}`) ?? ''));
      }
      if (raw === null || raw === undefined) return '""';
      if (c.kind === 'bool') return esc(raw ? (c.boolLabels?.[0] ?? '有効') : (c.boolLabels?.[1] ?? '無効'));
      if (c.kind === 'date') return esc(dateText(raw));
      // JAN のような数字だけの文字列は、Excel が数値に直して頭の 0 を落としてしまう
      if (c.kind === 'digits' || c.excelText) return excel(String(raw));
      // 値を画面の言葉で書く欄（消費税免税区分の exempt →「免税（税抜扱い）」など）
      return esc(c.valueLabels?.[String(raw)] ?? String(raw));
    };

    // 並びは鍵の順。毎回同じ順で出れば、前回との差分が取りやすい
    const keyIdx = def.keyFields.map((f) => cols.findIndex((c) => c.field === f));
    const sorted = [...rows].sort((a, b) => {
      for (const i of keyIdx) {
        if (i < 0) continue;
        const f = cols[i].field;
        const x = String(a[f] ?? '');
        const y = String(b[f] ?? '');
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });

    const lines = [cols.map((c) => esc(c.label)).join(',')];
    for (const r of sorted) lines.push(cols.map((c) => cell(c, r)).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /**
   * 書き出し・一覧で編集の絞り込み（区分値をタブのカテゴリーだけにするなど）。
   * scope はコード。def.scopeField が指す相手のマスタでコードから番号を引く。絞らないときは undefined。
   */
  private async scopeId(def: MasterCsvDef, scope: string | undefined): Promise<number | undefined> {
    if (!scope || !def.scopeField) return undefined;
    const col = def.columns.find((c) => c.field === def.scopeField);
    if (!col?.ref) return undefined;
    const hit = (await this.db
      .selectFrom(col.ref.table as never)
      .select(sql<number>`id`.as('id'))
      .where(sql.ref(col.ref.codeColumn), '=', scope)
      .executeTakeFirst()) as { id: number } | undefined;
    return hit ? Number(hit.id) : -1;
  }

  /** 参照先の「番号 → コード」をまとめて作る。 */
  private async buildCodeLookup(
    cols: CsvColumn[],
    rows: Record<string, unknown>[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const c of cols) {
      if (!c.ref || c.multi) continue;
      const ids = [...new Set(rows.map((r) => r[c.field]).filter((v) => v !== null && v !== undefined).map(Number))];
      if (ids.length === 0) continue;
      const found = (await this.db
        .selectFrom(c.ref.table as never)
        .select([sql`id`.as('id'), sql.ref(c.ref.codeColumn).as('code')])
        .where(sql`id`, 'in', ids)
        .execute()) as { id: number; code: string }[];
      for (const f of found) out.set(`${c.ref!.table}:${Number(f.id)}`, f.code ?? '');
    }
    return out;
  }

  /**
   * 複数のコードを持つ欄（取引先カテゴリー）の「欄:行の番号 → "A、B"」を作る。
   * 代表（field の列）を先頭に、残りはひも付けた順。ひも付けが無く代表だけある古いデータは代表だけを出す。
   */
  private async buildMultiLookup(cols: CsvColumn[], rows: Record<string, unknown>[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const c of cols) {
      if (!c.multi || !c.ref) continue;
      const lists = await this.loadMultiIds(c, rows.map((r) => Number(r.id)));
      const allIds = new Set<number>();
      for (const r of rows) {
        const primary = r[c.field] === null || r[c.field] === undefined ? null : Number(r[c.field]);
        const list = orderedMulti(lists.get(Number(r.id)) ?? [], primary);
        list.forEach((x) => allIds.add(x));
        lists.set(Number(r.id), list);
      }
      const codes = await this.codesOfIds(c, [...allIds]);
      for (const r of rows) {
        const list = lists.get(Number(r.id)) ?? [];
        out.set(`${c.field}:${Number(r.id)}`, list.map((x) => codes.get(x) ?? String(x)).join(MULTI_SEPARATOR));
      }
    }
    return out;
  }

  /** ひも付けの表から「行の番号 → 相手の番号の並び」を読む。ids を省くと表全体を読む。 */
  private async loadMultiIds(c: CsvColumn, ids?: number[]): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    if (!c.multi) return out;
    if (ids && ids.length === 0) return out;
    let q = this.db
      .selectFrom(c.multi.linkTable as never)
      .select([sql.ref(c.multi.ownerColumn).as('owner'), sql.ref(c.multi.refColumn).as('ref')])
      .orderBy(sql`id`);
    if (ids) q = q.where(sql.ref(c.multi.ownerColumn), 'in', ids) as typeof q;
    for (const r of (await q.execute()) as { owner: number; ref: number }[]) {
      const k = Number(r.owner);
      const list = out.get(k) ?? [];
      list.push(Number(r.ref));
      out.set(k, list);
    }
    return out;
  }

  private async codesOfIds(c: CsvColumn, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!c.ref || ids.length === 0) return out;
    const found = (await this.db
      .selectFrom(c.ref.table as never)
      .select([sql`id`.as('id'), sql.ref(c.ref.codeColumn).as('code')])
      .where(sql`id`, 'in', ids)
      .execute()) as { id: number; code: string }[];
    for (const f of found) out.set(Number(f.id), f.code ?? '');
    return out;
  }

  /**
   * 書き出しだけのマスタ（ロイヤリティ規定・セット・ユーザー。2026-10-12 受入 No.2・No.3）。
   * 1件が中では複数の行にまたがるので、画面の1件を CSV の1行（セットは構成品ごとに1行）にする。
   * ユーザーのパスワードは出さない。
   */
  private async exportOnly(slug: string, includeInactive: boolean): Promise<string> {
    let header: string[] = [];
    let body: string[][] = [];

    if (slug === 'royalty-rules') {
      header = [
        '支払先コード', '支払先名', '媒体コード', '媒体名', 'ブランドコード', '商品コード', '対象外の商品コード', '販売先の指定',
        '販売先コード', '計算の基準', '料率', '定額', '適用開始日', '適用終了日', '並び順', '備考', '有効',
      ];
      const { rows } = await sql<{
        gid: number; rule_group_id: number | null; payee_code: string; payee_name: string;
        media_code: string | null; media_name: string | null; brand_code: string | null; product_code: string | null;
        customer_partner_id: number | null; product_id: number | null;
        customer_code: string | null; is_excluded: boolean; calc_base: string; rate: string | null;
        fixed_amount: string | null; valid_from: unknown; valid_to: unknown; sort_order: number | null;
        note: string | null; is_active: boolean;
      }>`
        select coalesce(r.rule_group_id, r.id) as gid, r.rule_group_id, payee.partner_code as payee_code,
               payee.name1 as payee_name, md.code as media_code, md.name as media_name, b.code as brand_code,
               p.product_code, r.customer_partner_id, r.product_id,
               cust.partner_code as customer_code, r.is_excluded, r.calc_base, r.rate,
               r.fixed_amount, r.valid_from, r.valid_to, r.sort_order, r.note, r.is_active
          from royalty_rules r
          join partners payee on payee.id = r.payee_partner_id
          left join media md on md.id = r.media_id
          left join brands b on b.id = r.brand_id
          left join products p on p.id = r.product_id
          left join partners cust on cust.id = r.customer_partner_id
         -- 編集で外れた「編集前の版」の行は、計算の根拠として残しているだけなので出さない（一覧と同じ）
         where not ${IS_ROYALTY_HISTORY}
         order by payee.partner_code, r.valid_from desc, coalesce(r.rule_group_id, r.id), r.is_excluded, r.id
      `.execute(this.db);
      // 一覧と同じ読み方で、まとまりを1件にする
      const groups = new Map<number, typeof rows>();
      for (const r of rows) {
        const g = groups.get(Number(r.gid)) ?? [];
        g.push(r);
        groups.set(Number(r.gid), g);
      }
      for (const bucket of groups.values()) {
        const head = bucket.find((r) => r.rule_group_id === null) ?? bucket[0];
        if (!includeInactive && !head.is_active) continue;
        // 販売先の指定・対象の商品・対象外の商品は一覧と同じ読み方（royalty-rule-group.ts。M3-33）
        const spec = readRuleGroup(bucket);
        const customerCode = new Map(bucket.map((r) => [Number(r.customer_partner_id), r.customer_code ?? '']));
        const productCode = new Map(bucket.map((r) => [Number(r.product_id), r.product_code ?? '']));
        const codes = (ids: number[], m: Map<number, string>) => ids.map((id) => m.get(id) ?? '').join(MULTI_SEPARATOR);
        body.push([
          xlCell(head.payee_code), head.payee_name, xlCell(head.media_code), head.media_name ?? '',
          xlCell(head.brand_code), xlCell(codes(spec.productIds, productCode)),
          xlCell(codes(spec.excludedProductIds, productCode)), spec.mode,
          xlCell(codes(spec.customerIds, customerCode)),
          // 計算の基準は請求月に統一（中の値は売上。M3-32）
          head.calc_base === '売上' ? '請求月' : head.calc_base, head.rate ?? '',
          head.fixed_amount ?? '', dateText(head.valid_from), dateText(head.valid_to),
          head.sort_order === null ? '' : String(head.sort_order), head.note ?? '', head.is_active ? '有効' : '無効',
        ]);
      }
    } else if (slug === 'sets') {
      header = ['セットSKUコード', 'セットの商品名', '構成品SKUコード', '構成品の商品名', '構成数', '並び順', '備考', '有効'];
      const { rows } = await sql<{
        set_sku: string; set_name: string; comp_sku: string | null; comp_name: string | null; qty: string | null;
        sort_order: number | null; note: string | null; is_active: boolean;
      }>`
        select s.sku_code as set_sku, coalesce(nullif(btrim(s.sku_name), ''), p.product_name) as set_name,
               cs.sku_code as comp_sku, coalesce(nullif(btrim(cs.sku_name), ''), cp.product_name) as comp_name,
               c.qty, c.sort_order, h.note, h.is_active
          from set_headers h
          join skus s on s.id = h.sku_id
          join products p on p.id = s.product_id
          left join set_components c on c.set_header_id = h.id
          left join skus cs on cs.id = c.component_sku_id
          left join products cp on cp.id = cs.product_id
         where (${includeInactive} or h.is_active)
         order by s.sku_code, c.sort_order nulls last, c.id
      `.execute(this.db);
      body = rows.map((r) => [
        xlCell(r.set_sku), r.set_name, xlCell(r.comp_sku), r.comp_name ?? '', r.qty === null ? '' : String(Number(r.qty)),
        r.sort_order === null ? '' : String(r.sort_order), r.note ?? '', r.is_active ? '有効' : '無効',
      ]);
    } else if (slug === 'users') {
      header = ['ログインID', '氏名', 'メールアドレス', '役割', '有効'];
      // パスワード（password_hash）は出さない
      const { rows } = await sql<{ login_id: string; name: string; email: string | null; roles: string | null; is_active: boolean }>`
        select u.login_id, u.name, u.email, u.is_active,
               string_agg(r.name, ${MULTI_SEPARATOR} order by r.sort_order nulls last, r.id) as roles
          from users u
          left join user_roles ur on ur.user_id = u.id
          left join roles r on r.id = ur.role_id
         where (${includeInactive} or u.is_active)
         group by u.id
         order by u.login_id
      `.execute(this.db);
      body = rows.map((r) => [xlCell(r.login_id), r.name, r.email ?? '', r.roles ?? '', r.is_active ? '有効' : '無効']);
    } else {
      throw new NotFoundException(`${slug} は CSV に対応していません`);
    }

    // xlCell で ="..." にしたものはそのまま、ほかは "..." で囲む
    const cellOut = (v: string): string => (v.startsWith(XL_MARK) ? v.slice(XL_MARK.length) : esc(v));
    const lines = [header.map(esc).join(','), ...body.map((r) => r.map(cellOut).join(','))];
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /**
   * 一覧内編集のための行を返す（2026-10-01 ご要望「一覧に全ての項目を表示し、一覧内で編集ができるように」）。
   *
   * CSV と**同じ欄・同じ見方**で返します。相手のマスタはコードで返すので、
   * 画面はそのまま打ち直して保存でき、保存は取り込みと同じ道を通ります。
   */
  async gridRows(
    slug: string,
    opts: { includeInactive: boolean; showSensitive: boolean; q?: string; limit: number; offset: number; scope?: string },
  ) {
    const def = this.def(slug);
    const cols = this.columnsFor(def, opts.showSensitive);

    let base = this.db.selectFrom(def.table as never);
    if (!opts.includeInactive) base = base.where(sql`is_active`, '=', true) as typeof base;
    const sid = await this.scopeId(def, opts.scope);
    if (sid !== undefined) base = base.where(sql.ref(def.scopeField!), '=', sid) as typeof base;
    if (opts.q) {
      // 文字の欄をまとめて探す。数値・日付の欄は対象にしない
      const like = `%${opts.q}%`;
      const textCols = cols.filter((c) => !c.ref && (c.kind === undefined || c.kind === 'text' || c.kind === 'digits'));
      if (textCols.length > 0) {
        base = base.where((eb) =>
          eb.or(textCols.map((c) => eb(sql.ref(c.field), 'ilike', like))),
        ) as typeof base;
      }
    }

    const counted = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    let ordered = base.selectAll();
    for (const k of def.keyFields) ordered = ordered.orderBy(sql.ref(k)) as typeof ordered;
    const rows = (await ordered.limit(opts.limit).offset(opts.offset).execute()) as Record<string, unknown>[];

    const codeOf = await this.buildCodeLookup(cols, rows);
    const multiOf = await this.buildMultiLookup(cols, rows);
    const items = rows.map((r) => {
      const out: Record<string, unknown> = { id: Number(r.id) };
      for (const c of cols) {
        const raw = r[c.field];
        if (c.multi) {
          out[c.field] = multiOf.get(`${c.field}:${Number(r.id)}`) ?? '';
        } else if (c.ref) {
          const id = raw === null || raw === undefined ? null : Number(raw);
          out[c.field] = id === null ? '' : (codeOf.get(`${c.ref.table}:${id}`) ?? '');
        } else if (raw === null || raw === undefined) {
          out[c.field] = '';
        } else if (c.kind === 'bool') {
          out[c.field] = Boolean(raw);
        } else if (c.kind === 'date') {
          out[c.field] = dateText(raw);
        } else {
          out[c.field] = c.valueLabels?.[String(raw)] ?? String(raw);
        }
      }
      return out;
    });

    return {
      label: def.label,
      key_fields: def.keyFields,
      columns: cols.map((c) => ({
        field: c.field,
        label: c.label,
        kind: c.kind ?? 'text',
        ref: c.ref?.label ?? null,
        read_only: c.readOnly ?? false,
        multi: Boolean(c.multi),
        // 値を言葉で書く欄は、選べる値も言葉で見せる（入れるのは言葉）
        options: c.options?.map((o) => c.valueLabels?.[String(o)] ?? o) ?? null,
        options_label: c.optionsLabel ?? null,
      })),
      items,
      total: Number(counted.n),
      limit: opts.limit,
      offset: opts.offset,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 取り込み                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * CSV を取り込む。`dryRun` なら何も書かずに「こうなります」だけを返す。
   *
   * 決めごと：
   *   - **CSV に載っている列だけ**を書き換える。載っていない列には触らない
   *   - 鍵が一致する行があれば更新、無ければ追加
   *   - 1行でも読めない行があれば、実行はせずに全部やめる（途中まで入った状態を作らない）
   *   - **下見で通ったものは確定でも通る**（2026-10-12 受入 No.3 D-3）。そのために下見でも
   *     実際に書いてみて、最後に取り消す。データベースが弾くもの（文字数・決まり・重なり）も下見で分かる
   *   - 追加は「作成」、有効→無効は「削除」（画面の「使わない」と同じ）の権限が要る（D-2）
   */
  async importCsv(
    slug: string,
    contentBase64: string,
    dryRun: boolean,
    showSensitive: boolean,
    userId: number,
    perms: ImportPermissions,
  ): Promise<ImportResult> {
    const def = this.def(slug);
    const cols = this.columnsFor(def, showSensitive);
    const dbCols = await this.dbColumns(def.table);

    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('ファイルが空です');
    const { text, encoding } = decodeAuto(bytes);
    const table = parseCsv(text);
    if (table.length === 0) throw new BadRequestException('中身がありません');

    const header = table[0].map((h) => h.trim());
    // 中身の無い行（Excel が末尾に足す ,,,, だけの行）は数えない
    const body = table
      .slice(1)
      .map((cells, i) => ({ cells, line: i + 2 }))
      .filter((r) => r.cells.some((c) => c.trim() !== ''));
    if (body.length === 0) throw new BadRequestException('見出しだけで、中身の行がありません');
    if (body.length > MAX_ROWS) {
      throw new BadRequestException(`一度に取り込めるのは${MAX_ROWS}行までです（${body.length}行ありました）`);
    }

    // 見出しを欄に対応づける
    // 別名の見出し（呼び名を変えた欄の新しい名前。M3-16）でも同じ欄として読む
    const byLabel = new Map(cols.flatMap((c) => [c.label, ...(c.aliases ?? [])].map((l) => [l, c] as const)));
    // 前の書式の見出し（SKU の CSV の「SKUコード」「商品コード」）。見出し行に目印があれば前の意味で読む（2026-10-18 受入 W2）
    if (def.legacyHeaders && header.includes(def.legacyHeaders.marker)) {
      for (const [label, field] of Object.entries(def.legacyHeaders.labels)) {
        const c = cols.find((x) => x.field === field);
        if (c) byLabel.set(label, c);
      }
    }
    const mapped: { index: number; col: CsvColumn }[] = [];
    const ignored: string[] = [];
    for (let i = 0; i < header.length; i++) {
      const c = byLabel.get(header[i]);
      if (c && !mapped.some((m) => m.col.field === c.field)) mapped.push({ index: i, col: c });
      else if (header[i] !== '') ignored.push(header[i]);
    }

    // 鍵の欄がそろっているか。見出しに無くてもよい鍵（得意先別商品の先方の商品コード。M3-26）は数えない
    const optionalKeys = new Set(def.optionalKeyFields ?? []);
    const missingKeys = def.keyFields.filter((f) => !optionalKeys.has(f) && !mapped.some((m) => m.col.field === f));
    if (missingKeys.length > 0) {
      const labels = missingKeys.map((f) => cols.find((c) => c.field === f)?.label ?? f);
      throw new BadRequestException(
        `見出しに「${labels.join('」「')}」がありません。書き出した CSV の見出し行はそのまま残してください`,
      );
    }
    if (mapped.every((m) => def.keyFields.includes(m.col.field))) {
      throw new BadRequestException('書き換える欄がありません。鍵の列だけでは取り込めません');
    }
    const mappedCols = mapped.map((m) => m.col);

    // 参照先のコード → 番号 をまとめて引く
    const idOf = await this.buildIdLookup(mappedCols);
    // 番号 → コード。行全体の決まり（rowCheck）は CSV に無い欄の今の値も見るので、参照する欄すべてで引く
    // （仕入品目で「税率」だけを直すと、税区分を引けずに食い違いの検査を飛ばしていた。再テスト R4）
    const codeLookup = def.rowCheck ? await this.buildIdLookup(cols.filter((c) => c.ref)) : idOf;
    // 区分値「通貨」のコード（取引先の通貨の検査に使う）
    const currencies = new Set(
      (
        await this.db
          .selectFrom('codes as c')
          .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
          .select('c.code as code')
          .where('cc.code', '=', 'CURRENCY')
          .execute()
      ).map((r) => r.code),
    );
    const codeById = new Map<string, string>();
    for (const [k, id] of codeLookup) {
      const table = k.slice(0, k.indexOf(':'));
      if (!codeById.has(`${table}:${id}`)) codeById.set(`${table}:${id}`, k.slice(k.lastIndexOf(':') + 1));
    }

    // 今あるデータを鍵で引けるようにする
    const existing = (await this.db.selectFrom(def.table as never).selectAll().execute()) as Record<string, unknown>[];
    // 複数のコードを持つ欄は、今のひも付けを読んでおく（代表を先頭にした並び）
    for (const c of mappedCols.filter((x) => x.multi)) {
      const lists = await this.loadMultiIds(c);
      for (const r of existing) {
        const primary = r[c.field] === null || r[c.field] === undefined ? null : Number(r[c.field]);
        r[multiKey(c)] = orderedMulti(lists.get(Number(r.id)) ?? [], primary);
      }
    }
    // 突き合わせに使う鍵は、見出しにあるものだけ（見出しに無くてもよい鍵が無いときは、残りの鍵で突き合わせる）
    const keyCols = def.keyFields.filter((f) => mapped.some((m) => m.col.field === f)).map((f) => cols.find((c) => c.field === f)!);
    const keyOfRow = (row: Record<string, unknown>): string =>
      keyCols
        .map((c) => {
          const v = row[c.field];
          if (!c.ref) return String(v ?? '');
          const id = v === null || v === undefined ? null : Number(v);
          return id === null ? '' : String(id);
        })
        .join('\u0001');
    // 鍵が同じ行が2つ以上ありうる（見出しに無い鍵があるとき）。その鍵の行は1つに決められないのでエラーにする
    const byKey = new Map<string, Record<string, unknown>[]>();
    for (const r of existing) {
      const k = keyOfRow(r);
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    // SKU の JAN の左6桁ルール（No.16）。引き金でも止まるが、下見の段階で行ごとに相手の品番・SKU を出す
    const janProblem = def.table === 'skus' ? await skuJanChecker(this.db, existing) : null;

    // 鍵のほかに重なってはいけない欄の組（空欄は数えない）
    const uniqueSets = (def.unique ?? []).filter((set) => set.every((f) => cols.some((c) => c.field === f)));
    const uniqueKey = (set: string[], row: Record<string, unknown>): string | null => {
      const parts = set.map((f) => row[f]);
      if (parts.some((p) => p === null || p === undefined || p === '')) return null;
      return parts.map((p) => String(p)).join('\u0001');
    };
    const uniqueTaken = uniqueSets.map((set) => {
      const m = new Map<string, number>();
      for (const r of existing) {
        const k = uniqueKey(set, r);
        if (k !== null) m.set(k, Number(r.id));
      }
      return m;
    });
    const uniqueInFile = uniqueSets.map(() => new Map<string, number>());

    const results: ImportRowResult[] = [];
    const writes: PendingWrite[] = [];
    const seenKeys = new Map<string, number>();
    const deactivateLabel = def.deactivateAction === 'delete' ? '削除' : '更新';

    for (const { cells: raw, line } of body) {
      const values: Record<string, unknown> = {};
      const problems: string[] = [];
      // 「有効」の欄が空の行。追加なら「有効」、今ある行なら今のまま（下で isNew が分かってから決める）
      let activeBlank = false;

      for (const { index, col } of mapped) {
        const cellText = (raw[index] ?? '').trim();
        if (col.field === 'is_active' && unwrapExcel(cellText) === '') {
          activeBlank = true;
          continue;
        }
        try {
          values[col.field] = this.parseCell(cellText, col, idOf);
        } catch (e) {
          problems.push(`${col.label}：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const keyText = keyCols
        .map((c) => {
          const i = mapped.find((m) => m.col.field === c.field)!.index;
          return `${c.label}=${unwrapExcel((raw[i] ?? '').trim())}`;
        })
        .join(' / ');
      const fail = (msgs: string[]) =>
        results.push({ line, key: keyText, action: 'エラー', changes: [], message: msgs.join('。') });

      if (problems.length > 0) {
        fail(problems);
        continue;
      }
      const emptyKeys = keyCols.filter(
        (c) => !optionalKeys.has(c.field) && (values[c.field] === null || values[c.field] === undefined || values[c.field] === ''),
      );
      if (emptyKeys.length > 0) {
        fail(emptyKeys.map((c) => `${c.label}：鍵の欄なので空にはできません`));
        continue;
      }

      const key = keyOfRow(values);
      const firstLine = seenKeys.get(key);
      if (firstLine !== undefined) {
        fail([`${keyCols.map((c) => c.label).join('・')}：${firstLine}行目と同じです。1つのファイルに同じ行は1回だけ入れてください`]);
        continue;
      }
      seenKeys.set(key, line);

      const hits = byKey.get(key) ?? [];
      if (hits.length > 1) {
        const missing = def.keyFields
          .filter((f) => !keyCols.some((c) => c.field === f))
          .map((f) => cols.find((c) => c.field === f)?.label ?? f);
        fail([
          `${keyCols.map((c) => c.label).join('・')}が同じ行が${hits.length}件あり、どの行を直すか決められません。` +
            (missing.length > 0 ? `見出しに「${missing.join('」「')}」の列を入れてください` : '画面の編集で直してください'),
        ]);
        continue;
      }
      const found = hits[0] as Record<string, unknown> | undefined;
      const isNew = !found;
      // 「有効」を空にした行: 追加の行は「使わない」で作ると一覧に出ず気付けないので「有効」で作る（再テスト R1 N1）
      if (activeBlank) values.is_active = isNew ? true : found!.is_active;

      // 何が変わるかを見る（鍵と readOnly の欄は比べない）。追加のときは載っている欄すべて
      const touched: CsvColumn[] = [];
      const changes: string[] = [];
      for (const col of mappedCols) {
        if (col.readOnly || def.keyFields.includes(col.field)) {
          if (isNew) touched.push(col);
          continue;
        }
        if (isNew) {
          touched.push(col);
          continue;
        }
        const before = col.multi ? found![multiKey(col)] : found![col.field];
        const after = values[col.field];
        if (!this.sameValue(before, after, col)) {
          touched.push(col);
          changes.push(`${col.label} ${this.show(before, col, codeById)} → ${this.show(after, col, codeById)}`);
        }
      }

      // 値の検査。変える欄（追加なら全部）だけを見る。昔から入っている値で取込が止まらないように
      for (const col of touched) {
        const msg = this.checkValue(values[col.field], col, dbCols.get(col.field), isNew);
        if (msg) problems.push(`${col.label}：${msg}`);
      }
      if (isNew) {
        // データベースで空にできず、決まった初期値も無い列は、追加のときに要る
        for (const [name, meta] of dbCols) {
          if (SYSTEM_COLUMNS.has(name) || meta.nullable || meta.hasDefault) continue;
          const col = mappedCols.find((c) => c.field === name);
          if (col) continue; // 空なら上の checkValue で「必須」になる
          if (def.columns.some((c) => c.field === name && c.blankAsEmpty)) continue; // 空の文字で入れる
          if (def.filled?.includes(name)) continue; // 下の complete で埋める（作業指示内容の名称。M3-40）
          const label = cols.find((c) => c.field === name)?.label;
          problems.push(
            label
              ? `${label}：新しい行を作るには、この列が要ります（見出しに「${label}」がありません）`
              : `新しい行は CSV では作れません（${name} を入れる列がありません）。画面の「新規登録」をお使いください`,
          );
        }
      }

      // 権限（2026-10-12 受入 No.3 D-2）。画面で「新規登録」・編集画面の「表示／非表示」ができない人は CSV でもできない
      if (isNew && !perms.canCreate) {
        problems.push(`新しい行の追加：${def.label}マスタの「作成」の権限がありません（画面の「新規登録」と同じ権限が要ります）`);
      }
      if (!isNew && touched.some((c) => c.field === 'is_active') && found!.is_active === true && values.is_active === false) {
        if (!perms.canDeactivate) {
          problems.push(`有効：「無効」（非表示）にするには${def.label}マスタの「${deactivateLabel}」の権限が要ります`);
        }
      }

      const janMessage = janProblem?.(values, found) ?? null;
      if (janMessage) problems.push(`JANコード：${janMessage}`);

      // 行全体の決まりと、重なってはいけない欄
      const merged: Record<string, unknown> = { ...(found ?? {}) };
      for (const col of mappedCols) {
        const v = values[col.field];
        merged[col.field] = col.multi ? ((v as number[] | null)?.[0] ?? null) : v;
      }
      const rowCtx = {
        isNew,
        currencies,
        codeOf: (field: string) => {
          const c = cols.find((x) => x.field === field);
          const v = merged[field];
          if (!c?.ref || v === null || v === undefined) return null;
          return codeById.get(`${c.ref.table}:${Number(v)}`) ?? null;
        },
      };
      // 行から決まる欄を補う（CSV に列が無くても書く）
      if (def.complete && (isNew || touched.length > 0)) {
        const extra = def.complete(merged, { ...rowCtx, touched: new Set(touched.map((c) => c.field)) });
        for (const [field, v] of Object.entries(extra)) {
          // CSV の欄に無い列も書ける（取引先の「海外」を消費税免税区分からそろえるなど。M3-07）。
          // 欄にあっても見せていない欄（原価など）は書かない
          const col =
            cols.find((x) => x.field === field) ??
            (def.columns.some((x) => x.field === field) ? undefined : ({ field, label: field } as CsvColumn));
          if (!col) continue;
          values[field] = v;
          merged[field] = v;
          if (!touched.includes(col)) touched.push(col);
        }
      }
      if (def.rowCheck && (isNew || touched.length > 0)) {
        problems.push(...def.rowCheck(merged, rowCtx));
      }
      uniqueSets.forEach((set, i) => {
        if (!isNew && !touched.some((c) => set.includes(c.field))) return;
        const k = uniqueKey(set, merged);
        if (k === null) return;
        const labels = set.map((f) => cols.find((c) => c.field === f)?.label ?? f).join('・');
        const other = uniqueTaken[i].get(k);
        const inFile = uniqueInFile[i].get(k);
        if (other !== undefined && other !== Number(found?.id ?? -1)) {
          problems.push(`${labels}：同じ組み合わせがすでに登録されています`);
        } else if (inFile !== undefined) {
          problems.push(`${labels}：${inFile}行目と同じ組み合わせです`);
        } else {
          uniqueInFile[i].set(k, line);
        }
      });

      if (problems.length > 0) {
        fail(problems);
        continue;
      }
      if (isNew) {
        results.push({ line, key: keyText, action: '追加', changes: [] });
        writes.push({ resultIndex: results.length - 1, line, values, existing: undefined, fields: touched });
      } else if (changes.length === 0) {
        results.push({ line, key: keyText, action: '変更なし', changes: [] });
      } else {
        results.push({ line, key: keyText, action: '変更', changes });
        writes.push({ resultIndex: results.length - 1, line, values, existing: found, fields: touched });
      }
    }

    // 確定のときに下見の段階で弾けるものがあれば、書かずにやめる
    if (!dryRun && results.some((x) => x.action === 'エラー')) {
      throw this.failure(results);
    }

    // 書いてみる。1行ずつ区切り（savepoint）を置き、データベースが弾いた行はその行のエラーにして続ける。
    // 下見は最後に全部取り消す。確定は1行でも弾かれたら全部取り消す（途中まで入った状態を作らない）
    if (writes.length > 0) {
      try {
        await this.db.transaction().execute(async (trx) => {
          for (const w of writes) {
            await sql`savepoint csv_row`.execute(trx);
            try {
              await this.writeRow(trx, def, w, userId, dbCols);
              await sql`release savepoint csv_row`.execute(trx);
            } catch (e) {
              await sql`rollback to savepoint csv_row`.execute(trx);
              const r = results[w.resultIndex];
              r.action = 'エラー';
              r.changes = [];
              r.message = this.describeDbError(e, cols);
            }
          }
          if (dryRun || results.some((x) => x.action === 'エラー')) throw new DryRunRollback();
        });
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e;
      }
    }

    const errors = results.filter((x) => x.action === 'エラー').length;
    if (!dryRun && errors > 0) throw this.failure(results);

    return {
      label: def.label,
      dry_run: dryRun,
      encoding,
      used_columns: mapped.map((m) => m.col.label),
      ignored_columns: ignored,
      added: results.filter((x) => x.action === '追加').length,
      updated: results.filter((x) => x.action === '変更').length,
      unchanged: results.filter((x) => x.action === '変更なし').length,
      errors,
      rows: results,
    };
  }

  /** 確定できなかったときの 400。どの行のどの欄かが分かるように並べる（受入 No.3 D-3）。 */
  private failure(results: ImportRowResult[]): BadRequestException {
    const bad = results.filter((x) => x.action === 'エラー');
    // 一覧で編集から保存したときは行番号が画面に見えないので、どの行か分かるよう鍵も添える
    const shown = bad.slice(0, MAX_ERRORS_IN_MESSAGE).map((x) => `${x.line}行目（${x.key}） ${x.message ?? ''}`);
    const more = bad.length > MAX_ERRORS_IN_MESSAGE ? `　ほか ${bad.length - MAX_ERRORS_IN_MESSAGE} 行` : '';
    return new BadRequestException({
      statusCode: 400,
      message: `取り込めない行が ${bad.length} 行あります。直してからもう一度お試しください（何も書き換えていません）。${shown.join('／')}${more}`,
      rows: bad,
    });
  }

  /** 1行を書く。更新は変わる欄だけ。複数のコードを持つ欄はひも付けを入れ替え、代表もそろえる。 */
  private async writeRow(
    trx: ConyDatabase,
    def: MasterCsvDef,
    w: PendingWrite,
    userId: number,
    dbCols: Map<string, DbColumn>,
  ): Promise<void> {
    const plain: Record<string, unknown> = {};
    const multis: CsvColumn[] = [];
    for (const col of w.fields) {
      const v = w.values[col.field];
      if (col.multi) {
        multis.push(col);
        plain[col.field] = (v as number[] | null)?.[0] ?? null;
        continue;
      }
      if (col.readOnly && w.existing) continue;
      // 追加で空欄のとき、データベースに初期値がある列は初期値に任せる（入れると「空にできません」になる）
      const meta = dbCols.get(col.field);
      if (!w.existing && (v === null || v === undefined) && meta?.hasDefault && !meta.nullable) continue;
      plain[col.field] = v;
    }

    // 空でもよい欄（作業指示の本文など）が CSV に無いまま追加するときは、空の文字で入れる
    if (!w.existing) {
      for (const c of def.columns) if (c.blankAsEmpty && !(c.field in plain)) plain[c.field] = '';
    }

    let id: number;
    if (w.existing) {
      id = Number(w.existing.id);
      await trx
        .updateTable(def.table as never)
        .set({ ...plain, updated_by: userId, updated_at: new Date() } as never)
        .where(sql`id`, '=', id)
        .execute();
    } else {
      const row = (await trx
        .insertInto(def.table as never)
        .values({ ...plain, created_by: userId, updated_by: userId } as never)
        .returning(sql<number>`id`.as('id'))
        .executeTakeFirstOrThrow()) as { id: number };
      id = Number(row.id);
    }

    // 取引先カテゴリー（複数）：ひも付けを丸ごと入れ替える。CSV で作った取引先も入る（受入 No.8）
    for (const col of multis) {
      if (!col.multi) continue;
      const ids = [...new Set((w.values[col.field] as number[] | null) ?? [])];
      await trx.deleteFrom(col.multi.linkTable as never).where(sql.ref(col.multi.ownerColumn), '=', id).execute();
      if (ids.length === 0) continue;
      await trx
        .insertInto(col.multi.linkTable as never)
        .values(
          ids.map((cid) => ({ [col.multi!.ownerColumn]: id, [col.multi!.refColumn]: cid, created_by: userId })) as never,
        )
        .execute();
    }
  }

  /** データベースが弾いた理由を「欄名：理由」にする。データベース以外の失敗はそのまま投げ直す。 */
  private describeDbError(e: unknown, cols: CsvColumn[]): string {
    const pg = e as { code?: string; constraint?: string; column?: string; detail?: string; message?: string };
    if (typeof pg.code !== 'string' || pg.code.length !== 5) throw e;
    const labelOf = (name: string | undefined): string => cols.find((c) => c.field === name)?.label ?? name ?? '';
    const constraint = pg.constraint ?? '';
    switch (pg.code) {
      case '23505': {
        // JAN の左6桁ルールの引き金は相手の品番を入れて断るので、その文言を使う（No.16）
        const jan = skuJanTriggerMessage(pg);
        if (jan) return `JANコード：${jan}`;
        const fields = /Key \(([^)]+)\)/.exec(pg.detail ?? '')?.[1]?.split(',').map((s) => labelOf(s.trim())) ?? [];
        const msg = UNIQUE_MESSAGES[constraint] ?? '同じ値がすでに登録されています';
        return fields.length > 0 ? `${fields.join('・')}：${msg}` : msg;
      }
      case '23502':
        return `${labelOf(pg.column)}：空にはできません`;
      case '23514':
        return CONSTRAINT_MESSAGES[constraint] ?? `入力内容が決まりに合いません（${constraint}）`;
      case '23503':
        return '指定したコードのデータが見つかりません';
      case '22001':
        return '文字数が多すぎます';
      case '22003':
        return '数値が大きすぎます';
      case '22007':
      case '22008':
        return '日付が正しくありません';
      case '22P02':
        return '値の形が正しくありません';
      default:
        // 引き金（JAN の決まりなど）が出す文言は日本語で書いてあるのでそのまま出す
        return pg.code === 'P0001' && pg.message ? pg.message : `保存できませんでした（${pg.code}${constraint ? ' ' + constraint : ''}）`;
    }
  }

  /** 参照先の「コード → 番号」をまとめて作る。 */
  private async buildIdLookup(cols: CsvColumn[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const c of cols) {
      if (!c.ref) continue;
      let q = this.db
        .selectFrom(c.ref.table as never)
        .select([sql`id`.as('id'), sql.ref(c.ref.codeColumn).as('code')]);
      if (c.ref.codeCategory) {
        q = q.where(
          sql`code_category_id`,
          '=',
          sql`(select id from code_categories where code = ${c.ref.codeCategory})`,
        ) as typeof q;
      }
      const rows = (await q.execute()) as { id: number; code: string }[];
      for (const r of rows) out.set(`${c.ref.table}:${c.ref.codeCategory ?? ''}:${r.code}`, Number(r.id));
    }
    return out;
  }

  /**
   * CSV の1マスを、データベースに入れる値に直す。読めなければ理由を投げる（欄名は呼ぶ側で付ける）。
   */
  private parseCell(text: string, col: CsvColumn, idOf: Map<string, number>): unknown {
    // 書き出した ="12345" の形を外す
    const v = unwrapExcel(text);

    if (col.multi && col.ref) {
      // 「、」で区切る。Excel や手入力で入りやすい「|」「,」も受ける
      const codes = v.split(/[、,，|｜]/).map((x) => x.trim()).filter((x) => x !== '');
      const ids: number[] = [];
      const missing: string[] = [];
      for (const code of codes) {
        const id = idOf.get(`${col.ref.table}:${col.ref.codeCategory ?? ''}:${code}`);
        if (id === undefined) missing.push(code);
        else if (!ids.includes(id)) ids.push(id);
      }
      if (missing.length > 0) throw new Error(`「${missing.join('」「')}」は${col.ref.label}マスタにありません`);
      return ids;
    }

    if (col.ref) {
      if (v === '') return null;
      const id = idOf.get(`${col.ref.table}:${col.ref.codeCategory ?? ''}:${v}`);
      if (id === undefined) {
        throw new Error(`「${v}」は${col.ref.label}マスタにありません`);
      }
      return id;
    }

    // ○×の欄は空欄なら「無効」（×）。追加の行で空にすると「必須」で止まっていた（受入 No.3 D-3）
    if (col.kind === 'bool') {
      // 「対象／対象外」のように言葉を決めた欄は、その言葉も受ける（下代調整対象。M3-23）
      if (col.boolLabels && v === col.boolLabels[0]) return true;
      if (col.boolLabels && v === col.boolLabels[1]) return false;
      if (['有効', '○', '〇', '◯', 'TRUE', 'true', '1', 'はい'].includes(v)) return true;
      if (['無効', '×', '', 'FALSE', 'false', '0', 'いいえ'].includes(v)) return false;
      throw new Error(`「${col.boolLabels?.[0] ?? '有効'}」か「${col.boolLabels?.[1] ?? '無効'}」で入れてください（${v}）`);
    }

    if (v === '') return col.blankAsEmpty ? '' : null;

    // 値を言葉で書く欄は、言葉を値に戻す（値そのものもそのまま受ける）。合わなければ下の検査で断る
    if (col.valueLabels) {
      const hit = Object.entries(col.valueLabels).find(([, label]) => label === v);
      if (hit) return hit[0];
    }

    switch (col.kind) {
      case 'number': {
        const n = Number(v.replace(/,/g, ''));
        if (!Number.isInteger(n)) throw new Error(`整数で入れてください（${v}）`);
        return n;
      }
      case 'decimal': {
        const s = v.replace(/,/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`数値で入れてください（${v}）`);
        return s;
      }
      case 'date': {
        // Excel で保存し直すと 2026/10/7 の形になるので、それも受ける
        const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
        if (!m) throw new Error(`2026-10-04 の形で入れてください（${v}）`);
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
          throw new Error(`実在しない日付です（${v}）`);
        }
        return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      case 'digits':
        if (!/^\d+$/.test(v)) throw new Error(`数字だけで入れてください（${v}）`);
        return v;
      default:
        return v;
    }
  }

  /**
   * 1つの値が、画面・API・データベースの決まりに合うか（2026-10-12 受入 No.3 D-3）。
   * 合わなければ理由を返す。データベースの決まり（文字数・空にできるか・数の大きさ）は表から読む。
   */
  private checkValue(v: unknown, col: CsvColumn, meta: DbColumn | undefined, isNew: boolean): string | null {
    const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (col.multi) return null;
      if (meta && !meta.nullable && !(isNew && meta.hasDefault)) return '必須です（空にはできません）';
      return null;
    }
    if (col.multi) return null;

    if (typeof v === 'string' && meta?.maxLength != null) {
      const n = [...v].length;
      if (n > meta.maxLength) return `${meta.maxLength}文字までです（${n}文字あります）`;
    }
    if (col.digitsLength && typeof v === 'string' && !col.digitsLength.includes(v.length)) {
      return `${col.digitsLength.join('桁か')}桁の数字で入れてください（${v.length}桁あります）`;
    }
    if (col.options) {
      const ok =
        col.kind === 'number' || col.kind === 'decimal'
          ? col.options.some((o) => Number(o) === Number(v))
          : col.options.some((o) => String(o) === String(v));
      if (!ok) return `${col.optionsLabel ?? col.options.join('・')} のどれかで入れてください（${String(v)}）`;
    }
    if (col.kind === 'number' || col.kind === 'decimal') {
      const n = Number(v);
      if (col.min !== undefined && n < col.min) return `${col.min} 以上で入れてください（${String(v)}）`;
      if (col.max !== undefined && n > col.max) return `${col.max} 以下で入れてください（${String(v)}）`;
      const range = meta ? INT_RANGE[meta.dataType] : undefined;
      if (range && (n < range[0] || n > range[1])) return `大きすぎます（${String(v)}）`;
      if (meta?.dataType === 'numeric' && meta.precision != null && meta.scale != null) {
        const intDigits = String(v).replace(/^-/, '').split('.')[0].replace(/^0+/, '').length;
        if (intDigits > meta.precision - meta.scale) return `大きすぎます（整数の部分は${meta.precision - meta.scale}桁まで。${String(v)}）`;
      }
    }
    return null;
  }

  /** 変更があったかどうか。型がそろっていないので、見た目で比べる。 */
  private sameValue(before: unknown, after: unknown, col: CsvColumn): boolean {
    if (col.multi) {
      // 代表（先頭）と、持っているカテゴリーの組がどちらも同じなら変更なし
      const b = (before as number[] | undefined) ?? [];
      const a = (after as number[] | null) ?? [];
      if ((b[0] ?? null) !== (a[0] ?? null)) return false;
      return b.length === a.length && b.every((x) => a.includes(x));
    }
    // 文字の欄は「空」と「空の文字」を同じに扱う（作業指示の本文が空の行が「変更」と出ていた。受入 No.3 D-4）
    if (!col.ref && (col.kind === undefined || col.kind === 'text' || col.kind === 'digits')) {
      return String(before ?? '') === String(after ?? '');
    }
    if (before === null || before === undefined) return after === null || after === undefined;
    if (after === null || after === undefined) return false;
    if (col.kind === 'bool') return Boolean(before) === Boolean(after);
    if (col.kind === 'decimal' || col.kind === 'number' || col.ref) return Number(before) === Number(after);
    if (col.kind === 'date') return dateText(before) === dateText(after);
    return String(before) === String(after);
  }

  /** 画面に出す見た目。参照の欄は番号ではなくコードで見せたいが、無ければ番号のまま。 */
  private show(v: unknown, col: CsvColumn, codeById: Map<string, string>): string {
    if (Array.isArray(v)) {
      if (v.length === 0) return '（空）';
      return v.map((id) => (col.ref ? (codeById.get(`${col.ref.table}:${Number(id)}`) ?? String(id)) : String(id))).join(MULTI_SEPARATOR);
    }
    if (v === null || v === undefined || v === '') return '（空）';
    if (col.kind === 'bool') return v ? (col.boolLabels?.[0] ?? '有効') : (col.boolLabels?.[1] ?? '無効');
    if (col.ref) return codeById.get(`${col.ref.table}:${Number(v)}`) ?? String(v);
    if (col.kind === 'date') return dateText(v);
    return col.valueLabels?.[String(v)] ?? String(v);
  }
}

/* ---------- 小さな道具 ---------- */

const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;

/** Excel が文字のまま読む ="..." の形。空なら空のまま。 */
const excel = (v: string): string => (v === '' ? '""' : `"=""${v.replace(/"/g, '""""')}"""`);

/** 書き出しだけのマスタで「この欄は ="..." にする」印 */
const XL_MARK = '\u0000xl:';
const xlCell = (v: string | null | undefined): string => (v ? XL_MARK + excel(v) : '');

/** ="12345" の形を外す（書き出した CSV をそのまま取り込めるように） */
const unwrapExcel = (text: string): string => {
  const m = /^="(.*)"$/.exec(text);
  return (m ? m[1].replace(/""/g, '"') : text).trim();
};

/** 日付を YYYY-MM-DD に。Date で来ても文字で来てもよい */
function dateText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** 今のひも付けを、代表を先頭にした並びにする。ひも付けが無く代表だけあるときは代表だけ */
function orderedMulti(links: number[], primary: number | null): number[] {
  const unique = [...new Set(links)];
  if (primary === null) return unique;
  if (unique.length === 0) return [primary];
  if (!unique.includes(primary)) return unique;
  return [primary, ...unique.filter((x) => x !== primary)];
}

/** 今のひも付けを、行のデータに一緒に持たせるときの名前 */
const multiKey = (c: CsvColumn): string => `\u0000multi:${c.field}`;

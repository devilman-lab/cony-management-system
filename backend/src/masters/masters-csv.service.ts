import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { decodeAuto, parseCsv } from '../imports/csv';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { MASTER_CSV, type CsvColumn, type MasterCsvDef } from './masters-csv';

/** 取り込みの下見・実行の結果。1行ごとに何が起きる（起きた）かを返す。 */
export interface ImportRowResult {
  /** CSV の行番号（見出しを 1 とする） */
  line: number;
  key: string;
  action: '追加' | '変更' | '変更なし' | 'エラー';
  /** 変更になる欄。「原価 1000 → 1200」の形 */
  changes: string[];
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

/** 1回で取り込める行数の上限。これを超えるCSVは分けてもらう。 */
const MAX_ROWS = 5000;

@Injectable()
export class MastersCsvService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  def(slug: string): MasterCsvDef {
    const d = MASTER_CSV[slug];
    if (!d) throw new NotFoundException(`${slug} は CSV に対応していません`);
    return d;
  }

  /** 権限に応じて、出し入れしてよい欄だけに絞る。 */
  private columnsFor(def: MasterCsvDef, showSensitive: boolean): CsvColumn[] {
    return def.columns.filter((c) => !c.sensitive || showSensitive);
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
  async exportCsv(slug: string, includeInactive: boolean, showSensitive: boolean): Promise<string> {
    const def = this.def(slug);
    const cols = this.columnsFor(def, showSensitive);

    let q = this.db.selectFrom(def.table as never).selectAll();
    if (!includeInactive) q = q.where(sql`is_active`, '=', true) as typeof q;
    const rows = (await q.execute()) as Record<string, unknown>[];

    // 参照先のコードをまとめて引く（行ごとに引くと件数ぶん問い合わせが飛ぶ）
    const codeOf = await this.buildCodeLookup(cols, rows);

    const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
    const cell = (c: CsvColumn, row: Record<string, unknown>): string => {
      const raw = row[c.field];
      if (c.ref) {
        const id = raw === null || raw === undefined ? null : Number(raw);
        return esc(id === null ? '' : (codeOf.get(`${c.ref.table}:${id}`) ?? ''));
      }
      if (raw === null || raw === undefined) return '""';
      if (c.kind === 'bool') return esc(raw ? '有効' : '無効');
      if (c.kind === 'date') return esc(String(raw).slice(0, 10));
      // JAN のような数字だけの文字列は、Excel が数値に直して頭の 0 を落としてしまう
      if (c.kind === 'digits') return `"=""${String(raw)}"""`;
      return esc(String(raw));
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

  /** 参照先の「番号 → コード」をまとめて作る。 */
  private async buildCodeLookup(
    cols: CsvColumn[],
    rows: Record<string, unknown>[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const c of cols) {
      if (!c.ref) continue;
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
   * 一覧内編集のための行を返す（2026-10-01 ご要望「一覧に全ての項目を表示し、一覧内で編集ができるように」）。
   *
   * CSV と**同じ欄・同じ見方**で返します。相手のマスタはコードで返すので、
   * 画面はそのまま打ち直して保存でき、保存は取り込みと同じ道を通ります。
   */
  async gridRows(
    slug: string,
    opts: { includeInactive: boolean; showSensitive: boolean; q?: string; limit: number; offset: number },
  ) {
    const def = this.def(slug);
    const cols = this.columnsFor(def, opts.showSensitive);

    let base = this.db.selectFrom(def.table as never);
    if (!opts.includeInactive) base = base.where(sql`is_active`, '=', true) as typeof base;
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
    const rows = (await base
      .selectAll()
      .orderBy(sql.ref(def.keyFields[0]))
      .limit(opts.limit)
      .offset(opts.offset)
      .execute()) as Record<string, unknown>[];

    const codeOf = await this.buildCodeLookup(cols, rows);
    const items = rows.map((r) => {
      const out: Record<string, unknown> = { id: Number(r.id) };
      for (const c of cols) {
        const raw = r[c.field];
        if (c.ref) {
          const id = raw === null || raw === undefined ? null : Number(raw);
          out[c.field] = id === null ? '' : (codeOf.get(`${c.ref.table}:${id}`) ?? '');
        } else if (raw === null || raw === undefined) {
          out[c.field] = '';
        } else if (c.kind === 'bool') {
          out[c.field] = Boolean(raw);
        } else if (c.kind === 'date') {
          out[c.field] = String(raw).slice(0, 10);
        } else {
          out[c.field] = String(raw);
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
   */
  async importCsv(
    slug: string,
    contentBase64: string,
    dryRun: boolean,
    showSensitive: boolean,
    userId: number,
  ): Promise<ImportResult> {
    const def = this.def(slug);
    const cols = this.columnsFor(def, showSensitive);

    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('ファイルが空です');
    const { text, encoding } = decodeAuto(bytes);
    const table = parseCsv(text);
    if (table.length === 0) throw new BadRequestException('中身がありません');

    const header = table[0].map((h) => h.trim());
    const body = table.slice(1);
    if (body.length === 0) throw new BadRequestException('見出しだけで、中身の行がありません');
    if (body.length > MAX_ROWS) {
      throw new BadRequestException(`一度に取り込めるのは${MAX_ROWS}行までです（${body.length}行ありました）`);
    }

    // 見出しを欄に対応づける
    const byLabel = new Map(cols.map((c) => [c.label, c]));
    const mapped: { index: number; col: CsvColumn }[] = [];
    const ignored: string[] = [];
    for (let i = 0; i < header.length; i++) {
      const c = byLabel.get(header[i]);
      if (c) mapped.push({ index: i, col: c });
      else if (header[i] !== '') ignored.push(header[i]);
    }

    // 鍵の欄がそろっているか
    const missingKeys = def.keyFields.filter((f) => !mapped.some((m) => m.col.field === f));
    if (missingKeys.length > 0) {
      const labels = missingKeys.map((f) => cols.find((c) => c.field === f)?.label ?? f);
      throw new BadRequestException(
        `見出しに「${labels.join('」「')}」がありません。書き出した CSV の見出し行はそのまま残してください`,
      );
    }
    if (mapped.length === def.keyFields.length) {
      throw new BadRequestException('書き換える欄がありません。鍵の列だけでは取り込めません');
    }

    // 参照先のコード → 番号 をまとめて引く
    const idOf = await this.buildIdLookup(mapped.map((m) => m.col));

    // 今あるデータを鍵で引けるようにする
    const existing = (await this.db.selectFrom(def.table as never).selectAll().execute()) as Record<string, unknown>[];
    const keyCols = def.keyFields.map((f) => cols.find((c) => c.field === f)!);
    const keyOfRow = (row: Record<string, unknown>): string =>
      keyCols
        .map((c) => {
          const v = row[c.field];
          if (!c.ref) return String(v ?? '');
          const id = v === null || v === undefined ? null : Number(v);
          return id === null ? '' : String(id);
        })
        .join('\u0001');
    const byKey = new Map(existing.map((r) => [keyOfRow(r), r]));

    const results: ImportRowResult[] = [];
    const writes: { key: string; row: Record<string, unknown>; existing: Record<string, unknown> | undefined }[] = [];

    for (let r = 0; r < body.length; r++) {
      const line = r + 2; // 見出しが1行目
      const raw = body[r];
      const values: Record<string, unknown> = {};
      const problems: string[] = [];

      for (const { index, col } of mapped) {
        const cellText = (raw[index] ?? '').trim();
        try {
          values[col.field] = this.parseCell(cellText, col, idOf);
        } catch (e) {
          problems.push(e instanceof Error ? e.message : String(e));
        }
      }

      const keyText = def.keyFields
        .map((f) => {
          const c = cols.find((x) => x.field === f)!;
          const i = mapped.find((m) => m.col.field === f)!.index;
          return `${c.label}=${(raw[i] ?? '').trim()}`;
        })
        .join(' / ');

      if (problems.length > 0) {
        results.push({ line, key: keyText, action: 'エラー', changes: [], message: problems.join('。') });
        continue;
      }
      if (def.keyFields.some((f) => values[f] === null || values[f] === undefined || values[f] === '')) {
        results.push({ line, key: keyText, action: 'エラー', changes: [], message: '鍵の欄が空です' });
        continue;
      }

      const key = keyOfRow(values);
      const found = byKey.get(key);
      if (!found) {
        results.push({ line, key: keyText, action: '追加', changes: [] });
        writes.push({ key, row: values, existing: undefined });
        continue;
      }

      // 何が変わるかを見る（鍵と readOnly の欄は比べない）
      const changes: string[] = [];
      for (const { col } of mapped) {
        if (col.readOnly || def.keyFields.includes(col.field)) continue;
        const before = found[col.field];
        const after = values[col.field];
        if (!this.sameValue(before, after, col)) {
          changes.push(`${col.label} ${this.show(before, col, idOf)} → ${this.show(after, col, idOf)}`);
        }
      }
      if (changes.length === 0) {
        results.push({ line, key: keyText, action: '変更なし', changes: [] });
      } else {
        results.push({ line, key: keyText, action: '変更', changes });
        writes.push({ key, row: values, existing: found });
      }
    }

    const errors = results.filter((x) => x.action === 'エラー').length;
    const summary: ImportResult = {
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

    if (dryRun) return summary;
    if (errors > 0) {
      throw new BadRequestException(
        `読めない行が ${errors} 行あります。先に直してからもう一度お試しください（何も書き換えていません）`,
      );
    }

    // ここから書き込み。1件でも失敗したら全部やめる
    await this.db.transaction().execute(async (trx) => {
      for (const w of writes) {
        if (w.existing) {
          const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() };
          for (const { col } of mapped) {
            if (col.readOnly || def.keyFields.includes(col.field)) continue;
            patch[col.field] = w.row[col.field];
          }
          await trx
            .updateTable(def.table as never)
            .set(patch as never)
            .where(sql`id`, '=', Number(w.existing.id))
            .execute();
        } else {
          await trx
            .insertInto(def.table as never)
            .values({ ...w.row, created_by: userId, updated_by: userId } as never)
            .execute();
        }
      }
    });

    return summary;
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

  /** CSV の1マスを、データベースに入れる値に直す。 */
  private parseCell(text: string, col: CsvColumn, idOf: Map<string, number>): unknown {
    // 書き出した ="12345" の形を外す
    const v = text.replace(/^="(.*)"$/, '$1').trim();

    if (col.ref) {
      if (v === '') return null;
      const id = idOf.get(`${col.ref.table}:${col.ref.codeCategory ?? ''}:${v}`);
      if (id === undefined) {
        throw new Error(`${col.label}「${v}」は${col.ref.label}マスタにありません`);
      }
      return id;
    }

    if (v === '') return null;

    switch (col.kind) {
      case 'bool':
        if (['有効', '○', 'TRUE', 'true', '1', 'はい'].includes(v)) return true;
        if (['無効', '×', '', 'FALSE', 'false', '0', 'いいえ'].includes(v)) return false;
        throw new Error(`${col.label}は「有効」か「無効」で入れてください（${v}）`);
      case 'number': {
        const n = Number(v.replace(/,/g, ''));
        if (!Number.isInteger(n)) throw new Error(`${col.label}は整数で入れてください（${v}）`);
        return n;
      }
      case 'decimal': {
        const s = v.replace(/,/g, '');
        if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`${col.label}は数値で入れてください（${v}）`);
        return s;
      }
      case 'date': {
        const s = v.replace(/\//g, '-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          throw new Error(`${col.label}は 2026-10-04 の形で入れてください（${v}）`);
        }
        return s;
      }
      case 'digits':
        if (!/^\d+$/.test(v)) throw new Error(`${col.label}は数字だけで入れてください（${v}）`);
        return v;
      default:
        return v;
    }
  }

  /** 変更があったかどうか。型がそろっていないので、見た目で比べる。 */
  private sameValue(before: unknown, after: unknown, col: CsvColumn): boolean {
    if (before === null || before === undefined) return after === null || after === undefined;
    if (after === null || after === undefined) return false;
    if (col.kind === 'bool') return Boolean(before) === Boolean(after);
    if (col.kind === 'decimal') return Number(before) === Number(after);
    if (col.kind === 'date') return String(before).slice(0, 10) === String(after).slice(0, 10);
    return String(before) === String(after);
  }

  /** 画面に出す見た目。参照の欄は番号ではなくコードで見せたいが、無ければ番号のまま。 */
  private show(v: unknown, col: CsvColumn, idOf: Map<string, number>): string {
    if (v === null || v === undefined || v === '') return '（空）';
    if (col.kind === 'bool') return v ? '有効' : '無効';
    if (col.ref) {
      for (const [k, id] of idOf) {
        if (id === Number(v) && k.startsWith(`${col.ref.table}:`)) return k.slice(k.lastIndexOf(':') + 1);
      }
    }
    if (col.kind === 'date') return String(v).slice(0, 10);
    return String(v);
  }
}

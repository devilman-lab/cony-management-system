'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { qty } from '@/lib/format';
import type { SalesCategory, SimpleRow } from '@/lib/hooks';
import { Button, ErrorBox, Input, Modal, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchCustomers, type Option } from '@/components/ui/SearchSelect';
import { L, Section } from '@/components/masters/Form';

/** 確保の明細（API の形）。 */
export interface ReservationLine {
  id: number;
  group_id: number;
  sku_id: number;
  sku_code: string;
  item_name: string;
  color_name: string | null;
  size_name: string | null;
  reserved_qty: string;
  consumed_qty: string;
  remaining_qty: string;
}

/** 確保（見出し＋明細。API の形）。 */
export interface ReservationGroup extends Record<string, unknown> {
  id: number;
  period_from: string;
  period_to: string;
  media_id: number | null;
  media_name: string | null;
  partner_media_name: string | null;
  partner_id: number | null;
  partner_code: string | null;
  partner_name: string | null;
  sales_category_id: number;
  sales_category_name: string;
  item_label: string | null;
  note: string | null;
  product_class_id: number | null;
  product_class_code: string | null;
  product_class_name: string | null;
  reserved_total: string;
  consumed_total: string;
  lines: ReservationLine[];
}

/** 明細の商品の候補（/inventory/reservation-groups/sku-options）。 */
interface SkuOptionRow {
  sku_id: number;
  sku_code: string;
  product_name: string;
  color_name: string | null;
  size_name: string | null;
  is_set: boolean;
}

/** 明細の候補を探す。商品分類を選んでいれば、その分類の商品だけにする（Z-26）。 */
export const fetchReservationSkus =
  (productClassId?: number | null) =>
  async (q: string): Promise<Option[]> => {
    const rows = await api.get<SkuOptionRow[]>('/inventory/reservation-groups/sku-options', {
      q: q || undefined,
      product_class_id: productClassId ?? undefined,
      limit: 30,
    });
    return rows.map((s) => ({
      id: s.sku_id,
      label: `${s.sku_code}　${s.product_name}${s.color_name ? ' ' + s.color_name : ''}${s.size_name ? ' ' + s.size_name : ''}`,
      sub: s.is_set ? 'セット' : undefined,
      raw: s,
    }));
  };

interface LineDraft {
  key: number;
  /** 保存済みの明細だけ */
  id: number | null;
  sku: Option | null;
  sku_code: string;
  item_name: string;
  color_name: string;
  size_name: string;
  reserved_qty: string;
  /** 受注で使った数。保存済みの明細だけ（新しい行・コピーした確保は 0） */
  consumed_qty: string;
}

export interface Draft {
  media_id: string;
  item_label: string;
  partner: Option | null;
  sales_category_id: string;
  product_class_id: string;
  note: string;
  period_from: string;
  period_to: string;
  lines: LineDraft[];
}

let seq = 1;
const blankLine = (): LineDraft => ({ key: seq++, id: null, sku: null, sku_code: '', item_name: '', color_name: '', size_name: '', reserved_qty: '', consumed_qty: '0' });
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数量の見た目（10.00 → 10）。送るときもこのままの文字列で送る */
const dec = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/**
 * 画面の下書きを作る。
 * mode=edit は保存済みの確保をそのまま。mode=copy は見出しと明細を写した新規（使用数は 0）。
 */
export function draftFrom(g: ReservationGroup | null, mode: 'new' | 'edit' | 'copy', defaults: { sales_category_id: string; period_from: string; period_to: string }): Draft {
  if (!g) {
    return { media_id: '', item_label: '', partner: null, sales_category_id: defaults.sales_category_id, product_class_id: '', note: '', period_from: defaults.period_from, period_to: defaults.period_to, lines: [blankLine()] };
  }
  return {
    media_id: s(g.media_id),
    item_label: s(g.item_label),
    partner: g.partner_id ? { id: g.partner_id, label: g.partner_name ?? '', sub: g.partner_code ?? undefined } : null,
    sales_category_id: s(g.sales_category_id),
    product_class_id: s(g.product_class_id),
    note: s(g.note),
    period_from: g.period_from,
    period_to: g.period_to,
    lines: g.lines.map((l) => ({
      key: seq++,
      id: mode === 'edit' ? l.id : null,
      sku: { id: l.sku_id, label: `${l.sku_code}　${l.item_name}` },
      sku_code: l.sku_code,
      item_name: l.item_name,
      color_name: s(l.color_name),
      size_name: s(l.size_name),
      reserved_qty: dec(l.reserved_qty),
      consumed_qty: mode === 'edit' ? l.consumed_qty : '0',
    })),
  };
}

/**
 * 確保の登録・変更（Z-27・Z-32）。商品マスタの編集画面と同じく、上に見出し、下に明細の表。
 * 見出しの並びは坂本様のご指定どおり（媒体｜項目／取引先｜商品分類コード／販売カテゴリー｜商品分類／備考／販売期間）。
 */
export function ReservationGroupForm({
  open,
  title,
  editingId,
  initial,
  categories,
  media,
  classes,
  onClose,
  onSaved,
}: {
  open: boolean;
  title: string;
  /** 変更のときの確保の ID。新規・コピーは null */
  editingId: number | null;
  initial: Draft;
  categories: SalesCategory[];
  media: SimpleRow[];
  classes: SimpleRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [f, setF] = useState<Draft>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setF((d) => ({ ...d, ...patch }));
  const setLine = (key: number, patch: Partial<LineDraft>) => setF((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  // 媒体を選んでいれば、取引先の候補はその媒体の販売先だけ
  const mediaId = f.media_id ? Number(f.media_id) : null;
  const fetchPartner = useMemo(() => fetchCustomers(mediaId), [mediaId]);
  const classId = f.product_class_id ? Number(f.product_class_id) : null;
  const fetchSku = useMemo(() => fetchReservationSkus(classId), [classId]);

  const pickSku = (key: number, o: Option | null) => {
    const r = o?.raw as SkuOptionRow | undefined;
    setLine(key, {
      sku: o,
      sku_code: r?.sku_code ?? '',
      item_name: r?.product_name ?? '',
      color_name: r?.color_name ?? '',
      size_name: r?.size_name ?? '',
    });
  };
  const pickPartner = (o: Option | null) => {
    // 取引先を選んで媒体が空なら、取引先マスタの媒体を入れておく（一覧の媒体の列に出すため）
    const m = (o?.raw as { media_id?: number | null } | undefined)?.media_id;
    set({ partner: o, ...(o && !f.media_id && m ? { media_id: String(m) } : {}) });
  };
  const copyLine = (l: LineDraft) => {
    // 同じ商品は1つの確保に1行までなので、商品は空にして確保数だけ写す（色・サイズ違いを続けて入れる用）
    const idx = f.lines.findIndex((x) => x.key === l.key);
    const next = [...f.lines];
    next.splice(idx + 1, 0, { ...blankLine(), reserved_qty: l.reserved_qty });
    set({ lines: next });
  };
  const removeLine = (l: LineDraft) => set({ lines: f.lines.filter((x) => x.key !== l.key) });

  const total = f.lines.reduce((a, l) => a + (Number(l.reserved_qty) || 0), 0);
  const used = f.lines.reduce((a, l) => a + (Number(l.consumed_qty) || 0), 0);

  const save = async () => {
    setError(null);
    const lines = f.lines.filter((l) => l.sku || l.reserved_qty.trim());
    if (lines.some((l) => !l.sku)) return setError(new Error('商品を選んでいない行があります。選ぶか、行を削除してください'));
    if (lines.length === 0) return setError(new Error('明細（商品と確保数）を1行以上入力してください'));
    const body = {
      period_from: f.period_from,
      period_to: f.period_to,
      media_id: f.media_id ? Number(f.media_id) : null,
      partner_id: f.partner?.id ?? null,
      sales_category_id: Number(f.sales_category_id),
      item_label: f.item_label.trim() || null,
      product_class_id: f.product_class_id ? Number(f.product_class_id) : null,
      note: f.note.trim() || null,
      lines: lines.map((l) => ({ ...(l.id ? { id: l.id } : {}), sku_id: (l.sku as Option).id, reserved_qty: l.reserved_qty.trim() })),
    };
    setBusy(true);
    try {
      if (editingId) {
        await api.patch(`/inventory/reservation-groups/${editingId}`, body);
        onSaved('確保を更新しました');
      } else {
        await api.post('/inventory/reservation-groups', body);
        onSaved('引当在庫を登録しました');
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      width={980}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" loading={busy} onClick={save}>{editingId ? '更新する' : '登録する'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <ErrorBox error={error} onClose={() => setError(null)} /> : null}
        <div className="master-grid-2">
          <L label="媒体" hint="取引先が空のとき、この媒体で当てる">
            <Select value={f.media_id} onChange={(e) => set({ media_id: e.target.value })}>
              <option value="">（なし）</option>
              {media.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </L>
          <L label="項目">
            <Input value={f.item_label} onChange={(e) => set({ item_label: e.target.value })} maxLength={60} placeholder="例：チラシ・カタログ" />
          </L>
          <L label="取引先" hint="入れればこの取引先だけで当てる">
            <SearchSelect value={f.partner} onChange={pickPartner} fetchOptions={fetchPartner} placeholder="（指定なし）" width="100%" />
          </L>
          <L label="商品分類コード">
            <Select value={f.product_class_id} onChange={(e) => set({ product_class_id: e.target.value })}>
              <option value="">（なし）</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </Select>
          </L>
          <L label="販売カテゴリー" required>
            <Select value={f.sales_category_id} onChange={(e) => set({ sales_category_id: e.target.value })}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </L>
          <L label="商品分類" hint="明細の商品の候補を絞る">
            <Select value={f.product_class_id} onChange={(e) => set({ product_class_id: e.target.value })}>
              <option value="">（なし）</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </L>
        </div>
        <L label="備考">
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} className="w-full" />
        </L>
        <L label="販売期間" required>
          <Input type="date" value={f.period_from} onChange={(e) => set({ period_from: e.target.value })} className="!w-[150px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={f.period_to} onChange={(e) => set({ period_to: e.target.value })} className="!w-[150px]" />
        </L>

        <Section title="明細（商品コード・商品名・カラー・サイズ・確保数）" />
        <div className="tbl-wrap">
          <table className="tbl" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th style={{ width: 300 }}>商品コード</th>
                <th>商品名</th>
                <th style={{ width: 80 }}>カラー</th>
                <th style={{ width: 70 }}>サイズ</th>
                <th className="r" style={{ width: 100 }}>確保数</th>
                <th className="r" style={{ width: 70 }}>使用数</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {f.lines.length === 0 && <tr><td colSpan={7} className="text-center py-4 text-[var(--color-ink-3)]">明細がありません。「行を追加」から入れてください</td></tr>}
              {f.lines.map((l) => {
                const inUse = Number(l.consumed_qty) > 0;
                return (
                  <tr key={l.key}>
                    {/* 候補の一覧は body に重ねて出るので、セルの overflow で切れない */}
                    <td className="!overflow-visible">
                      <SearchSelect value={l.sku} onChange={(o) => pickSku(l.key, o)} fetchOptions={fetchSku} placeholder="商品コード・JAN・商品名" width="100%" disabled={inUse} />
                    </td>
                    <td title={l.item_name}>{l.item_name}</td>
                    <td>{l.color_name}</td>
                    <td>{l.size_name}</td>
                    <td><Input right value={l.reserved_qty} onChange={(e) => setLine(l.key, { reserved_qty: e.target.value })} /></td>
                    <td className="r num" title={inUse ? `受注で ${qty(l.consumed_qty)} 使われています。これより少なくはできません` : undefined}>{qty(l.consumed_qty)}</td>
                    <td>
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => copyLine(l)}>コピー</Button>
                        <Button size="sm" variant="quiet" className="!text-[var(--color-crit-500)]" disabled={inUse} title={inUse ? '受注で使われている明細は削除できません' : undefined} onClick={() => removeLine(l)}>削除</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" icon="plus" onClick={() => set({ lines: [...f.lines, blankLine()] })}>行を追加</Button>
          <span className="ml-auto text-[12px] text-[var(--color-ink-2)]">
            確保数合計 <b className="num">{qty(total)}</b>　使用数合計 <b className="num">{qty(used)}</b>
          </span>
        </div>
        {used > 0 && (
          <div className="text-[11px] text-[var(--color-ink-3)]">
            受注で使われている明細は、商品の変更と削除ができません。確保数は使用数より少なくできません。
          </div>
        )}
      </div>
    </Modal>
  );
}

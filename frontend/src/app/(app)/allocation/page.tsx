'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useSalesCategories, useSimpleMaster } from '@/lib/hooks';
import { addMonths, monthRange, qty, thisMonth, ymd } from '@/lib/format';
import { Button, Card, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchCustomers, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';
import {
  ReservationGroupForm,
  draftFrom,
  fetchReservationSkus,
  type Draft,
  type ReservationGroup,
} from '@/components/allocation/ReservationGroupForm';

interface ListResponse {
  items: ReservationGroup[];
  total: number;
  limit: number;
  offset: number;
  summary: { reserved: string; consumed: string; remaining: string };
}

const LIMIT = 50;

/**
 * 引当在庫（確保数）。確保（見出し）ごとに商品の確保数を登録し、受注登録のたびにここから減る。
 * 期間で持つため、月末を過ぎると自動的に効かなくなり、翌月1日から翌月の確保が使われる。
 *
 * 一覧は楽楽販売の見本のとおり確保ごとにまとめる（Z-30）。見出しの列は1回だけ出し、
 * その下に明細を並べ、確保ごとに確保数合計・使用数合計を出す。
 */
export default function AllocationPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const categories = useSalesCategories();
  const media = useSimpleMaster('media');
  const classes = useSimpleMaster('product_classes');
  const fetchPartner = useMemo(() => fetchCustomers(), []);
  const fetchSku = useMemo(() => fetchReservationSkus(), []);

  const [month, setMonth] = useState(thisMonth());
  const [categoryId, setCategoryId] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [partner, setPartner] = useState<Option | null>(null);
  const [sku, setSku] = useState<Option | null>(null);
  const [offset, setOffset] = useState(0);

  // その月に少しでもかかる確保をすべて出す（月の15日で判定すると、月の途中から始まる確保が出ない）
  const range = monthRange(month);
  const filters = {
    from: range.from,
    to: range.to,
    sales_category_id: categoryId || undefined,
    media_id: mediaId || undefined,
    partner_id: partner?.id,
    sku_id: sku?.id,
  };
  const filterKey = JSON.stringify(filters);
  useEffect(() => setOffset(0), [filterKey]);
  const list = useFetch<ListResponse>('/inventory/reservation-groups', { ...filters, limit: LIMIT, offset });
  const groups = list.data?.items ?? [];

  // 登録・変更の画面。開くたびに key を変えて、前の入力を持ち越さない
  const [form, setForm] = useState<{ key: number; title: string; editingId: number | null; initial: Draft } | null>(null);
  const defaults = () => ({ sales_category_id: categoryId || String(categories.data?.[0]?.id ?? ''), period_from: range.from, period_to: range.to });

  const openNew = () => setForm({ key: Date.now(), title: '引当在庫の登録', editingId: null, initial: draftFrom(null, 'new', defaults()) });
  const openWith = async (g: ReservationGroup, mode: 'edit' | 'copy') => {
    try {
      // 一覧の後に受注で使われているかもしれないので、使用数は読み直す
      const fresh = await api.get<ReservationGroup>(`/inventory/reservation-groups/${g.id}`);
      setForm({
        key: Date.now(),
        title: mode === 'edit' ? '確保の変更' : '引当在庫の登録（コピー）',
        editingId: mode === 'edit' ? g.id : null,
        initial: draftFrom(fresh, mode, defaults()),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : '読み込めませんでした', 'bad');
    }
  };

  const remove = async (g: ReservationGroup) => {
    if (!(await confirm('この確保を削除しますか', '明細もすべて削除します。受注で使われていない確保だけ削除できます。', true))) return;
    try {
      await api.delete(`/inventory/reservation-groups/${g.id}`);
      toast('削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const copyFromPrev = async () => {
    const prev = addMonths(month, -1);
    if (!(await confirm(`${prev} の確保を ${month} に複写しますか`, '確保（見出し）ごとに明細も写します。同じ見出しの確保がすでにある月には複写しません。複写後に数量を直してください。'))) return;
    try {
      const r = await api.post<{ copied: number; skipped: number; lines: number }>('/inventory/reservation-groups/copy-month', { from_month: prev, to_month: month });
      toast(`${r.copied} 件の確保（明細 ${r.lines} 行）を複写しました（${r.skipped} 件は既にあるため飛ばしました）`, 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const exportCsv = () => {
    const { from, to, sales_category_id, media_id, partner_id, sku_id } = filters;
    api
      .download('/inventory/reservation-groups/export', { query: { from, to, sales_category_id, media_id, partner_id, sku_id } })
      .catch((e) => toast(e instanceof Error ? e.message : '失敗しました', 'bad'));
  };

  const sum = list.data?.summary;
  const muted = 'text-[var(--color-ink-3)]';
  // 確保の区切りを見やすくする（楽楽販売の見本と同じく、確保ごとに罫線を太く）
  // 見出しの列と明細の1行目の高さをそろえるため上揃え（表の既定は中央揃え）
  const top = { verticalAlign: 'top' as const };
  const firstRow = { ...top, borderTop: '2px solid var(--color-line-strong)' };
  // 操作の列を右端に貼り付ける。tbl-stick-last は「行の最後のセル」に効くため、
  // 見出しの列を rowSpan でまとめた2行目以降では「残り」の列が貼り付いてしまう。操作の列だけに付ける。
  const stick = { position: 'sticky' as const, right: 0, background: '#fff', boxShadow: '-7px 0 7px -7px #0003' };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="引当在庫（確保数）"
        sub="確保（販売期間・媒体・取引先・販売カテゴリー・項目）ごとに商品の確保数を登録します。受注登録のたびにここから減り、月末を過ぎると自動的に翌月の確保に切り替わります"
        right={
          <>
            {can('S-08', 'print') && <Button icon="dl" onClick={exportCsv}>CSV出力</Button>}
            {can('S-08', 'create') && <Button onClick={copyFromPrev}>前月の確保を複写</Button>}
            {can('S-08', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>確保を登録</Button>}
          </>
        }
      />
      <div className="grid-auto-stats">
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">確保数（絞り込み分）</div><div className="num text-[20px] font-bold">{qty(sum?.reserved ?? 0)}</div></div>
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">受注で使った数</div><div className="num text-[20px] font-bold">{qty(sum?.consumed ?? 0)}</div></div>
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">残り</div><div className="num text-[20px] font-bold text-[var(--color-brand-700)]">{qty(sum?.remaining ?? 0)}</div></div>
      </div>
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.data?.total ?? 0}</Num> 件の確保</span>}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!w-[170px]">
            <option value="">販売カテゴリー：すべて</option>
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={mediaId} onChange={(e) => setMediaId(e.target.value)} className="!w-[150px]">
            <option value="">媒体：すべて</option>
            {(media.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchPartner} placeholder="取引先：すべて" width={200} />
          <SearchSelect value={sku} onChange={setSku} fetchOptions={fetchSku} placeholder="商品：すべて" width={240} />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        {/* 1440・1280 のどちらでも、確保数〜使用数合計まで横スクロールなしに見える幅（Z-30）。
            文字の列は「…」で切らずに折り返し、見出しも2行にする。商品名は残りの幅を使う。 */}
        <div className="tbl-wrap-wide">
          <table className="tbl tbl-fit" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th style={{ width: 88 }}>販売期間</th>
                <th style={{ width: 50 }}>媒体</th>
                <th style={{ width: 68 }}>取引先</th>
                <th style={{ width: 72 }}>販売<br />カテゴリー</th>
                <th style={{ width: 46 }}>項目</th>
                <th style={{ width: 58 }}>備考</th>
                <th style={{ width: 62 }}>商品分類<br />コード</th>
                <th style={{ width: 62 }}>商品分類</th>
                <th style={{ width: 108 }}>商品コード</th>
                <th>商品名</th>
                <th className="r" style={{ width: 50 }}>確保数</th>
                <th className="r" style={{ width: 50 }}>使用数</th>
                <th className="r" style={{ width: 48 }}>残り</th>
                <th className="r" style={{ width: 52 }}>確保数<br />合計</th>
                <th className="r" style={{ width: 52 }}>使用数<br />合計</th>
                <th style={{ width: 62, ...stick, zIndex: 3, background: '#f4f7f8' }}></th>
              </tr>
            </thead>
            <tbody>
              {list.loading && groups.length === 0 && <tr><td colSpan={16} className={`text-center py-8 ${muted}`}>読み込み中…</td></tr>}
              {!list.loading && groups.length === 0 && (
                <tr><td colSpan={16} className={`text-center py-8 ${muted}`}>この条件の確保はありません。「前月の確保を複写」か「確保を登録」から始めてください</td></tr>
              )}
              {groups.map((g) => {
                const lines = g.lines.length > 0 ? g.lines : [null];
                const span = lines.length;
                const inUse = Number(g.consumed_total) > 0;
                return (
                  <Fragment key={g.id}>
                    {lines.map((l, i) => (
                      <tr key={l ? l.id : `g${g.id}`}>
                        {i === 0 && (
                          <>
                            <td rowSpan={span} style={firstRow} className="nw"><Num>{ymd(g.period_from)}<br />〜{ymd(g.period_to)}</Num></td>
                            <td rowSpan={span} style={firstRow} title={g.media_name ?? g.partner_media_name ?? ''}>
                              {g.media_name ?? (g.partner_media_name ? <span className={muted}>{g.partner_media_name}</span> : '')}
                            </td>
                            <td rowSpan={span} style={firstRow} title={g.partner_name ?? ''}>
                              {g.partner_name ?? <span className={muted}>（指定なし）</span>}
                            </td>
                            <td rowSpan={span} style={firstRow}>{g.sales_category_name}</td>
                            <td rowSpan={span} style={firstRow} title={g.item_label ?? ''}>{g.item_label ?? ''}</td>
                            <td rowSpan={span} style={firstRow} title={g.note ?? ''}>{g.note ?? ''}</td>
                            <td rowSpan={span} style={firstRow}>{g.product_class_code ?? ''}</td>
                            <td rowSpan={span} style={firstRow} title={g.product_class_name ?? ''}>{g.product_class_name ?? ''}</td>
                          </>
                        )}
                        <td style={i === 0 ? firstRow : top}>{l && <Num className="font-semibold">{l.sku_code}</Num>}</td>
                        <td style={i === 0 ? firstRow : top} title={l?.item_name ?? ''}>{l?.item_name ?? ''}</td>
                        <td className="r num" style={i === 0 ? firstRow : top}>{l ? qty(l.reserved_qty) : ''}</td>
                        <td className="r num" style={i === 0 ? firstRow : top}>{l ? qty(l.consumed_qty) : ''}</td>
                        <td className="r num" style={i === 0 ? firstRow : top}>
                          {l && <b className={Number(l.remaining_qty) <= 0 ? 'text-[var(--color-crit-500)]' : ''}>{qty(l.remaining_qty)}</b>}
                        </td>
                        {i === 0 && (
                          <>
                            <td rowSpan={span} style={firstRow} className="r num font-semibold">{qty(g.reserved_total)}</td>
                            <td rowSpan={span} style={firstRow} className="r num font-semibold">{qty(g.consumed_total)}</td>
                            <td rowSpan={span} style={{ ...firstRow, ...stick }}>
                              <div className="tbl-acts">
                                {can('S-08', 'update') && <Button size="sm" onClick={() => openWith(g, 'edit')}>編集</Button>}
                                {can('S-08', 'create') && <Button size="sm" onClick={() => openWith(g, 'copy')}>コピー</Button>}
                                {can('S-08', 'delete') && (
                                  <Button
                                    size="sm"
                                    variant="quiet"
                                    className="!text-[var(--color-crit-500)]"
                                    disabled={inUse}
                                    title={inUse ? '受注で使われている確保は削除できません。確保数を直してください' : undefined}
                                    onClick={() => remove(g)}
                                  >
                                    削除
                                  </Button>
                                )}
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager total={list.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </Card>

      {form && (
        <ReservationGroupForm
          key={form.key}
          open
          title={form.title}
          editingId={form.editingId}
          initial={form.initial}
          categories={categories.data ?? []}
          media={media.data?.items ?? []}
          classes={classes.data?.items ?? []}
          onClose={() => setForm(null)}
          onSaved={async (message) => {
            toast(message, 'good');
            setForm(null);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

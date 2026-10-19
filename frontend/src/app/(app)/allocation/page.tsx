'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useFetch, useSalesCategories, useSimpleMaster } from '@/lib/hooks';
import { monthRange, qty, thisMonth, ymd } from '@/lib/format';
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
}

const LIMIT = 50;

/**
 * 引当在庫（確保数）。確保（見出し）ごとに商品の確保数を登録し、受注登録のたびにここから減る。
 * 期間で持つため、月末を過ぎると自動的に効かなくなり、翌月1日から翌月の確保が使われる。
 *
 * 一覧は楽楽販売の見本のとおり確保ごとにまとめる（Z-30）。見出しの列は1回だけ出し、
 * その下に明細を並べ、確保ごとに確保数合計・使用数合計を出す。
 */
/**
 * 列の幅。1440 幅のときは base（この幅で全列が横スクロールなしに収まる）で、画面がそれより広いほど
 * 広い分の rate 倍だけ広げる。広い画面で、余りが商品名にだけ回って媒体・取引先などが細いまま何行にも
 * 割れていたため、余りを各列に配る。
 */
const grow = (base: number, rate: number) => `max(${base}px, calc(${base}px + (100vw - 1440px) * ${rate}))`;

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
  // キーワード（Z3-13）。項目・備考・商品コード・商品名を探す。商品の欄（1つの商品を選ぶ）とは別に置く
  const [keyword, setKeyword] = useState('');
  const dKeyword = useDebounce(keyword.trim(), 300);
  const [offset, setOffset] = useState(0);
  // 1440 より狭い画面（1280 など）では、表を詰めて操作のボタンを販売期間の欄に入れる（3回目の全面テスト Z-30）。
  // 右端に貼り付けた操作の列の下に「残り」「確保数合計」「使用数合計」が隠れ、横のスクロールバーも画面の外にあった
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1439px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // その月に少しでもかかる確保をすべて出す（月の15日で判定すると、月の途中から始まる確保が出ない）
  const range = monthRange(month);
  const filters = {
    from: range.from,
    to: range.to,
    sales_category_id: categoryId || undefined,
    media_id: mediaId || undefined,
    partner_id: partner?.id,
    sku_id: sku?.id,
    q: dKeyword || undefined,
  };
  const filterKey = JSON.stringify(filters);
  useEffect(() => setOffset(0), [filterKey]);
  const list = useFetch<ListResponse>('/inventory/reservation-groups', { ...filters, limit: LIMIT, offset });
  const groups = list.data?.items ?? [];

  // 登録・変更の画面。開くたびに key を変えて、前の入力を持ち越さない
  const [form, setForm] = useState<{ key: number; title: string; editingId: number | null; initial: Draft } | null>(null);
  // 販売カテゴリーは空欄が既定（Z3-15）。一覧を販売カテゴリーで絞っているときだけ、それを入れておく
  const defaults = () => ({ sales_category_id: categoryId && categoryId !== 'none' ? categoryId : '', period_from: range.from, period_to: range.to });

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

  // 「前月の確保を複写」のボタンは外した（Z3-14。写すときは確保ごとの「コピー」で）。API は残してある

  const exportCsv = () => {
    api
      .download('/inventory/reservation-groups/export', { query: filters })
      .catch((e) => toast(e instanceof Error ? e.message : '失敗しました', 'bad'));
  };

  const muted = 'text-[var(--color-ink-3)]';
  // 確保の区切りを見やすくする（楽楽販売の見本と同じく、確保ごとに罫線を太く）
  // 見出しの列と明細の1行目の高さをそろえるため上揃え（表の既定は中央揃え）
  const top = { verticalAlign: 'top' as const };
  const firstRow = { ...top, borderTop: '2px solid var(--color-line-strong)' };
  // 操作の列を右端に貼り付ける。tbl-stick-last は「行の最後のセル」に効くため、
  // 見出しの列を rowSpan でまとめた2行目以降では「残り」の列が貼り付いてしまう。操作の列だけに付ける。
  const actions = (g: ReservationGroup, inUse: boolean) => (
    <>
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
    </>
  );
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
            {can('S-08', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>確保を登録</Button>}
          </>
        }
      />
      {/* 上部の確保数・受注で使った数・残りの合計は外した（Z3-11）。確保ごとの合計は表の右に出している */}
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.data?.total ?? 0}</Num> 件の確保</span>}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!w-[170px]">
            <option value="">販売カテゴリー：すべて</option>
            <option value="none">販売カテゴリー：（指定なし）</option>
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={mediaId} onChange={(e) => setMediaId(e.target.value)} className="!w-[150px]">
            <option value="">媒体：すべて</option>
            {(media.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchPartner} placeholder="取引先：すべて" width={200} />
          <SearchSelect value={sku} onChange={setSku} fetchOptions={fetchSku} placeholder="商品：すべて" width={240} />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="キーワード（項目・備考・商品）" className="!w-[220px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        {/* 1440 幅で確保数〜使用数合計まで横スクロールなしに見える幅（Z-30）。
            販売カテゴリー・商品分類コード・商品コード・確保数合計・使用数合計は、見出しも値も1行で読めるよう
            文字が収まる幅を取って折り返さない（2行に割れて読みにくかった）。取引先・備考などは折り返し、
            商品名は残りの幅を使う。これより狭い画面では表を横にずらして見る。 */}
        <div className="tbl-wrap-wide">
          <table className={`tbl tbl-fit${narrow ? ' tbl-dense' : ''}`} style={{ minWidth: narrow ? 1000 : 1180 }}>
            <thead>
              <tr>
                <th style={{ width: narrow ? 76 : 88 }}>販売期間</th>
                <th style={{ width: narrow ? 44 : grow(50, 0.06) }}>媒体</th>
                <th style={{ width: narrow ? 64 : grow(68, 0.15) }}>取引先</th>
                <th className="nw" style={{ width: narrow ? 92 : 104 }}>販売カテゴリー</th>
                <th style={{ width: narrow ? 40 : grow(46, 0.06) }}>項目</th>
                <th style={{ width: narrow ? 50 : grow(58, 0.1) }}>備考</th>
                <th className="nw" style={{ width: narrow ? 88 : 94 }}>商品分類コード</th>
                <th style={{ width: narrow ? 54 : grow(62, 0.08) }}>商品分類</th>
                <th className="nw" style={{ width: narrow ? 112 : grow(128, 0.04) }}>商品コード</th>
                <th>商品名</th>
                <th className="r" style={{ width: narrow ? 44 : 50 }}>確保数</th>
                <th className="r" style={{ width: narrow ? 44 : 50 }}>使用数</th>
                <th className="r" style={{ width: narrow ? 40 : 48 }}>残り</th>
                <th className="r nw" style={{ width: narrow ? 68 : 76 }}>確保数合計</th>
                <th className="r nw" style={{ width: narrow ? 68 : 76 }}>使用数合計</th>
                {!narrow && <th style={{ width: grow(62, 0.25), ...stick, zIndex: 3, background: '#f4f7f8' }}></th>}
              </tr>
            </thead>
            <tbody>
              {list.loading && groups.length === 0 && <tr><td colSpan={narrow ? 15 : 16} className={`text-center py-8 ${muted}`}>読み込み中…</td></tr>}
              {!list.loading && groups.length === 0 && (
                <tr><td colSpan={narrow ? 15 : 16} className={`text-center py-8 ${muted}`}>この条件の確保はありません。「確保を登録」から始めてください</td></tr>
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
                            <td rowSpan={span} style={firstRow} className="nw">
                              <Num>{ymd(g.period_from)}<br />〜{ymd(g.period_to)}</Num>
                              {narrow && <div className="mt-1.5 flex flex-col items-start gap-1">{actions(g, inUse)}</div>}
                            </td>
                            <td rowSpan={span} style={firstRow} title={g.media_name ?? g.partner_media_name ?? ''}>
                              {g.media_name ?? (g.partner_media_name ? <span className={muted}>{g.partner_media_name}</span> : '')}
                            </td>
                            {/* 取引先は略称で（Z3-12）。マウスを乗せると正式な名称 */}
                            <td rowSpan={span} style={firstRow} title={g.partner_full_name ?? ''}>
                              {g.partner_name ?? <span className={muted}>（指定なし）</span>}
                            </td>
                            <td rowSpan={span} style={firstRow} className="nw">
                              {g.sales_category_name ?? <span className={muted}>（指定なし）</span>}
                            </td>
                            <td rowSpan={span} style={firstRow} title={g.item_label ?? ''}>{g.item_label ?? ''}</td>
                            <td rowSpan={span} style={firstRow} title={g.note ?? ''}>{g.note ?? ''}</td>
                            <td rowSpan={span} style={firstRow} className="nw">{g.product_class_code ?? ''}</td>
                            <td rowSpan={span} style={firstRow} title={g.product_class_name ?? ''}>{g.product_class_name ?? ''}</td>
                          </>
                        )}
                        <td style={i === 0 ? firstRow : top} className="nw">{l && <Num className="font-semibold">{l.sku_code}</Num>}</td>
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
                            {!narrow && (
                              <td rowSpan={span} style={{ ...firstRow, ...stick }}>
                                <div className="tbl-acts">{actions(g, inUse)}</div>
                              </td>
                            )}
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

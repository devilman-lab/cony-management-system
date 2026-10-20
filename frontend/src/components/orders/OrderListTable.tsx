'use client';

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

import { moneyCell, moneyIn, qty as fmtQty, ymd } from '@/lib/format';
import { Badge, Num } from '@/components/ui';
import { DateRangeFilter, ValueFilter } from './ColumnFilter';
import { EditArea, EditDate, EditSelect, EditText } from './InlineFields';
import {
  canSelectForAllocation,
  FIELD_KEY,
  FIELD_TITLE,
  type Facet,
  type OrderFilters,
  type OrderLine,
  type OrderPatch,
  type OrderRow,
  type ValueField,
} from './list-filters';

/**
 * 受注一覧の表（2026-10-13 受注処理編 O-15〜O-22）。
 *
 * 列: 選択・受注番号・区分・取引先・納品先・販売カテゴリー・販売担当・金額・出荷日・納品日・納品時間・状態・操作（受注日は出さない。O-15）。
 * 見出しの ▼ で Excel のフィルターのように絞り込む（O-20）。
 * 明細を表示（O-21）では、受注の行の下に明細と出荷依頼書備考・納品書備考を出す（楽楽の明細付き一覧のように、一覧の中で読める）。
 * 編集モード（O-22）では、出荷日・納品日・納品時間・備考と明細の適用をその場で直す（欄を離れたら保存）。
 *
 * 幅 1280 でも横スクロールなしに全列が見えるよう、列幅の合計を 1000px ほどに抑えてある。
 * 明細を表示・編集モードのときは欄が広くなるので、表の中だけ横に流れる（画面ははみ出さない）。
 */

interface Props {
  rows: OrderRow[];
  loading: boolean;
  withLines: boolean;
  editMode: boolean;
  /** 引当の選択欄を出すか（引当の権限があるとき） */
  selectable: boolean;
  selected: Set<number>;
  onToggle: (row: OrderRow) => void;
  onToggleAll: (rows: OrderRow[], on: boolean) => void;
  filters: OrderFilters;
  /** 今の絞り込み（列の値の一覧の件数を数えるため） */
  query: Record<string, string | undefined>;
  onFilter: (patch: Partial<OrderFilters>) => void;
  onFacets: (field: ValueField, facets: Facet[]) => void;
  deliveryTimes: { id: number; name: string }[];
  /** 一覧のまま直す。失敗したら例外（欄は元の値に戻る） */
  onSave: (row: OrderRow, patch: OrderPatch, what: string) => Promise<void>;
  /** 操作の欄（引当・修正・取消） */
  actions: (row: OrderRow) => ReactNode;
  empty: ReactNode;
}

/** 明細の表の列（行・種別・商品コード・品名・カラー・サイズ・JAN・数量・単価・金額・出荷依頼書適用・納品書適用） */
// 幅 1280 でも明細を表示したまま表の中に収まる幅（品名は残りの幅。最低 140）
const LINE_COLS: { key: string; label: string; width?: number; r?: boolean }[] = [
  { key: 'line_no', label: '行', width: 30, r: true },
  { key: 'line_type', label: '種別', width: 56 },
  { key: 'sku_code', label: '商品コード', width: 116 },
  { key: 'item_name', label: '品名' },
  { key: 'color_name', label: 'カラー', width: 70 },
  { key: 'size_name', label: 'サイズ', width: 44 },
  { key: 'jan', label: 'JAN', width: 100 },
  { key: 'qty', label: '数量', width: 50, r: true },
  { key: 'unit_price', label: '単価', width: 66, r: true },
  { key: 'amount', label: '金額', width: 76, r: true },
  { key: 'shipping_note', label: '出荷依頼書適用', width: 116 },
  { key: 'delivery_slip_note', label: '納品書適用', width: 116 },
];
const LINE_MIN = LINE_COLS.reduce((a, c) => a + (c.width ?? 0), 0) + 140;
/** 明細の表の左の字下げ（選択の欄の幅にそろえる） */
const INDENT = 28;

const minus = (v: string | null | undefined) => Number(v ?? 0) < 0;

/** お届け先（納品先・取引先の無い受注）の名前に添える小さな札 */
function DirectTag() {
  return (
    <span className="inline-block mr-1 px-1 rounded-[3px] border border-[var(--color-line-strong)] text-[10px] leading-[1.5] text-[var(--color-ink-3)] align-[1px]">
      お届け先
    </span>
  );
}

export function OrderListTable({
  rows,
  loading,
  withLines,
  editMode,
  selectable,
  selected,
  onToggle,
  onToggleAll,
  filters,
  query,
  onFilter,
  onFacets,
  deliveryTimes,
  onSave,
  actions,
  empty,
}: Props) {
  // 編集モードでは日付・納品時間の欄が入るので広げる
  // 操作の欄は幅 1280 では 100（引当・修正／取消 の2段）、広い画面では 124（1段）
  // 区分・販売担当の見出しが ▼ と並んで2行に折れていたので広げ、金額の列を少し詰めた（2026-10-20 受入テスト T2）
  const W = {
    sel: 28,
    no: 104,
    type: 62,
    category: 86,
    staff: 80,
    amount: 74,
    date: editMode ? 122 : 82,
    time: editMode ? 112 : 68,
    status: 74,
    act: 100,
  };
  // 取引先・納品先（幅の決まっていない2列）の最低幅。区分・販売担当を広げた分だけ詰め、表の最低幅は前と同じ 1000px に保つ
  const autoMin = 80;
  const fixed =
    (selectable ? W.sel : 0) + W.no + W.type + W.category + W.staff + W.amount + W.date * 2 + W.time + W.status + W.act;
  const minWidth = Math.max(fixed + autoMin * 2, withLines ? LINE_MIN + INDENT + 8 : 0);
  const colCount = selectable ? 13 : 12;

  const selectableRows = rows.filter(canSelectForAllocation);
  const allChecked = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));

  const valueFilter = (field: ValueField) => (
    <ValueFilter
      field={field}
      title={FIELD_TITLE[field]}
      selected={filters[FIELD_KEY[field]]}
      onApply={(v) => onFilter({ [FIELD_KEY[field]]: v } as Partial<OrderFilters>)}
      query={query}
      onFacets={onFacets}
      hint={field === 'status' ? '取り消した受注は、上の「取消も表示」で出します' : undefined}
    />
  );
  // 見出しの文字は詰めずに折り返し、▼ は文字のすぐ後ろ（入らなければ次の行）に置く
  const head = (label: ReactNode, filter?: ReactNode) => (
    <>
      <span className="align-middle">{label}</span>
      {filter && <span className="inline-block align-middle ml-[3px]">{filter}</span>}
    </>
  );

  const saveLine = (row: OrderRow, line: OrderLine, key: 'shipping_note' | 'delivery_slip_note', what: string) => (v: string | null) =>
    onSave(row, { lines: [{ id: line.id, [key]: v }] }, `${line.line_no}行目の${what}`);

  return (
    <div className="tbl-wrap-wide">
      <table className="tbl tbl-fit" style={{ minWidth }}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: W.sel }} className="c">
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={selectableRows.length === 0}
                  onChange={() => onToggleAll(selectableRows, !allChecked)}
                  aria-label="引当待ちの受注をすべて選ぶ"
                  title="このページの引当待ちの受注をすべて選ぶ"
                />
              </th>
            )}
            <th style={{ width: W.no }}>受注番号</th>
            <th style={{ width: W.type }}>{head('区分', valueFilter('type'))}</th>
            <th>{head('取引先', valueFilter('partner'))}</th>
            <th>{head('納品先', valueFilter('destination'))}</th>
            <th style={{ width: W.category }}>{head('販売カテゴリー', valueFilter('category'))}</th>
            <th style={{ width: W.staff }}>{head('販売担当', valueFilter('staff'))}</th>
            <th style={{ width: W.amount }} className="r">
              金額
            </th>
            <th style={{ width: W.date }}>
              {head(
                '出荷日',
                <DateRangeFilter title="出荷日" from={filters.ship_from} to={filters.ship_to} onApply={(f, t) => onFilter({ ship_from: f, ship_to: t })} />,
              )}
            </th>
            <th style={{ width: W.date }}>
              {head(
                '納品日',
                <DateRangeFilter
                  title="納品日"
                  from={filters.delivery_from}
                  to={filters.delivery_to}
                  onApply={(f, t) => onFilter({ delivery_from: f, delivery_to: t })}
                />,
              )}
            </th>
            <th style={{ width: W.time }}>納品時間</th>
            <th style={{ width: W.status }}>{head('状態', valueFilter('status'))}</th>
            <th className="w-[100px] min-[1400px]:w-[132px]">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={colCount} className="text-center py-8 text-[var(--color-ink-3)]">
                読み込み中…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={colCount} className="text-center py-8 text-[var(--color-ink-3)]">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const shipped = r.status === '出荷済' || r.shipment_status === '出荷済';
            const editable = editMode && !r.is_cancelled;
            const lines = r.lines ?? [];
            return (
              <Fragment key={r.id}>
                <tr
                  className={`${selected.has(r.id) ? 'sel' : ''} ${r.is_cancelled ? 'text-[var(--color-ink-3)]' : ''} ${
                    // 明細を出すときは、受注の境目に線を引いて受注ごとのまとまりを分かりやすくする
                    withLines ? '[&>td]:border-t [&>td]:border-t-[#c9d5db]' : ''
                  }`}
                >
                  {selectable && (
                    <td className="c">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        disabled={!canSelectForAllocation(r)}
                        onChange={() => onToggle(r)}
                        aria-label={`${r.order_no} を選ぶ`}
                        title={canSelectForAllocation(r) ? '引き当てる受注に選ぶ' : 'まだ引き当てていない受注（引当待ち）だけ選べます'}
                      />
                    </td>
                  )}
                  <td className="nw">
                    <Link href={`/orders/${r.id}`} className="num font-semibold text-[var(--color-brand-700)]">
                      {r.order_no}
                    </Link>
                    {r.po_no && (
                      <div className="num text-[10.5px] text-[var(--color-ink-3)] truncate" title={`先方発注番号 ${r.po_no}`}>
                        先方 {r.po_no}
                      </div>
                    )}
                  </td>
                  <td>{r.order_type}</td>
                  <td>
                    {r.partner_name !== null ? (
                      <span title={r.partner_code ?? undefined}>{r.partner_name}</span>
                    ) : r.direct_name ? (
                      <>
                        <DirectTag />
                        {r.direct_name}
                      </>
                    ) : (
                      <span className="text-[var(--color-ink-3)]">—</span>
                    )}
                  </td>
                  <td>
                    {r.delivery_destination_id !== null ? (
                      <span title={r.delivery_code ?? undefined}>{r.delivery_name}</span>
                    ) : r.direct_name ? (
                      <>
                        <DirectTag />
                        {r.direct_name}
                      </>
                    ) : (
                      <span className="text-[var(--color-ink-3)]">—</span>
                    )}
                  </td>
                  <td>{r.sales_category_name ?? <span className="text-[var(--color-ink-3)]">—</span>}</td>
                  <td>{r.staff_name ?? ''}</td>
                  <td className={`r num ${minus(r.total_amount) ? 'text-[var(--color-crit-500)]' : ''}`}>{moneyCell(r.total_amount, r.currency)}</td>
                  <td className={editable ? '' : 'nw'}>
                    {editable && !shipped ? (
                      <EditDate label={`${r.order_no} の出荷日`} value={r.ship_date} onSave={(v) => onSave(r, { ship_date: v }, '出荷日')} />
                    ) : (
                      <span title={editable && shipped ? '出荷済みのため出荷日は直せません（出荷確定を取り消すと直せます）' : undefined}>
                        <Num>{ymd(r.ship_date)}</Num>
                        {editable && shipped && <span className="ml-1 text-[10px] text-[var(--color-ink-3)]">出荷済</span>}
                      </span>
                    )}
                  </td>
                  <td className={editable ? '' : 'nw'}>
                    {editable ? (
                      <EditDate label={`${r.order_no} の納品日`} value={r.delivery_date} onSave={(v) => onSave(r, { delivery_date: v }, '納品日')} />
                    ) : (
                      <Num>{ymd(r.delivery_date)}</Num>
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <EditSelect
                        label={`${r.order_no} の納品時間`}
                        value={r.delivery_time_code_id}
                        options={deliveryTimes}
                        onSave={(v) => onSave(r, { delivery_time_code_id: v }, '納品時間')}
                      />
                    ) : (
                      <span className="num text-[12px]">{r.delivery_time_name ?? ''}</span>
                    )}
                  </td>
                  <td>
                    <Badge status={r.is_cancelled ? '取消' : r.status} />
                  </td>
                  <td>{actions(r)}</td>
                </tr>
                {withLines && (
                  <tr className="ol-lines">
                    <td colSpan={colCount} className="!p-0 !bg-[#f6f9fa]">
                      <div className="pt-1.5 pb-2 pr-2" style={{ paddingLeft: INDENT }}>
                        <table
                          className="w-full border-separate border-spacing-0 text-[11.5px]"
                          style={{ tableLayout: 'fixed', minWidth: LINE_MIN }}
                        >
                          <colgroup>
                            {LINE_COLS.map((c) => (
                              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
                            ))}
                          </colgroup>
                          <thead>
                            <tr>
                              {LINE_COLS.map((c) => (
                                <th
                                  key={c.key}
                                  className={`!static !bg-[#eef2f4] !py-1 !text-[10.5px] !font-semibold !text-[var(--color-ink-2)] ${c.r ? 'r' : ''}`}
                                >
                                  {c.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {lines.length === 0 && (
                              <tr>
                                <td colSpan={LINE_COLS.length} className="!py-1.5 text-[var(--color-ink-3)]">
                                  明細がありません
                                </td>
                              </tr>
                            )}
                            {lines.map((l) => {
                              const child = l.parent_line_no !== null;
                              return (
                                <tr key={l.id}>
                                  <td className="r num !py-1">{l.line_no}</td>
                                  <td className="!py-1">{l.line_type}</td>
                                  <td className="num !py-1">{l.sku_code ?? ''}</td>
                                  <td className={`!py-1 ${child ? 'text-[var(--color-ink-2)]' : ''}`}>
                                    {child && <span className="text-[var(--color-ink-3)] mr-0.5">└</span>}
                                    {l.item_name}
                                  </td>
                                  <td className="!py-1">{l.color_name ?? ''}</td>
                                  <td className="!py-1">{l.size_name ?? ''}</td>
                                  <td className="num !py-1">{l.jan ?? ''}</td>
                                  <td className={`r num !py-1 ${minus(l.qty) ? 'text-[var(--color-crit-500)]' : ''}`}>{fmtQty(l.qty)}</td>
                                  <td className="r num !py-1">{moneyIn(l.unit_price, r.currency)}</td>
                                  <td className={`r num !py-1 ${minus(l.amount) ? 'text-[var(--color-crit-500)]' : ''}`}>{moneyIn(l.amount, r.currency)}</td>
                                  <td className="!py-1">
                                    {editable ? (
                                      <EditText
                                        label={`${r.order_no} ${l.line_no}行目の出荷依頼書適用`}
                                        value={l.shipping_note}
                                        maxLength={200}
                                        onSave={saveLine(r, l, 'shipping_note', '出荷依頼書適用')}
                                      />
                                    ) : (
                                      l.shipping_note ?? ''
                                    )}
                                  </td>
                                  <td className="!py-1">
                                    {editable ? (
                                      <EditText
                                        label={`${r.order_no} ${l.line_no}行目の納品書適用`}
                                        value={l.delivery_slip_note}
                                        maxLength={200}
                                        onSave={saveLine(r, l, 'delivery_slip_note', '納品書適用')}
                                      />
                                    ) : (
                                      l.delivery_slip_note ?? ''
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="grid grid-cols-2 gap-3 mt-1.5">
                          <Remark
                            label="出荷依頼書備考"
                            value={r.shipping_remarks}
                            edit={editable}
                            onSave={(v) => onSave(r, { shipping_remarks: v }, '出荷依頼書備考')}
                            orderNo={r.order_no}
                          />
                          <Remark
                            label="納品書備考"
                            value={r.delivery_note_remarks}
                            edit={editable}
                            onSave={(v) => onSave(r, { delivery_note_remarks: v }, '納品書備考')}
                            orderNo={r.order_no}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 出荷依頼書備考・納品書備考（明細の下。編集モードでは欄） */
function Remark({
  label,
  value,
  edit,
  onSave,
  orderNo,
}: {
  label: string;
  value: string | null;
  edit: boolean;
  onSave: (v: string | null) => Promise<void>;
  orderNo: string;
}) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="flex-none w-[84px] pt-[3px] text-[10.5px] font-semibold text-[var(--color-ink-3)]">{label}</span>
      <div className="flex-1 min-w-0 text-[11.5px]">
        {edit ? (
          <EditArea label={`${orderNo} の${label}`} value={value} onSave={onSave} />
        ) : value ? (
          <div className="whitespace-pre-wrap break-words pt-[2px]">{value}</div>
        ) : (
          <div className="pt-[2px] text-[var(--color-ink-3)]">—</div>
        )}
      </div>
    </div>
  );
}

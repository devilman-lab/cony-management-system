'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useSimpleMaster } from '@/lib/hooks';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { Check, L, PostalLookup, Section } from '@/components/masters/Form';

interface PartnerRow extends Record<string, unknown> {
  id: number;
  partner_code: string;
  name1: string;
  short_name: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  is_royalty_payee: boolean;
  closing_day: number | null;
  default_trade_type: string | null;
  media_name: string | null;
  sales_staff_name: string | null;
  category_names: string | null;
  is_active: boolean;
}

interface Form {
  partner_code: string;
  name1: string;
  name2: string;
  short_name: string;
  is_customer: boolean;
  is_supplier: boolean;
  is_royalty_payee: boolean;
  sales_staff_id: string;
  media_id: string;
  partner_category_id: string;
  /** 取引先が持つカテゴリー（複数可）。TVとカタログ両方など。 */
  category_ids: number[];
  invoice_registration_no: string;
  invoice_note: string;
  invoice_addressee: string;
  invoice_contact_name: string;
  shipping_fee_threshold: string;
  shipping_fee_amount: string;
  default_trade_type: string;
  closing_day: string;
  payment_month_offset: string;
  payment_day: string;
  postal_code: string;
  address1: string;
  address2: string;
  tel: string;
  fax: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

const EMPTY: Form = {
  partner_code: '', name1: '', name2: '', short_name: '', is_customer: true, is_supplier: false, is_royalty_payee: false,
  sales_staff_id: '', media_id: '', partner_category_id: '', category_ids: [] as number[], invoice_registration_no: '', invoice_note: '', invoice_addressee: '', invoice_contact_name: '',
  shipping_fee_threshold: '', shipping_fee_amount: '', default_trade_type: '', closing_day: '', payment_month_offset: '', payment_day: '',
  postal_code: '', address1: '', address2: '', tel: '', fax: '', sort_order: '', note: '',
};

/** 取引先マスタ（M-01）。得意先・仕入先の両方をここで持つ。 */
export default function PartnersPage() {
  const [role, setRole] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const staff = useSimpleMaster('sales_staff');
  const media = useSimpleMaster('media');
  const categories = useSimpleMaster('partner_categories');

  return (
    <MasterPage<PartnerRow, Form>
      title="取引先"
      sub="得意先・仕入先。締め日・支払条件・既定の販売担当・送料の特別条件はここで決めます"
      functionId="M-01"
      csvSlug="partners"
      listPath="/masters/partners"
      writePath="/masters/partners"
      extraFilters={{
        role: role || undefined,
        media_id: mediaId || undefined,
        sales_staff_id: staffId || undefined,
        partner_category_id: categoryId || undefined,
      }}
      modalWidth={840}
      toolbar={
        <>
          <Select value={role} onChange={(e) => setRole(e.target.value)} className="!w-[120px]">
            <option value="">すべて</option>
            <option value="customer">得意先</option>
            <option value="supplier">仕入先</option>
          </Select>
          <Select value={mediaId} onChange={(e) => setMediaId(e.target.value)} className="!w-[140px]">
            <option value="">媒体：すべて</option>
            {(media.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="!w-[150px]">
            <option value="">販売担当：すべて</option>
            {(staff.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!w-[170px]">
            <option value="">カテゴリー：すべて</option>
            {(categories.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </>
      }
      columns={[
        { key: 'partner_code', label: 'コード', width: 100, render: (r) => <Num className="font-semibold">{r.partner_code}</Num> },
        { key: 'name1', label: '名称' },
        { key: 'short_name', label: '略称', width: 140, render: (r) => r.short_name ?? '' },
        { key: '_role', label: '区分', width: 120, render: (r) => <span className="flex gap-1">{r.is_customer && <Badge>得意先</Badge>}{r.is_supplier && <Badge>仕入先</Badge>}{r.is_royalty_payee && <Badge>ロイヤリティ</Badge>}</span> },
        { key: 'category_names', label: 'カテゴリー', width: 150, render: (r) => r.category_names ?? '' },
        { key: 'media_name', label: '媒体', width: 100, render: (r) => r.media_name ?? '' },
        { key: 'sales_staff_name', label: '販売担当', width: 110, render: (r) => r.sales_staff_name ?? '' },
        { key: 'default_trade_type', label: '取引', width: 60, render: (r) => r.default_trade_type ?? '' },
        { key: 'closing_day', label: '締め日', r: true, width: 70, render: (r) => (r.closing_day ? (r.closing_day >= 99 ? '末日' : `${r.closing_day}日`) : '') },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => EMPTY}
      toForm={async (r) => {
        const d = await api.get<Record<string, unknown>>(`/masters/partners/${r.id}`);
        const f: Record<string, unknown> = {};
        for (const k of Object.keys(EMPTY) as (keyof Form)[]) {
          if (Array.isArray(EMPTY[k])) {
            // カテゴリー（複数）は配列のまま受け取る
            f[k] = Array.isArray(d[k]) ? (d[k] as number[]) : [];
          } else {
            f[k] = typeof EMPTY[k] === 'boolean' ? Boolean(d[k]) : k === 'shipping_fee_threshold' || k === 'shipping_fee_amount' ? dec(d[k]) : s(d[k]);
          }
        }
        return f as unknown as Form;
      }}
      toBody={(f) => ({
        partner_code: f.partner_code.trim(),
        name1: f.name1.trim(),
        name2: strOrNull(f.name2),
        short_name: strOrNull(f.short_name),
        is_customer: f.is_customer,
        is_supplier: f.is_supplier,
        is_royalty_payee: f.is_royalty_payee,
        sales_staff_id: numOrNull(f.sales_staff_id),
        media_id: numOrNull(f.media_id),
        partner_category_id: numOrNull(f.partner_category_id),
        category_ids: f.category_ids,
        invoice_registration_no: strOrNull(f.invoice_registration_no),
        invoice_note: strOrNull(f.invoice_note),
        invoice_addressee: strOrNull(f.invoice_addressee),
        invoice_contact_name: strOrNull(f.invoice_contact_name),
        shipping_fee_threshold: decOrNull(f.shipping_fee_threshold),
        shipping_fee_amount: decOrNull(f.shipping_fee_amount),
        default_trade_type: f.default_trade_type || null,
        closing_day: numOrNull(f.closing_day),
        payment_month_offset: numOrNull(f.payment_month_offset),
        payment_day: numOrNull(f.payment_day),
        postal_code: strOrNull(f.postal_code),
        address1: strOrNull(f.address1),
        address2: strOrNull(f.address2),
        tel: strOrNull(f.tel),
        fax: strOrNull(f.fax),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="取引先コード" required><Input value={f.partner_code} onChange={(e) => set({ partner_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="区分" required>
              <label className="flex items-center gap-1 text-[12px] mr-3"><input type="checkbox" checked={f.is_customer} onChange={(e) => set({ is_customer: e.target.checked })} />得意先</label>
              <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={f.is_supplier} onChange={(e) => set({ is_supplier: e.target.checked })} />仕入先</label>
              {/* ロイヤリティ規定の「支払先」の候補をこの印で絞る（1001 ご要望） */}
              <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={f.is_royalty_payee} onChange={(e) => set({ is_royalty_payee: e.target.checked })} />ロイヤリティ支払先</label>
            </L>
            <L label="名称1" required><Input value={f.name1} onChange={(e) => set({ name1: e.target.value })} /></L>
            <L label="名称2"><Input value={f.name2} onChange={(e) => set({ name2: e.target.value })} /></L>
            <L label="略称"><Input value={f.short_name} onChange={(e) => set({ short_name: e.target.value })} /></L>
            <L label="取引先カテゴリー" hint="いくつでも選べます（テレビとカタログ両方など）">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {(categories.data?.items ?? []).map((m) => (
                  <Check
                    key={m.id}
                    checked={f.category_ids.includes(Number(m.id))}
                    onChange={(v) => {
                      const id = Number(m.id);
                      const next = v ? [...f.category_ids, id] : f.category_ids.filter((x) => x !== id);
                      // 代表のカテゴリーは、選んだうちの先頭を使う（一覧の表示と既定値に使われる）
                      set({ category_ids: next, partner_category_id: next.length > 0 ? String(next[0]) : '' });
                    }}
                    label={m.name}
                  />
                ))}
                {(categories.data?.items ?? []).length === 0 && <span className="text-[11.5px] text-[var(--color-ink-3)]">「分類・区分・設定」で取引先カテゴリーを登録してください</span>}
              </div>
            </L>
          </div>
          <Section title="販売の条件" />
          <div className="master-grid-2">
            <L label="既定の販売担当" hint="受注に引き継がれます">
              <Select value={f.sales_staff_id} onChange={(e) => set({ sales_staff_id: e.target.value })}><option value="">（なし）</option>{(staff.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
            </L>
            <L label="既定の取引区分">
              <Select value={f.default_trade_type} onChange={(e) => set({ default_trade_type: e.target.value })} className="!w-[120px]"><option value="">（なし）</option><option>買取</option><option>委託</option><option>仕入</option></Select>
            </L>
            <L label="媒体">
              <Select value={f.media_id} onChange={(e) => set({ media_id: e.target.value })}><option value="">（なし）</option>{(media.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
            </L>
            <L label="送料の特別条件" hint="空欄なら全体設定（3万円未満は750円）">
              <Input right value={f.shipping_fee_threshold} onChange={(e) => set({ shipping_fee_threshold: e.target.value })} className="!w-[110px]" placeholder="基準額" />
              <span className="text-[11px] text-[var(--color-ink-3)]">未満なら</span>
              <Input right value={f.shipping_fee_amount} onChange={(e) => set({ shipping_fee_amount: e.target.value })} className="!w-[90px]" placeholder="送料" />
            </L>
          </div>
          <Section title="締め・支払" />
          <div className="master-grid-2">
            <L label="締め日" hint="末日は 99">
              <Select value={f.closing_day} onChange={(e) => set({ closing_day: e.target.value })} className="!w-[120px]">
                <option value="">（なし）</option>
                {[5, 10, 15, 20, 25].map((d) => <option key={d} value={d}>{d}日</option>)}
                <option value="99">末日</option>
              </Select>
            </L>
            <L label="支払">
              <Select value={f.payment_month_offset} onChange={(e) => set({ payment_month_offset: e.target.value })} className="!w-[110px]"><option value="">（なし）</option><option value="0">当月</option><option value="1">翌月</option><option value="2">翌々月</option><option value="3">3か月後</option><option value="4">4か月後</option><option value="5">5か月後</option><option value="6">6か月後</option></Select>
              <Select value={f.payment_day} onChange={(e) => set({ payment_day: e.target.value })} className="!w-[100px]"><option value="">日</option>{[5, 10, 15, 20, 25].map((d) => <option key={d} value={d}>{d}日</option>)}<option value="99">末日</option></Select>
            </L>
            <L label="登録番号" hint="インボイス T+13桁"><Input value={f.invoice_registration_no} onChange={(e) => set({ invoice_registration_no: e.target.value })} className="!w-[180px]" /></L>
            <L label="請求書の備考"><Input value={f.invoice_note} onChange={(e) => set({ invoice_note: e.target.value })} /></L>
            <L label="請求書の宛名" hint="空欄なら取引先名を使います"><Input value={f.invoice_addressee} onChange={(e) => set({ invoice_addressee: e.target.value })} /></L>
            <L label="請求書の担当者名" hint="空欄なら印字しません"><Input value={f.invoice_contact_name} onChange={(e) => set({ invoice_contact_name: e.target.value })} className="!w-[180px]" /></L>
          </div>
          <Section title="住所・連絡先" />
          <div className="master-grid-2">
            <L label="郵便番号"><PostalLookup value={f.postal_code} onChange={(v) => set({ postal_code: v })} onAddress={(a) => set({ address1: a })} /></L>
            <L label="電話／FAX"><Input value={f.tel} onChange={(e) => set({ tel: e.target.value })} className="!w-[140px]" placeholder="電話" /><Input value={f.fax} onChange={(e) => set({ fax: e.target.value })} className="!w-[140px]" placeholder="FAX" /></L>
            <L label="住所1"><Input value={f.address1} onChange={(e) => set({ address1: e.target.value })} /></L>
            <L label="住所2"><Input value={f.address2} onChange={(e) => set({ address2: e.target.value })} /></L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}

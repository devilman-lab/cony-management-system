'use client';

import { useMemo, useState } from 'react';

import { useCodes, useSimpleMaster, useWarehouses } from '@/lib/hooks';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L, PostalLookup, Section } from '@/components/masters/Form';

interface DestRow extends Record<string, unknown> {
  id: number;
  partner_id: number;
  partner_code: string;
  partner_name: string;
  delivery_code: string;
  name: string;
  partner_delivery_no: string | null;
  consignee: string | null;
  delivery_note_print1: string | null;
  delivery_note_print2: string | null;
  work_instruction_id: number | null;
  delivery_rule_id: number | null;
  default_warehouse_id: number | null;
  slip_issue_class_code_id: number | null;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  fax: string | null;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

interface Form {
  partner: Option | null;
  delivery_code: string;
  name: string;
  partner_delivery_no: string;
  consignee: string;
  delivery_note_print1: string;
  delivery_note_print2: string;
  work_instruction_id: string;
  delivery_rule_id: string;
  default_warehouse_id: string;
  slip_issue_class_code_id: string;
  postal_code: string;
  address1: string;
  address2: string;
  tel: string;
  fax: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** 納品先マスタ（M-05）。取引先ごとの届け先。納品書の印字内容・伝票発行区分・既定倉庫はここで決める。 */
export default function ShiptosPage() {
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  const [partner, setPartner] = useState<Option | null>(null);
  const warehouses = useWarehouses();
  const rules = useSimpleMaster('delivery_rules');
  const instructions = useSimpleMaster('work_instructions');
  const slipClasses = useCodes('SLIP_ISSUE_CLASS');

  return (
    <MasterPage<DestRow, Form>
      title="納品先"
      sub="取引先ごとの届け先です。納品書に印字する文言や、伝票を「単価あり／上代あり／単価なし」のどれで出すかを決めます"
      functionId="M-05"
      listPath="/masters/delivery-destinations"
      writePath="/masters/delivery-destinations"
      extraFilters={{ partner_id: partner?.id }}
      modalWidth={760}
      toolbar={<SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" />}
      columns={[
        { key: 'partner_name', label: '取引先', width: 180, render: (r) => <span><Num className="text-[var(--color-ink-3)] mr-1">{r.partner_code}</Num>{r.partner_name}</span> },
        { key: 'delivery_code', label: 'コード', width: 100, render: (r) => <Num className="font-semibold">{r.delivery_code}</Num> },
        { key: 'name', label: '納品先名' },
        { key: 'partner_delivery_no', label: '先方の店番', width: 100, render: (r) => <Num>{r.partner_delivery_no ?? ''}</Num> },
        { key: 'address1', label: '住所', render: (r) => <span className="truncate block max-w-[260px]">{r.address1 ?? ''}{r.address2 ?? ''}</span> },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({
        partner: partner, delivery_code: '', name: '', partner_delivery_no: '', consignee: '', delivery_note_print1: '', delivery_note_print2: '',
        work_instruction_id: '', delivery_rule_id: '', default_warehouse_id: '', slip_issue_class_code_id: '',
        postal_code: '', address1: '', address2: '', tel: '', fax: '', sort_order: '', note: '',
      })}
      toForm={(r) => ({
        partner: { id: r.partner_id, label: r.partner_name, sub: r.partner_code },
        delivery_code: r.delivery_code, name: r.name, partner_delivery_no: s(r.partner_delivery_no), consignee: s(r.consignee),
        delivery_note_print1: s(r.delivery_note_print1), delivery_note_print2: s(r.delivery_note_print2),
        work_instruction_id: s(r.work_instruction_id), delivery_rule_id: s(r.delivery_rule_id), default_warehouse_id: s(r.default_warehouse_id), slip_issue_class_code_id: s(r.slip_issue_class_code_id),
        postal_code: s(r.postal_code), address1: s(r.address1), address2: s(r.address2), tel: s(r.tel), fax: s(r.fax), sort_order: s(r.sort_order), note: s(r.note),
      })}
      toBody={(f) => ({
        partner_id: f.partner?.id,
        delivery_code: f.delivery_code.trim(),
        name: f.name.trim(),
        partner_delivery_no: strOrNull(f.partner_delivery_no),
        consignee: strOrNull(f.consignee),
        delivery_note_print1: strOrNull(f.delivery_note_print1),
        delivery_note_print2: strOrNull(f.delivery_note_print2),
        work_instruction_id: numOrNull(f.work_instruction_id),
        delivery_rule_id: numOrNull(f.delivery_rule_id),
        default_warehouse_id: numOrNull(f.default_warehouse_id),
        slip_issue_class_code_id: numOrNull(f.slip_issue_class_code_id),
        postal_code: strOrNull(f.postal_code),
        address1: strOrNull(f.address1),
        address2: strOrNull(f.address2),
        tel: strOrNull(f.tel),
        fax: strOrNull(f.fax),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set, editing) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="取引先" required><SearchSelect value={f.partner} onChange={(o) => set({ partner: o })} fetchOptions={fetchCustomers} placeholder="得意先を検索" width="100%" disabled={!!editing} /></L>
            <L label="納品先コード" required><Input value={f.delivery_code} onChange={(e) => set({ delivery_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="納品先名" required><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></L>
            <L label="先方の店番・納品先番号" hint="販社CSVの届け先の突き合わせに使います"><Input value={f.partner_delivery_no} onChange={(e) => set({ partner_delivery_no: e.target.value })} className="!w-[180px]" /></L>
            <L label="荷受人"><Input value={f.consignee} onChange={(e) => set({ consignee: e.target.value })} /></L>
            <L label="既定の出荷倉庫">
              <Select value={f.default_warehouse_id} onChange={(e) => set({ default_warehouse_id: e.target.value })}><option value="">（受注時に選ぶ）</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}</Select>
            </L>
          </div>
          <Section title="伝票・納品書" />
          <div className="master-grid-2">
            <L label="伝票発行区分" hint="納品書に単価・上代を出すか">
              <Select value={f.slip_issue_class_code_id} onChange={(e) => set({ slip_issue_class_code_id: e.target.value })}><option value="">（既定）</option>{(slipClasses.data?.values ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </L>
            <L label="納品ルール">
              <Select value={f.delivery_rule_id} onChange={(e) => set({ delivery_rule_id: e.target.value })}><option value="">（なし）</option>{(rules.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
            </L>
            <L label="作業指示">
              <Select value={f.work_instruction_id} onChange={(e) => set({ work_instruction_id: e.target.value })}><option value="">（なし）</option>{(instructions.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
            </L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
            <L label="納品書 印字1" hint="納品書の欄外に印字する文言"><Input value={f.delivery_note_print1} onChange={(e) => set({ delivery_note_print1: e.target.value })} /></L>
            <L label="納品書 印字2"><Input value={f.delivery_note_print2} onChange={(e) => set({ delivery_note_print2: e.target.value })} /></L>
          </div>
          <Section title="住所・連絡先" />
          <div className="master-grid-2">
            <L label="郵便番号"><PostalLookup value={f.postal_code} onChange={(v) => set({ postal_code: v })} onAddress={(a) => set({ address1: a })} /></L>
            <L label="電話／FAX"><Input value={f.tel} onChange={(e) => set({ tel: e.target.value })} className="!w-[140px]" placeholder="電話" /><Input value={f.fax} onChange={(e) => set({ fax: e.target.value })} className="!w-[140px]" placeholder="FAX" /></L>
            <L label="住所1"><Input value={f.address1} onChange={(e) => set({ address1: e.target.value })} /></L>
            <L label="住所2"><Input value={f.address2} onChange={(e) => set({ address2: e.target.value })} /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}

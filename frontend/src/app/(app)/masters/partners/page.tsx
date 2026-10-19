'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useCodes, useSimpleMaster, type CodeValue } from '@/lib/hooks';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { ActiveToggleField, L, PostalLookup, Section } from '@/components/masters/Form';

interface PartnerRow extends Record<string, unknown> {
  id: number;
  partner_code: string;
  name1: string;
  short_name: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  is_royalty_payee: boolean;
  /** 海外の取引先（2026-10-09 マスター編②）。消費税免税区分が「なし」以外 */
  is_overseas: boolean;
  /** 消費税免税区分の呼び名（免税（税抜扱い）／課税対象外）。海外でなければ null（2026-10-16 マスター編_3 M3-04・M3-07） */
  overseas_tax_label: string | null;
  /** 粗利調整販社（対象／対象外。M3-04・M3-10） */
  gross_margin_adjust_name: string | null;
  closing_day: number | null;
  /** 支払①（何か月後・何日）。一覧の「支払」に「翌月末日」の形で出す（M3-04） */
  payment_month_offset: number | null;
  payment_day: number | null;
  default_trade_type: string | null;
  media_name: string | null;
  sales_staff_name: string | null;
  is_active: boolean;
}

/** 区分（M3-05）。得意先・仕入先の印の組をプルダウンの1つで選ぶ */
type Role = 'customer' | 'supplier' | 'both';

interface Form {
  partner_code: string;
  role: Role;
  /** ロイヤリティ規定の「支払先」の候補に出す印。仕入先を含むときだけ画面に出す（M3-05・M3-06） */
  is_royalty_payee: boolean;
  name1: string;
  name2: string;
  short_name: string;
  /** 消費税免税区分（M3-07）。''＝なし（国内）／exempt＝免税（税抜扱い）／non_taxable＝課税対象外 */
  overseas_tax_class: '' | 'exempt' | 'non_taxable';
  /** 粗利調整販社（区分値 GROSS_MARGIN_ADJUST。M3-10） */
  gross_margin_adjust_code_id: string;
  sales_staff_id: string;
  media_id: string;
  shipping_fee_threshold: string;
  shipping_fee_amount: string;
  default_trade_type: string;
  closing_day: string;
  invoice_registration_no: string;
  payment_month_offset: string;
  payment_day: string;
  /** 支払②・入金方法①②・請求書送付方法（M3-11）。登録・表示だけで、支払予定日は支払①で決まる */
  payment_month_offset2: string;
  payment_day2: string;
  receipt_method1_code_id: string;
  receipt_method2_code_id: string;
  invoice_send_method_code_id: string;
  invoice_note: string;
  invoice_addressee: string;
  invoice_contact_name: string;
  postal_code: string;
  tel: string;
  fax: string;
  address1: string;
  address2: string;
  invoice_email: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

const EMPTY: Form = {
  partner_code: '', role: 'customer', is_royalty_payee: false, name1: '', name2: '', short_name: '',
  overseas_tax_class: '', gross_margin_adjust_code_id: '',
  sales_staff_id: '', media_id: '', shipping_fee_threshold: '', shipping_fee_amount: '', default_trade_type: '',
  closing_day: '', invoice_registration_no: '', payment_month_offset: '', payment_day: '', payment_month_offset2: '', payment_day2: '',
  receipt_method1_code_id: '', receipt_method2_code_id: '', invoice_send_method_code_id: '', invoice_note: '',
  invoice_addressee: '', invoice_contact_name: '', postal_code: '', tel: '', fax: '', address1: '', address2: '', invoice_email: '',
  sort_order: '', note: '',
};

/** 支払の月の選択肢（当月〜6か月後）。支払①・支払②で同じ */
const PAY_MONTHS: [string, string][] = [['0', '当月'], ['1', '翌月'], ['2', '翌々月'], ['3', '3か月後'], ['4', '4か月後'], ['5', '5か月後'], ['6', '6か月後']];
/** 締め日・支払日の選択肢（5〜25日・末日=99） */
const DAYS = [5, 10, 15, 20, 25];
const dayLabel = (d: number) => (d >= 99 ? '末日' : `${d}日`);

/** 一覧の「支払」。支払①を「翌月末日」の形で */
function paymentLabel(month: number | null, day: number | null): string {
  if (month === null && day === null) return '';
  const m = month === null ? '' : (PAY_MONTHS.find(([v]) => Number(v) === month)?.[1] ?? `${month}か月後`);
  return `${m}${day === null ? '' : dayLabel(day)}`;
}

/** 区分の選択肢の値 → 得意先・仕入先の印 */
const roleOf = (customer: boolean, supplier: boolean): Role => (customer && supplier ? 'both' : supplier ? 'supplier' : 'customer');

/** 区分値のプルダウン（（なし）＋選択肢）。「使わない」にした値のままの取引先もそのまま開けるよう、今の値は残す */
function CodeSelect({ value, onChange, codes, width }: { value: string; onChange: (v: string) => void; codes: CodeValue[] | undefined; width: number }) {
  const list = codes ?? [];
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} style={{ width }}>
      <option value="">（なし）</option>
      {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      {value && codes && !list.some((c) => String(c.id) === value) && <option value={value}>（使わない値）</option>}
    </Select>
  );
}

/** 支払の「月」と「日」のプルダウン（支払①・支払②） */
function PaymentSelect({ month, day, onChange }: { month: string; day: string; onChange: (patch: { month?: string; day?: string }) => void }) {
  return (
    <>
      <Select value={month} onChange={(e) => onChange({ month: e.target.value })} className="!w-[110px]">
        <option value="">（なし）</option>
        {PAY_MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      <Select value={day} onChange={(e) => onChange({ day: e.target.value })} className="!w-[100px]">
        <option value="">日</option>
        {DAYS.map((d) => <option key={d} value={d}>{d}日</option>)}
        <option value="99">末日</option>
      </Select>
    </>
  );
}

/** 取引先マスタ（M-01）。得意先・仕入先の両方をここで持つ。 */
export default function PartnersPage() {
  const [role, setRole] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [staffId, setStaffId] = useState('');
  const staff = useSimpleMaster('sales_staff');
  const media = useSimpleMaster('media');
  // 粗利調整販社・入金方法・請求書送付方法の選択肢（「分類・区分・設定」の区分値。M3-10・M3-11）
  const grossMargin = useCodes('GROSS_MARGIN_ADJUST');
  const receiptMethods = useCodes('RECEIPT_METHOD');
  const sendMethods = useCodes('INVOICE_SEND_METHOD');

  return (
    <MasterPage<PartnerRow, Form>
      title="取引先"
      sub="得意先・仕入先。締め日・支払条件・既定の販売担当・送料の特別条件はここで決めます"
      functionId="M-01"
      csvSlug="partners"
      csvHint="消費税免税区分は「免税（税抜扱い）」「課税対象外」のどちらか（空欄はなし）。粗利調整販社・入金方法・請求書送付方法は区分値のコード（例 TARGET・TRANSFER・MAIL）で入れます。"
      listPath="/masters/partners"
      writePath="/masters/partners"
      extraFilters={{
        role: role || undefined,
        media_id: mediaId || undefined,
        sales_staff_id: staffId || undefined,
      }}
      modalWidth={840}
      // 表示／非表示は「表示順」と同じ行に置く（M3-12）
      placeActiveToggle
      // 1280 では操作のボタンを「名称」の欄の下に入れる（操作の列まで入れると枠に収まらず、ボタンが右に隠れていた。2026-10-18 受入 W1 N1）
      narrowActions="name1"
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
        </>
      }
      // 名称の列は幅を決めて短くし（M3-03）、粗利調整販社・支払・消費税免税区分を足す（M3-04）。
      // 列幅の合計は 986px（1280 の枠 約 1025px に収まる。1440 以上は右に操作の列 122px を足して 1108px）
      columns={[
        { key: 'partner_code', label: 'コード', width: 84, nowrap: true, render: (r) => <Num className="font-semibold">{r.partner_code}</Num> },
        { key: 'name1', label: '名称', width: 170 },
        { key: 'short_name', label: '略称', width: 110, render: (r) => r.short_name ?? '' },
        { key: '_role', label: '区分', width: 96, render: (r) => <span className="flex flex-wrap gap-1">{r.is_customer && <Badge>得意先</Badge>}{r.is_supplier && <Badge>仕入先</Badge>}{r.is_royalty_payee && <Badge>ロイヤリティ</Badge>}</span> },
        { key: 'media_name', label: '媒体', width: 70, render: (r) => r.media_name ?? '' },
        { key: 'sales_staff_name', label: '販売担当', width: 72, render: (r) => r.sales_staff_name ?? '' },
        { key: 'default_trade_type', label: '取引', width: 44, render: (r) => r.default_trade_type ?? '' },
        { key: 'gross_margin_adjust_name', label: '粗利調整販社', width: 64, render: (r) => r.gross_margin_adjust_name ?? '' },
        { key: 'closing_day', label: '締め日', r: true, width: 52, render: (r) => (r.closing_day ? dayLabel(r.closing_day) : '') },
        { key: '_payment', label: '支払', width: 84, nowrap: true, render: (r) => paymentLabel(r.payment_month_offset, r.payment_day) },
        { key: 'overseas_tax_label', label: '消費税免税区分', width: 96, render: (r) => r.overseas_tax_label ?? '' },
        { key: 'is_active', label: '', width: 44, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      // 削除の確認に対象のコードと名前を出す（2026-10-12 受入 No.1 注記「このデータを完全に消します」だけで何を消すか分からない）
      rowLabel={(r) => `取引先 ${r.partner_code}　${r.name1}`}
      empty={() => EMPTY}
      toForm={async (r) => {
        const d = await api.get<Record<string, unknown>>(`/masters/partners/${r.id}`);
        const f: Record<string, unknown> = {};
        for (const k of Object.keys(EMPTY) as (keyof Form)[]) {
          f[k] = typeof EMPTY[k] === 'boolean' ? Boolean(d[k]) : k === 'shipping_fee_threshold' || k === 'shipping_fee_amount' ? dec(d[k]) : s(d[k]);
        }
        f.role = roleOf(Boolean(d.is_customer), Boolean(d.is_supplier));
        // 海外でなければ「なし」。海外で区分を選ぶ前の取引先は、今効いているシステム設定の値（overseas_tax_class）を出す
        f.overseas_tax_class = s(d.overseas_tax_class);
        return f as unknown as Form;
      }}
      toBody={(f) => ({
        partner_code: f.partner_code.trim(),
        name1: f.name1.trim(),
        name2: strOrNull(f.name2),
        short_name: strOrNull(f.short_name),
        is_customer: f.role !== 'supplier',
        is_supplier: f.role !== 'customer',
        is_royalty_payee: f.is_royalty_payee,
        // 消費税免税区分。「なし」は国内（is_overseas＝false）
        is_overseas: f.overseas_tax_class !== '',
        overseas_tax_treatment: f.overseas_tax_class || null,
        gross_margin_adjust_code_id: numOrNull(f.gross_margin_adjust_code_id),
        sales_staff_id: numOrNull(f.sales_staff_id),
        media_id: numOrNull(f.media_id),
        shipping_fee_threshold: decOrNull(f.shipping_fee_threshold),
        shipping_fee_amount: decOrNull(f.shipping_fee_amount),
        default_trade_type: f.default_trade_type || null,
        closing_day: numOrNull(f.closing_day),
        invoice_registration_no: strOrNull(f.invoice_registration_no),
        payment_month_offset: numOrNull(f.payment_month_offset),
        payment_day: numOrNull(f.payment_day),
        payment_month_offset2: numOrNull(f.payment_month_offset2),
        payment_day2: numOrNull(f.payment_day2),
        receipt_method1_code_id: numOrNull(f.receipt_method1_code_id),
        receipt_method2_code_id: numOrNull(f.receipt_method2_code_id),
        invoice_send_method_code_id: numOrNull(f.invoice_send_method_code_id),
        invoice_note: strOrNull(f.invoice_note),
        invoice_addressee: strOrNull(f.invoice_addressee),
        invoice_contact_name: strOrNull(f.invoice_contact_name),
        postal_code: strOrNull(f.postal_code),
        tel: strOrNull(f.tel),
        fax: strOrNull(f.fax),
        address1: strOrNull(f.address1),
        address2: strOrNull(f.address2),
        invoice_email: strOrNull(f.invoice_email),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      // 並びはお客様の指定どおり（2026-10-16 マスター編_3 M3-12）。取引先カテゴリー・通貨は取引先では扱わない（M3-08・M3-09）
      renderForm={(f, set, _editing, active) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="取引先コード" required><Input value={f.partner_code} onChange={(e) => set({ partner_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="区分" required>
              <Select
                value={f.role}
                // 得意先だけにしたら、ロイヤリティ支払先の印も外す（仕入先のときだけの印）
                onChange={(e) => set({ role: e.target.value as Role, ...(e.target.value === 'customer' ? { is_royalty_payee: false } : {}) })}
                className="!w-[150px]"
              >
                <option value="customer">得意先</option>
                <option value="supplier">仕入先</option>
                <option value="both">得意先・仕入先</option>
              </Select>
              {/* ロイヤリティ規定の「支払先」の候補をこの印で絞る（1001 ご要望）。仕入先を含むときだけ出す（M3-05）。
                  得意先だけで印が付いている取引先は、外せるように出しておく */}
              {(f.role !== 'customer' || f.is_royalty_payee) && (
                <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={f.is_royalty_payee} onChange={(e) => set({ is_royalty_payee: e.target.checked })} />ロイヤリティ支払先</label>
              )}
            </L>
            <L label="名称①" required><Input value={f.name1} onChange={(e) => set({ name1: e.target.value })} /></L>
            <L label="名称②"><Input value={f.name2} onChange={(e) => set({ name2: e.target.value })} /></L>
            <L label="略称"><Input value={f.short_name} onChange={(e) => set({ short_name: e.target.value })} /></L>
            {/* 取引先ごとの消費税の扱い（M3-07。以前の「海外」）。受注・納品書・請求書・仕入の税はこれに従う */}
            <L label="消費税免税区分" hint="なし以外は消費税 0（受注・納品書・請求書・仕入）">
              <Select value={f.overseas_tax_class} onChange={(e) => set({ overseas_tax_class: e.target.value as Form['overseas_tax_class'] })} className="!w-[170px]">
                <option value="">なし</option>
                <option value="exempt">免税（税抜扱い）</option>
                <option value="non_taxable">課税対象外</option>
              </Select>
            </L>
            <L label="粗利調整販社">
              <CodeSelect value={f.gross_margin_adjust_code_id} onChange={(v) => set({ gross_margin_adjust_code_id: v })} codes={grossMargin.data?.values} width={150} />
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
                {DAYS.map((d) => <option key={d} value={d}>{d}日</option>)}
                <option value="99">末日</option>
              </Select>
            </L>
            <L label="登録番号" hint="インボイス T+13桁"><Input value={f.invoice_registration_no} onChange={(e) => set({ invoice_registration_no: e.target.value })} className="!w-[180px]" /></L>
            <L label="支払①" hint="支払予定日はこちらで決まります">
              <PaymentSelect month={f.payment_month_offset} day={f.payment_day} onChange={(p) => set({ ...(p.month !== undefined ? { payment_month_offset: p.month } : {}), ...(p.day !== undefined ? { payment_day: p.day } : {}) })} />
            </L>
            <L label="支払②" hint="登録と表示だけです">
              <PaymentSelect month={f.payment_month_offset2} day={f.payment_day2} onChange={(p) => set({ ...(p.month !== undefined ? { payment_month_offset2: p.month } : {}), ...(p.day !== undefined ? { payment_day2: p.day } : {}) })} />
            </L>
            <L label="入金方法①">
              <CodeSelect value={f.receipt_method1_code_id} onChange={(v) => set({ receipt_method1_code_id: v })} codes={receiptMethods.data?.values} width={150} />
            </L>
            <L label="入金方法②">
              <CodeSelect value={f.receipt_method2_code_id} onChange={(v) => set({ receipt_method2_code_id: v })} codes={receiptMethods.data?.values} width={150} />
            </L>
            <L label="請求書送付方法">
              <CodeSelect value={f.invoice_send_method_code_id} onChange={(v) => set({ invoice_send_method_code_id: v })} codes={sendMethods.data?.values} width={150} />
            </L>
            <L label="請求書の備考"><Input value={f.invoice_note} onChange={(e) => set({ invoice_note: e.target.value })} /></L>
          </div>
          <Section title="住所・連絡先" />
          <div className="master-grid-2">
            <L label="請求書の宛名" hint="空欄なら取引先名を使います"><Input value={f.invoice_addressee} onChange={(e) => set({ invoice_addressee: e.target.value })} /></L>
            <L label="請求書の担当者名" hint="空欄なら印字しません"><Input value={f.invoice_contact_name} onChange={(e) => set({ invoice_contact_name: e.target.value })} className="!w-[180px]" /></L>
            <L label="郵便番号"><PostalLookup value={f.postal_code} onChange={(v) => set({ postal_code: v })} onAddress={(a) => set({ address1: a })} /></L>
            <L label="電話／FAX"><Input value={f.tel} onChange={(e) => set({ tel: e.target.value })} className="!w-[140px]" placeholder="電話" /><Input value={f.fax} onChange={(e) => set({ fax: e.target.value })} className="!w-[140px]" placeholder="FAX" /></L>
            {/* 住所は半分の幅だと切れるので、住所①の下に住所②を置き、どちらも横幅いっぱいにする（2026-10-09 マスター編② M-03） */}
            <L label="住所①" wide><Input value={f.address1} onChange={(e) => set({ address1: e.target.value })} /></L>
            <L label="住所②" wide><Input value={f.address2} onChange={(e) => set({ address2: e.target.value })} /></L>
            <L label="請求書送付先メールアドレス" wide><Input type="email" value={f.invoice_email} onChange={(e) => set({ invoice_email: e.target.value })} className="!w-[360px]" /></L>
            {/* 「表示／非表示｜表示順」を同じ行に（M3-12）。表示／非表示は編集のときだけ（新規・コピーは「表示」で登録） */}
            {active.show && <ActiveToggleField value={active.value} onChange={active.onChange} />}
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}

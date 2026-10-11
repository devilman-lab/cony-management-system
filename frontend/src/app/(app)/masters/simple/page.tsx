'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, Input, Modal, Num, PageHead, Select, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L } from '@/components/masters/Form';

const KINDS: { kind: string; label: string }[] = [
  { kind: 'brands', label: 'ブランド' },
  { kind: 'categories', label: 'カテゴリー' },
  { kind: 'product_classes', label: '商品分類' },
  { kind: 'colors', label: 'カラー' },
  { kind: 'sizes', label: 'サイズ' },
  { kind: 'sales_staff', label: '販売担当' },
  { kind: 'sales_categories', label: '販売カテゴリー' },
  { kind: 'partner_categories', label: '取引先カテゴリー' },
  { kind: 'media', label: '媒体' },
  { kind: 'delivery_rules', label: '納品ルール' },
  { kind: 'work_instructions', label: '作業指示内容' },
];

interface SimpleRow extends Record<string, unknown> {
  id: number;
  code: string;
  name: string;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
  lead_time_days?: number | null;
  allowed_weekdays?: string | null;
  rule_body?: string | null;
  instruction_body?: string | null;
}
interface SimpleForm {
  code: string;
  name: string;
  sort_order: string;
  note: string;
  lead_time_days: string;
  allowed_weekdays: string;
  rule_body: string;
  instruction_body: string;
}
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** 分類マスタ（M-16）11種・汎用区分・システム設定を1画面のタブで扱う。 */
export default function SimpleMastersPage() {
  const [tab, setTab] = useState<string>('brands');
  return (
    <div>
      <div className="px-4 pt-3 flex flex-wrap gap-1">
        {KINDS.map((k) => <TabBtn key={k.kind} active={tab === k.kind} onClick={() => setTab(k.kind)}>{k.label}</TabBtn>)}
        {FIXED_CODE_TABS.map((t) => <TabBtn key={t.tab} active={tab === t.tab} onClick={() => setTab(t.tab)}>{t.title}</TabBtn>)}
        <TabBtn active={tab === '_codes'} onClick={() => setTab('_codes')}>区分値</TabBtn>
        <TabBtn active={tab === '_settings'} onClick={() => setTab('_settings')}>システム設定</TabBtn>
      </div>
      {tab === '_codes' ? (
        <CodesTab />
      ) : tab === '_settings' ? (
        <SettingsTab />
      ) : FIXED_CODE_TABS.some((t) => t.tab === tab) ? (
        <CodesTab key={tab} fixed={FIXED_CODE_TABS.find((t) => t.tab === tab)} />
      ) : (
        <SimpleTab key={tab} kind={tab} label={KINDS.find((k) => k.kind === tab)?.label ?? ''} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`px-3 py-1.5 rounded-full text-[12px] border transition ${active ? 'bg-[var(--color-brand-700)] text-white border-[var(--color-brand-700)]' : 'bg-white border-[var(--color-line)] hover:bg-[#f4f7f8]'}`}>
      {children}
    </button>
  );
}

function SimpleTab({ kind, label }: { kind: string; label: string }) {
  const isRule = kind === 'delivery_rules';
  const isInstr = kind === 'work_instructions';
  return (
    <MasterPage<SimpleRow, SimpleForm>
      title={label}
      sub={kind === 'sales_staff' ? '受注の「販売担当」として選ぶ人。ログインする利用者とは別に管理します（9/17 ご確認）' : kind === 'sales_categories' ? '引当在庫（確保数）の単位になります' : undefined}
      functionId="M-16"
      csvSlug={kind.replace(/_/g, "-")}
      listPath={`/masters/simple/${kind}`}
      writePath={`/masters/simple/${kind}`}
      modalWidth={560}
      columns={[
        { key: 'code', label: 'コード', width: 110, render: (r) => <Num className="font-semibold">{r.code}</Num> },
        { key: 'name', label: '名称' },
        ...(isRule ? [{ key: 'lead_time_days', label: 'リードタイム', r: true, width: 100, render: (r: SimpleRow) => (r.lead_time_days != null ? `${r.lead_time_days} 日` : '') }, { key: 'allowed_weekdays', label: '納品可能曜日', width: 110, render: (r: SimpleRow) => r.allowed_weekdays ?? '' }] : []),
        { key: 'sort_order', label: '表示順', r: true, width: 70, render: (r) => r.sort_order ?? '' },
        { key: 'note', label: '備考', render: (r) => <span className="truncate block max-w-[260px]">{(isInstr ? r.instruction_body : r.note) ?? ''}</span> },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ code: '', name: '', sort_order: '', note: '', lead_time_days: '', allowed_weekdays: '', rule_body: '', instruction_body: '' })}
      toForm={(r) => ({ code: r.code, name: r.name, sort_order: s(r.sort_order), note: s(r.note), lead_time_days: s(r.lead_time_days), allowed_weekdays: s(r.allowed_weekdays), rule_body: s(r.rule_body), instruction_body: s(r.instruction_body) })}
      toBody={(f) => ({
        code: f.code.trim(),
        name: f.name.trim(),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
        ...(isRule ? { lead_time_days: numOrNull(f.lead_time_days), allowed_weekdays: strOrNull(f.allowed_weekdays), rule_body: strOrNull(f.rule_body) } : {}),
        ...(isInstr ? { instruction_body: f.instruction_body } : {}),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="コード" required><Input value={f.code} onChange={(e) => set({ code: e.target.value })} className="!w-[150px]" /></L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
            <L label="名称" required><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></L>
            {isRule && <L label="リードタイム（日）"><Input right value={f.lead_time_days} onChange={(e) => set({ lead_time_days: e.target.value })} className="!w-[90px]" /></L>}
            {isRule && <L label="納品可能曜日" hint="例：月火水木金"><Input value={f.allowed_weekdays} onChange={(e) => set({ allowed_weekdays: e.target.value })} className="!w-[160px]" /></L>}
          </div>
          {isRule && <Textarea rows={3} value={f.rule_body} onChange={(e) => set({ rule_body: e.target.value })} placeholder="ルールの内容（納品書・出荷指示に出ます）" />}
          {isInstr && <Textarea rows={3} value={f.instruction_body} onChange={(e) => set({ instruction_body: e.target.value })} placeholder="作業指示の本文（出荷時に印字）" />}
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}

/* ---------- 汎用区分 ---------- */

interface CodeCategory { id: number; code: string; name: string }
interface CodeRow extends Record<string, unknown> {
  id: number;
  code: string;
  name: string;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

/**
 * 区分値のうち、独立したタブで扱うもの（2026-10-09 マスター編② M-23「売上仕入用の通貨追加／仕入用の経費科目追加」）。
 * 中身は区分値そのもの（CURRENCY・EXPENSE_DIVISION）。「区分値」タブからカテゴリーを選ぶ手間を省くためにタブを分けた。
 */
interface FixedCodeTab { tab: string; category: string; title: string; sub: string; codeHint?: string }
const FIXED_CODE_TABS: FixedCodeTab[] = [
  { tab: '_currency', category: 'CURRENCY', title: '通貨', sub: '売上・仕入・入出金で選ぶ通貨です。コードは英大文字3文字（USD・CNY など）', codeHint: '英大文字3文字' },
  { tab: '_expense', category: 'EXPENSE_DIVISION', title: '経費科目', sub: '仕入・経費の登録で選ぶ経費科目（勘定科目にあたるもの）です' },
];

function CodesTab({ fixed }: { fixed?: FixedCodeTab }) {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const cats = useFetch<CodeCategory[]>(fixed ? null : '/masters/code-categories');
  const [cat, setCat] = useState('');
  const current = fixed?.category ?? (cat || cats.data?.[0]?.code || '');
  // 「使わない」にした値も含めて取る（戻せるようにするため）。選択肢の API は有効な値だけを返す
  const values = useFetch<{ category: CodeCategory; values: CodeRow[] }>(current ? `/masters/codes/${current}/all` : null);
  const [showInactive, setShowInactive] = useState(false);
  const rows = (values.data?.values ?? []).filter((r) => showInactive || r.is_active);
  const setActive = async (r: CodeRow, active: boolean) => {
    if (!active && !(await confirm(`「${r.name}」を使わないにしますか`, '選択肢から外れます。登録済みの伝票はそのまま読めます。'))) return;
    try {
      await api.patch(`/masters/codes/${r.id}`, { is_active: active });
      toast(active ? '有効に戻しました' : '使わないにしました', 'good');
      await values.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CodeRow | null>(null);
  const [f, setF] = useState({ code: '', name: '', sort_order: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const body = { code: f.code.trim(), name: f.name.trim(), sort_order: numOrNull(f.sort_order), note: strOrNull(f.note) };
      if (editing) await api.patch(`/masters/codes/${editing.id}`, { name: body.name, sort_order: body.sort_order, note: body.note });
      else await api.post('/masters/codes', { ...body, code_category_code: current });
      toast(editing ? '更新しました' : '登録しました', 'good');
      setOpen(false);
      await values.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead title={fixed?.title ?? '区分値'} sub={fixed?.sub ?? '伝票で選ぶ区分（調整理由・品質区分・伝票発行区分など）。プログラムを直さずに選択肢を足せます'} right={can('M-16', 'create') && <Button variant="primary" icon="plus" onClick={() => { setEditing(null); setF({ code: '', name: '', sort_order: '', note: '' }); setError(null); setOpen(true); }}>{fixed ? '新規登録' : '値を追加'}</Button>} />
      <Card>
        <Toolbar right={<label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />使わないものも表示</label>}>
          {!fixed && (
            <Select value={current} onChange={(e) => setCat(e.target.value)} className="!w-[280px]">
              {(cats.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}（{c.code}）</option>)}
            </Select>
          )}
        </Toolbar>
        {values.error ? <div className="p-3"><ErrorBox error={values.error} /></div> : null}
        <DataTable<CodeRow>
          columns={[
            { key: 'code', label: 'コード', width: 140, render: (r) => <Num className="font-semibold">{r.code}</Num> },
            { key: 'name', label: '名称' },
            { key: 'sort_order', label: '表示順', r: true, width: 70, render: (r) => r.sort_order ?? '' },
            { key: 'note', label: '備考', render: (r) => <span className="truncate block max-w-[260px]">{r.note ?? ''}</span> },
            { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
            {
              key: '_act',
              label: '',
              width: 170,
              render: (r) =>
                can('M-16', 'update') && (
                  <span className="flex gap-1 justify-end">
                    <Button size="sm" onClick={() => { setEditing(r); setF({ code: r.code, name: r.name, sort_order: r.sort_order == null ? '' : String(r.sort_order), note: r.note ?? '' }); setError(null); setOpen(true); }}>編集</Button>
                    {r.is_active ? <Button size="sm" variant="danger" onClick={() => setActive(r, false)}>使わない</Button> : <Button size="sm" onClick={() => setActive(r, true)}>有効に戻す</Button>}
                  </span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          loading={values.loading}
          rowClassName={(r) => (r.is_active ? '' : 'opacity-50')}
        />
      </Card>
      <Modal open={open} title={editing ? `${fixed?.title ?? '区分値'}の編集` : `${fixed?.title ?? '区分値'}の追加`} onClose={() => setOpen(false)} width={480} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <L label="カテゴリー"><span className="text-[12px]">{values.data?.category.name ?? current}</span></L>
        <L label="コード" required hint={fixed?.codeHint}><Input value={f.code} onChange={(e) => setF({ ...f, code: fixed?.category === 'CURRENCY' ? e.target.value.toUpperCase() : e.target.value })} className="!w-[150px]" disabled={!!editing} /></L>
        <L label="名称" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></L>
        <L label="表示順"><Input right value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} className="!w-[90px]" /></L>
        <L label="備考"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></L>
      </Modal>
    </div>
  );
}

/* ---------- システム設定 ---------- */

/**
 * 設定値の見せ方。値そのもの（英字）だけでは意味が分からないものに呼び名を添える。
 * 海外取引先の消費税（2026-10-09 マスター編②）は exempt／non_taxable では選べないため。
 */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  OVERSEAS_TAX_TREATMENT: { exempt: '免税（税抜扱い）', non_taxable: '課税対象外' },
};
const valueLabel = (key: string, value: string) => (VALUE_LABELS[key]?.[value] ? `${VALUE_LABELS[key][value]}（${value}）` : value);

interface Setting extends Record<string, unknown> {
  setting_key: string;
  setting_group: string;
  name: string;
  value_text: string | null;
  value_type: string;
  allowed_values: string | null;
  description: string | null;
  is_user_editable: boolean;
}

function SettingsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const list = useFetch<Setting[]>('/masters/settings');
  const [editing, setEditing] = useState<Setting | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!editing) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/masters/settings/${editing.setting_key}`, { value_text: value === '' ? null : value });
      toast('設定を変えました。次の処理から効きます', 'good');
      setEditing(null);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const groups = Array.from(new Set((list.data ?? []).map((x) => x.setting_group)));
  const allowed = editing?.allowed_values ? editing.allowed_values.split(/[,、|]/).map((x) => x.trim()).filter(Boolean) : [];

  return (
    <div className="page-body">
      <PageHead title="システム設定" sub="端数処理・送料の条件・引当のタイミング・自社情報など、プログラムを直さずに変えられる項目です" />
      {list.error ? <ErrorBox error={list.error} /> : null}
      {groups.map((g) => (
        <Card key={g}>
          <CardHead title={g} />
          <table className="tbl">
            <tbody>
              {(list.data ?? []).filter((x) => x.setting_group === g).map((x) => (
                <tr key={x.setting_key}>
                  <td style={{ width: 240 }}>
                    <div className="font-semibold">{x.name}</div>
                    <div className="text-[10.5px] text-[var(--color-ink-3)] num">{x.setting_key}</div>
                  </td>
                  <td style={{ width: 200 }} className="num">{x.value_text == null ? <span className="text-[var(--color-ink-3)]">（未設定）</span> : valueLabel(x.setting_key, x.value_text)}</td>
                  <td className="text-[11.5px] text-[var(--color-ink-2)]">{x.description ?? ''}</td>
                  <td style={{ width: 80 }} className="r">
                    {x.is_user_editable ? (can('M-16', 'update') && <Button size="sm" onClick={() => { setEditing(x); setValue(x.value_text ?? ''); setError(null); }}>変更</Button>) : <span className="text-[10.5px] text-[var(--color-ink-3)]">固定</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      <Modal open={!!editing} title={editing?.name ?? ''} onClose={() => setEditing(null)} width={480} footer={<><Button onClick={() => setEditing(null)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>変更する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {editing?.description && <div className="text-[11.5px] text-[var(--color-ink-2)] mb-3">{editing.description}</div>}
        {allowed.length > 0 ? (
          <Select value={value} onChange={(e) => setValue(e.target.value)}>{allowed.map((a) => <option key={a} value={a}>{editing ? valueLabel(editing.setting_key, a) : a}</option>)}</Select>
        ) : editing?.value_type === 'boolean' ? (
          <Select value={value} onChange={(e) => setValue(e.target.value)}><option value="true">はい（true）</option><option value="false">いいえ（false）</option></Select>
        ) : (
          <Input value={value} onChange={(e) => setValue(e.target.value)} right={editing?.value_type === 'number' || editing?.value_type === 'integer'} />
        )}
        <div className="text-[10.5px] text-[var(--color-ink-3)] mt-2">種類：{editing?.value_type}{editing?.allowed_values ? `　選べる値：${editing.allowed_values}` : ''}</div>
      </Modal>
    </div>
  );
}

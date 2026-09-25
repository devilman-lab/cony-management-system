'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { today, ymdhm } from '@/lib/format';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, Input, Modal, Num, PageHead, Pager, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { Check, L } from '@/components/masters/Form';

interface Role { id: number; code: string; name: string; is_active?: boolean }
interface UserRow extends Record<string, unknown> {
  id: number;
  login_id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  roles: Role[];
}
interface Permission { id: number; function_id: string; action: string; name: string; is_sensitive: boolean }
interface Matrix { roles: Role[]; permissions: Permission[]; granted: Record<string, number[]> }
interface AuditRow extends Record<string, unknown> {
  id: number;
  acted_at: string;
  ref_table: string;
  ref_id: number;
  action: string;
  user_name: string | null;
}

const ACTION_LABEL: Record<string, string> = { view: '参照', create: '登録', update: '更新', delete: '削除', print: '印刷' };

/** 操作履歴の「対象」を日本語で出すための対応表。左は audit_logs.ref_table（実テーブル名）。 */
const AUDIT_TARGETS: [string, string][] = [
  ['sales_orders', '受注'],
  ['shipments', '出荷'],
  ['receipts', '入荷'],
  ['returns', '返品'],
  ['invoices', '請求'],
  ['cash_receipts', '入金'],
  ['purchases', '仕入・経費'],
  ['cash_payments', '支払'],
  ['cash_transactions', '入出金'],
  ['stock_adjustments', '在庫調整'],
  ['reservations', '引当在庫'],
  ['royalty_calculations', 'ロイヤリティ'],
  ['import_batches', '取込'],
  ['postal_codes', '郵便番号'],
  ['partners', '取引先'],
  ['delivery_destinations', '納品先'],
  ['products', '商品'],
  ['skus', 'SKU'],
  ['set_headers', 'セット商品'],
  ['partner_products', '得意先別商品'],
  ['warehouses', '倉庫'],
  ['purchase_items', '仕入項目'],
  ['royalty_rules', 'ロイヤリティ条件'],
  ['sales_schedules', '販売予定'],
  ['codes', '区分値'],
  ['system_settings', '設定'],
  ['users', '利用者'],
  ['roles', '役割'],
  ['brands', 'ブランド'],
  ['categories', 'カテゴリー'],
  ['product_classes', '商品分類'],
  ['colors', 'カラー'],
  ['sizes', 'サイズ'],
  ['media', '媒体'],
  ['partner_categories', '取引先カテゴリー'],
  ['sales_categories', '販売カテゴリー'],
  ['delivery_rules', '納品ルール'],
  ['work_instructions', '作業指示内容'],
  ['sales_staff', '販売担当'],
  ['attachments', '添付'],
  ['saved_queries', '保存した集計条件'],
];
const AUDIT_TARGET_LABEL: Record<string, string> = Object.fromEntries(AUDIT_TARGETS);
/** 何をしたか。audit_logs.action は insert/update/delete の3つだけ。 */
const AUDIT_ACTION_LABEL: Record<string, string> = { insert: '登録', update: '変更', delete: '削除' };


/** ユーザー・権限（M-17）。利用者・役割・役割ごとの権限・操作履歴。 */
export default function UsersPage() {
  const [tab, setTab] = useState<'users' | 'roles' | 'audit'>('users');
  return (
    <div>
      <div className="px-4 pt-3 flex gap-1">
        {([['users', '利用者'], ['roles', '役割と権限'], ['audit', '操作履歴']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-full text-[12px] border transition ${tab === k ? 'bg-[var(--color-brand-700)] text-white border-[var(--color-brand-700)]' : 'bg-white border-[var(--color-line)] hover:bg-[#f4f7f8]'}`}>{label}</button>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

function UsersTab() {
  const { can, user: me } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [inactive, setInactive] = useState(false);
  const list = useFetch<UserRow[]>('/admin/users', { include_inactive: inactive ? 'true' : undefined });
  const roles = useFetch<Role[]>('/admin/roles');

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [f, setF] = useState({ login_id: '', name: '', email: '', password: '', role_ids: [] as number[] });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState<UserRow | null>(null);
  const [pw, setPw] = useState('');

  const openNew = () => { setEditing(null); setF({ login_id: '', name: '', email: '', password: '', role_ids: [] }); setError(null); setOpen(true); };
  const openEdit = (u: UserRow) => { setEditing(u); setF({ login_id: u.login_id, name: u.name, email: u.email ?? '', password: '', role_ids: u.roles.map((r) => r.id) }); setError(null); setOpen(true); };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/admin/users/${editing.id}`, { name: f.name.trim(), email: f.email.trim() || null });
        await api.put(`/admin/users/${editing.id}/roles`, { role_ids: f.role_ids });
      } else {
        await api.post('/admin/users', { login_id: f.login_id.trim(), name: f.name.trim(), email: f.email.trim() || null, password: f.password, role_ids: f.role_ids });
      }
      toast(editing ? '更新しました' : '利用者を登録しました', 'good');
      setOpen(false);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const setPassword = async () => {
    if (!pwFor) return;
    setBusy(true);
    try {
      await api.post(`/admin/users/${pwFor.id}/password`, { password: pw });
      toast('パスワードを変えました', 'good');
      setPwFor(null);
      setPw('');
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };
  const toggleActive = async (u: UserRow) => {
    if (u.is_active) {
      if (!(await confirm(`${u.name} さんを停止しますか`, 'ログインできなくなります。操作履歴は残ります。'))) return;
      try { await api.post(`/admin/users/${u.id}/deactivate`); toast('停止しました', 'good'); await list.reload(); } catch (e) { toast(e instanceof Error ? e.message : '失敗しました', 'bad'); }
    } else {
      try { await api.patch(`/admin/users/${u.id}`, { is_active: true }); toast('再開しました', 'good'); await list.reload(); } catch (e) { toast(e instanceof Error ? e.message : '失敗しました', 'bad'); }
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead title="利用者" sub="ログインする人と、その役割です。テスト版は4名まで登録してお試しください" right={can('M-17', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>利用者を追加</Button>} />
      <Card>
        <Toolbar right={<label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />停止中も表示</label>} />
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<UserRow>
          columns={[
            { key: 'login_id', label: 'ログインID', width: 140, render: (u) => <Num className="font-semibold">{u.login_id}</Num> },
            { key: 'name', label: '氏名', render: (u) => <span>{u.name}{me?.id === u.id && <Badge className="ml-1">自分</Badge>}</span> },
            { key: 'email', label: 'メール', render: (u) => u.email ?? '' },
            { key: 'roles', label: '役割', render: (u) => <span className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.id}>{r.name}</Badge>)}</span> },
            { key: 'is_active', label: '状態', width: 70, render: (u) => (u.is_active ? '有効' : <Badge status="停止">停止</Badge>) },
            { key: '_act', label: '', width: 230, render: (u) => (
              <span className="flex gap-1 justify-end">
                {can('M-17', 'update') && <Button size="sm" onClick={() => openEdit(u)}>編集</Button>}
                {can('M-17', 'update') && <Button size="sm" onClick={() => { setPwFor(u); setPw(''); }}>パスワード</Button>}
                {can('M-17', 'delete') && me?.id !== u.id && <Button size="sm" variant={u.is_active ? 'danger' : 'ghost'} onClick={() => toggleActive(u)}>{u.is_active ? '停止' : '再開'}</Button>}
              </span>
            ) },
          ]}
          rows={list.data ?? []}
          rowKey={(u) => u.id}
          loading={list.loading}
          rowClassName={(u) => (u.is_active ? '' : 'opacity-50')}
        />
      </Card>

      <Modal open={open} title={editing ? '利用者の編集' : '利用者の追加'} onClose={() => setOpen(false)} width={560} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <L label="ログインID" required><Input value={f.login_id} onChange={(e) => setF({ ...f, login_id: e.target.value })} className="!w-[200px]" disabled={!!editing} /></L>
        <L label="氏名" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></L>
        <L label="メール"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></L>
        {!editing && <L label="初期パスワード" required hint="10文字以上"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="!w-[220px]" autoComplete="new-password" /></L>}
        <L label="役割" required>
          <div className="flex flex-col gap-1">
            {(roles.data ?? []).filter((r) => r.is_active !== false).map((r) => (
              <Check key={r.id} checked={f.role_ids.includes(r.id)} onChange={(v) => setF({ ...f, role_ids: v ? [...f.role_ids, r.id] : f.role_ids.filter((x) => x !== r.id) })} label={`${r.name}（${r.code}）`} />
            ))}
          </div>
        </L>
      </Modal>

      <Modal open={!!pwFor} title={`パスワードの変更：${pwFor?.name ?? ''}`} onClose={() => setPwFor(null)} width={440} footer={<><Button onClick={() => setPwFor(null)}>やめる</Button><Button variant="primary" loading={busy} disabled={pw.length < 10} onClick={setPassword}>変更する</Button></>}>
        <L label="新しいパスワード" required hint="10文字以上"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></L>
      </Modal>
    </div>
  );
}

function RolesTab() {
  const { can } = useAuth();
  const toast = useToast();
  const m = useFetch<Matrix>('/admin/permission-matrix');
  const [granted, setGranted] = useState<Record<string, number[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const g = granted ?? m.data?.granted ?? {};
  const dirty = granted !== null;

  const toggle = (permId: number, roleId: number) => {
    const cur = g[String(permId)] ?? [];
    const next = cur.includes(roleId) ? cur.filter((x) => x !== roleId) : [...cur, roleId];
    setGranted({ ...g, [String(permId)]: next });
  };
  const save = async () => {
    if (!m.data) return;
    setBusy(true);
    try {
      for (const role of m.data.roles) {
        const ids = m.data.permissions.filter((p) => (g[String(p.id)] ?? []).includes(role.id)).map((p) => p.id);
        await api.put(`/admin/roles/${role.id}/permissions`, { permission_ids: ids });
      }
      toast('権限を保存しました。次のログインから効きます', 'good');
      setGranted(null);
      await m.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  // 機能IDごとに1行、操作ごとに列
  const byFn = new Map<string, { name: string; perms: Permission[] }>();
  for (const p of m.data?.permissions ?? []) {
    const e = byFn.get(p.function_id) ?? { name: p.name.replace(/[：:（(].*$/, ''), perms: [] };
    e.perms.push(p);
    byFn.set(p.function_id, e);
  }

  return (
    <div className="page-body">
      <PageHead title="役割と権限" sub="役割（管理者・営業・物流・経理など）ごとに、どの機能を参照・登録・更新・削除・印刷できるかを決めます。「機微」は原価・利益など、見せる人を限る項目です" right={can('M-17', 'update') && <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>変更を保存</Button>} />
      <Card>
        {m.error ? <div className="p-3"><ErrorBox error={m.error} /></div> : null}
        <div className="tbl-wrap-wide">
          <table className="tbl" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ width: 70 }}>機能</th>
                <th>名称</th>
                {(m.data?.roles ?? []).map((r) => <th key={r.id} className="c" style={{ width: 150 }}>{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from(byFn.entries()).map(([fn, e]) => (
                <tr key={fn}>
                  <td className="num font-semibold">{fn}</td>
                  <td>{e.name}{e.perms.some((x) => x.is_sensitive) && <Badge className="ml-1">機微</Badge>}</td>
                  {(m.data?.roles ?? []).map((r) => (
                    <td key={r.id} className="c">
                      <div className="inline-flex flex-wrap gap-x-2 gap-y-0.5 justify-center">
                        {e.perms.map((p) => (
                          <label key={p.id} className="flex items-center gap-0.5 text-[10.5px] text-[var(--color-ink-2)]" title={p.name}>
                            <input type="checkbox" checked={(g[String(p.id)] ?? []).includes(r.id)} disabled={!can('M-17', 'update')} onChange={() => toggle(p.id, r.id)} />
                            {ACTION_LABEL[p.action] ?? p.action}
                          </label>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AuditTab() {
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [refTable, setRefTable] = useState('');
  const list = useList<AuditRow>('/admin/audit-logs', { from, to, ref_table: refTable || undefined }, 50);
  const [detail, setDetail] = useState<AuditRow | null>(null);
  return (
    <div className="page-body">
      <PageHead title="操作履歴" sub="誰が・いつ・何を変えたか。変更前後の内容も残ります" />
      <Card>
        <Toolbar>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
          <select className="inp !w-[220px]" value={refTable} onChange={(e) => setRefTable(e.target.value)}>
            <option value="">対象：すべて</option>
            {AUDIT_TARGETS.map(([table, label]) => (
              <option key={table} value={table}>{label}</option>
            ))}
          </select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<AuditRow>
          columns={[
            { key: 'acted_at', label: '日時', width: 140, render: (r) => ymdhm(r.acted_at) },
            { key: 'user_name', label: '利用者', width: 120, render: (r) => r.user_name ?? '' },
            { key: 'action', label: '操作', width: 90, render: (r) => AUDIT_ACTION_LABEL[r.action] ?? r.action },
            { key: 'ref_table', label: '対象', render: (r) => (
              <>
                {AUDIT_TARGET_LABEL[r.ref_table] ?? r.ref_table}
                {r.ref_id === null ? '' : <Num>　#{r.ref_id}</Num>}
              </>
            ) },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={setDetail}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>
      <Modal open={!!detail} title={detail ? `${AUDIT_TARGET_LABEL[detail.ref_table] ?? detail.ref_table}${detail.ref_id === null ? '' : ' #' + detail.ref_id}　${AUDIT_ACTION_LABEL[detail.action] ?? detail.action}` : ''} onClose={() => setDetail(null)} width={760}>
        {detail && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card><CardHead title="変更前" /><pre className="p-3 text-[11px] overflow-auto max-h-[400px] whitespace-pre-wrap">{JSON.stringify(detail.before_data ?? null, null, 2)}</pre></Card>
            <Card><CardHead title="変更後" /><pre className="p-3 text-[11px] overflow-auto max-h-[400px] whitespace-pre-wrap">{JSON.stringify(detail.after_data ?? null, null, 2)}</pre></Card>
          </div>
        )}
      </Modal>
    </div>
  );
}

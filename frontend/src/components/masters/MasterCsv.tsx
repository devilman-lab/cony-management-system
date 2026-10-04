'use client';

import { useRef, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, Button, ErrorBox, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface ImportRow {
  line: number;
  key: string;
  action: '追加' | '変更' | '変更なし' | 'エラー';
  changes: string[];
  message?: string;
}

interface ImportResult {
  label: string;
  dry_run: boolean;
  encoding: string;
  used_columns: string[];
  ignored_columns: string[];
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  rows: ImportRow[];
}

/** 画面に出す一覧は長くなりすぎないよう、ここまでに留める。件数は上の数で分かる。 */
const MAX_SHOWN = 200;

/**
 * マスタの CSV 書き出し・取り込み（2026-10-01 ご要望）。
 *
 * 取り込みは **必ず下見（dry run）を通してから**です。
 * 原価や単価をまとめて書き換えられる操作なので、何がどう変わるかを見てから確定します。
 */
export function MasterCsv({
  slug,
  functionId,
  name,
  includeInactive,
  onImported,
}: {
  slug: string;
  functionId: string;
  /** ボタンに出す呼び名。同じ画面に2組並ぶとき（商品とSKU）に区別する */
  name?: string;
  /** 一覧の「使わないものも表示」と合わせる */
  includeInactive: boolean;
  onImported: () => void | Promise<void>;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');

  const canExport = can(functionId, 'print');
  const canImport = can(functionId, 'update');
  if (!canExport && !canImport) return null;

  const exportCsv = async () => {
    try {
      await api.download(`/masters/csv/${slug}/export`, {
        query: { include_inactive: includeInactive ? 'true' : undefined },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : '書き出せませんでした', 'bad');
    }
  };

  const reset = () => {
    setPreview(null);
    setContent(null);
    setFileName('');
    setError(null);
    if (file.current) file.current.value = '';
  };

  /** ファイルを選んだら、まず下見だけ行う。この時点では何も書き換えない。 */
  const pick = async (f: File) => {
    setError(null);
    setPreview(null);
    setBusy(true);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const base64 = btoa(bin);
      setContent(base64);
      const r = await api.post<ImportResult>(`/masters/csv/${slug}/import`, {
        content_base64: base64,
        dry_run: true,
      });
      setPreview(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  /** 下見の内容でよければ、ここで本当に書き換える。 */
  const commit = async () => {
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ImportResult>(`/masters/csv/${slug}/import`, {
        content_base64: content,
        dry_run: false,
      });
      toast(`${r.added}件を追加、${r.updated}件を変更しました`, 'good');
      setOpen(false);
      reset();
      await onImported();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const tone = (a: ImportRow['action']) =>
    a === 'エラー' ? 'crit' : a === '追加' ? 'good' : a === '変更' ? 'warn' : undefined;

  return (
    <>
      {canExport && (
        <Button icon="download" onClick={exportCsv}>
          {name ? `${name}のCSV書き出し` : 'CSV書き出し'}
        </Button>
      )}
      {canImport && (
        <Button
          icon="upload"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          {name ? `${name}のCSV取込` : 'CSV取込'}
        </Button>
      )}

      <Modal
        open={open}
        title={name ? `${name}のCSV取り込み` : 'CSVの取り込み'}
        width={880}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              やめる
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!preview || preview.errors > 0 || preview.added + preview.updated === 0}
              onClick={commit}
            >
              この内容で取り込む
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="text-[12px] text-[var(--color-ink-2)]">
            先に「CSV書き出し」で今の内容を出し、Excel で直してから取り込むのが確実です。
            <b>見出しの行はそのまま残してください。</b>
            CSVに載っている列だけを書き換えます（載っていない列はそのままです）。
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              className="text-[12px]"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(f);
              }}
            />
            {busy && !preview && <span className="text-[12px] text-[var(--color-ink-3)]">読んでいます…</span>}
          </div>

          <ErrorBox error={error} onClose={() => setError(null)} />

          {preview && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
                <span>
                  <b>{fileName}</b>（{preview.encoding}）
                </span>
                <span>追加 <b>{preview.added}</b> 件</span>
                <span>変更 <b>{preview.updated}</b> 件</span>
                <span className="text-[var(--color-ink-3)]">変更なし {preview.unchanged} 件</span>
                {preview.errors > 0 && (
                  <span className="text-[var(--color-crit-500)]">
                    読めない行 <b>{preview.errors}</b> 件
                  </span>
                )}
              </div>

              {preview.ignored_columns.length > 0 && (
                <div className="text-[11.5px] text-[var(--color-ink-3)]">
                  使わなかった見出し：{preview.ignored_columns.join('、')}
                </div>
              )}

              {preview.errors > 0 && (
                <div className="text-[12px] text-[var(--color-crit-500)]">
                  読めない行があるため取り込めません。直してからもう一度お選びください（まだ何も変わっていません）。
                </div>
              )}
              {preview.errors === 0 && preview.added + preview.updated === 0 && (
                <div className="text-[12px] text-[var(--color-ink-3)]">
                  変わるところがありません。
                </div>
              )}

              <div className="max-h-[320px] overflow-auto border border-[var(--color-line)] rounded">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-[#f4f7f8]">
                    <tr>
                      <th className="text-right px-2 py-1 w-[52px]">行</th>
                      <th className="text-left px-2 py-1 w-[70px]">扱い</th>
                      <th className="text-left px-2 py-1 w-[220px]">対象</th>
                      <th className="text-left px-2 py-1">変わるところ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows
                      .filter((r) => r.action !== '変更なし')
                      .slice(0, MAX_SHOWN)
                      .map((r) => (
                        <tr key={r.line} className="border-t border-[var(--color-line)]">
                          <td className="text-right px-2 py-1 tabular-nums">{r.line}</td>
                          <td className="px-2 py-1">
                            <Badge status={tone(r.action)}>{r.action}</Badge>
                          </td>
                          <td className="px-2 py-1">{r.key}</td>
                          <td className="px-2 py-1">
                            {r.message ? (
                              <span className="text-[var(--color-crit-500)]">{r.message}</span>
                            ) : r.changes.length > 0 ? (
                              r.changes.join('／')
                            ) : (
                              <span className="text-[var(--color-ink-3)]">新しく追加します</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.filter((r) => r.action !== '変更なし').length > MAX_SHOWN && (
                <div className="text-[11.5px] text-[var(--color-ink-3)]">
                  先頭 {MAX_SHOWN} 件だけ表示しています。取り込みはすべての行に対して行われます。
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

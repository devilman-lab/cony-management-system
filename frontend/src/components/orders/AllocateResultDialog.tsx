'use client';

import Link from 'next/link';

import { ymd } from '@/lib/format';
import { Badge, Button, Modal, Num } from '@/components/ui';
import type { OrderRow } from './list-filters';

/** まとめて引当（POST /order-list/allocate）の受注ごとの結果 */
export interface AllocateResult {
  order_id: number;
  order_no: string;
  status: string;
  shortages: string[];
  error: string | null;
}

/**
 * まとめて引当の結果（2026-10-13 受注処理編 O-19「複数受注をまとめて「引当済」の処理を行いたい」）。
 * 引き当てた順（出荷日の早い順、同じ日は受注番号の順）に、受注ごとに 引当済／引当待ち（足りない内容）／エラー を出す。
 */
export function AllocateResultDialog({
  results,
  rows,
  onClose,
}: {
  results: AllocateResult[];
  /** 選んだときの一覧の行（出荷日・取引先を添えるため） */
  rows: Map<number, OrderRow>;
  onClose: () => void;
}) {
  const done = results.filter((r) => !r.error && r.status === '引当済').length;
  const waiting = results.filter((r) => !r.error && r.status !== '引当済').length;
  const failed = results.filter((r) => r.error).length;
  return (
    <Modal
      open
      title={`引当の結果（${results.length}件）`}
      onClose={onClose}
      width={820}
      dismissible
      footer={
        <Button variant="primary" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Badge status="引当済">引当済 {done}件</Badge>
        {waiting > 0 && <Badge status="引当待ち">引当待ち {waiting}件</Badge>}
        {failed > 0 && <Badge status="エラー">エラー {failed}件</Badge>}
      </div>
      <p className="text-[11.5px] text-[var(--color-ink-3)] mb-2.5 leading-relaxed">
        出荷日の早い順（同じ日は受注番号の順）に引き当てました。引当済の受注は「出荷確定・印刷」に出ます。
        引当待ちは在庫が足りなかった受注です（取れた分は押さえてあります）。在庫が入ったら、もう一度「引当」を押してください。
      </p>
      <div className="tbl-wrap">
        <table className="tbl tbl-fit" style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ width: 34 }} className="r">
                順
              </th>
              <th style={{ width: 112 }}>受注番号</th>
              <th style={{ width: 84 }}>出荷日</th>
              <th>取引先・納品先</th>
              <th style={{ width: 82 }}>結果</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const row = rows.get(r.order_id);
              const who = row ? [row.partner_name ?? row.direct_name, row.delivery_destination_id ? row.delivery_name : null].filter(Boolean).join(' ／ ') : '';
              return (
                <tr key={r.order_id}>
                  <td className="r num">{i + 1}</td>
                  <td className="nw">
                    {r.order_no ? (
                      <Link href={`/orders/${r.order_id}`} className="num font-semibold text-[var(--color-brand-700)]">
                        {r.order_no}
                      </Link>
                    ) : (
                      <span className="num">ID {r.order_id}</span>
                    )}
                  </td>
                  <td className="nw">
                    <Num>{ymd(row?.ship_date)}</Num>
                  </td>
                  <td>{who}</td>
                  <td>{r.error ? <Badge status="エラー" /> : <Badge status={r.status} />}</td>
                  <td>
                    {r.error ? (
                      <span className="text-[var(--color-crit-500)]">{r.error}</span>
                    ) : r.shortages.length > 0 ? (
                      <ul className="list-disc pl-4 text-[11.5px]">
                        {r.shortages.map((s, j) => (
                          <li key={j}>足りない：{s}</li>
                        ))}
                      </ul>
                    ) : r.status === '引当済' ? (
                      <span className="text-[var(--color-ink-3)]">全部引き当てました</span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

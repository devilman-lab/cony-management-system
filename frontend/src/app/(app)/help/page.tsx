'use client';

import Link from 'next/link';

import { Card, CardHead } from '@/components/ui';

const FLOW = [
  // 受注は登録だけ。引当は受注一覧で行う（2026-10-13 受注処理編 O-06・O-19）
  { step: '01', title: '受注を登録する', body: '受注入力で取引先・納品先・商品を選んで「登録する」を押します。登録しただけでは在庫は引き当てません（受注は「引当待ち」で並びます）。', href: '/orders/new' },
  { step: '02', title: '受注一覧で引き当てる', body: '受注一覧で受注を選んで「引当」を押すと、出荷日の早い順に在庫を引き当てます。全部引き当てられた受注は「引当済」になり、足りない分がある受注は取れた分だけ押さえて「引当待ち」のまま残ります。', href: '/orders' },
  { step: '03', title: '物流で出荷を確定して印刷する', body: '出荷確定・印刷の画面で引当済の受注を選び「出荷確定して印刷」を押すと、実在庫が減り、出荷依頼書・納品書・添付が1つのPDFで出ます。', href: '/shipping' },
  { step: '04', title: '月末に締めて請求する', body: '締め・請求書の画面で対象月を締めると、取引先ごとの締め日で請求が作られます。送料（30,000円未満は750円）も自動で入ります。', href: '/invoices' },
  { step: '05', title: '入金を消し込む', body: '入金消込で入金額を登録し、請求に消し込みます。売掛残高に反映されます。', href: '/payments' },
];

export default function HelpPage() {
  return (
    <div className="page-body">
      <div className="help-page-inner">
        <div className="help-hero">
          <div>
            <p className="help-eyebrow">TEST VERSION GUIDE</p>
            <h1 className="help-title">はじめにお読みください</h1>
            <p className="help-lead">
              このテスト版は、実際の業務データを入れてお試しいただくためのものです。画面の並びは左のメニューのとおりで、上から順に日々の流れになっています。
              お気づきの点は、画面名と操作内容を添えてお知らせください。
            </p>
          </div>
        </div>
        <section className="help-section">
          <div className="help-section-head">
            <div>
              <h2>日々の流れ</h2>
              <p>受注から入金までの5つの手順です。</p>
            </div>
          </div>
          <ul className="help-flow-list">
            {FLOW.map((f) => (
              <li key={f.step} className="help-flow-item">
                <div className="help-step-art text-[var(--color-brand-700)] font-bold">{f.step}</div>
                <div className="help-flow-body">
                  <div className="help-flow-head">
                    <h3>{f.title}</h3>
                  </div>
                  <p>{f.body}</p>
                  <Link href={f.href} className="help-link-btn">
                    この画面を開く →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <Card>
          <CardHead title="在庫の言葉" />
          <table className="help-mini-table">
            <tbody>
              <tr>
                <th>実在庫</th>
                <td>棚にある数。出荷確定で減り、入荷で増えます</td>
              </tr>
              <tr>
                <th>引当済</th>
                <td>受注で押さえている数。受注一覧の「引当」で増え、出荷確定・取消で減ります</td>
              </tr>
              <tr>
                <th>有効在庫</th>
                <td>実在庫 − 引当済。これから受注に充てられる数</td>
              </tr>
              <tr>
                <th>引当在庫（確保数）</th>
                <td>販売カテゴリーごとに月初に登録する枠。受注登録のたびにここから減ります</td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

/**
 * サイドバーの章立て。顧客確認済みのデモ版と同じ並びにし、
 * それぞれに必要な権限（機能ID）を添えて、持っていない人には出さない。
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** この機能の参照権限がないと表示しない。空なら誰でも */
  functionId?: string;
}

export interface NavSection {
  sec: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    sec: '',
    items: [
      { href: '/dashboard', label: 'ダッシュボード', icon: 'dash' },
      { href: '/help', label: 'ヘルプ', icon: 'help' },
    ],
  },
  {
    sec: '受注・出荷',
    items: [
      { href: '/orders', label: '受注一覧', icon: 'cart', functionId: 'O-03' },
      { href: '/orders/new', label: '受注入力', icon: 'plus', functionId: 'O-01' },
      { href: '/shipping', label: '出荷確定・印刷', icon: 'truck', functionId: 'D-01' },
      { href: '/imports', label: 'CSV取込', icon: 'dl', functionId: 'I-01' },
      { href: '/moves', label: '入出荷履歴', icon: 'refresh', functionId: 'S-05' },
      { href: '/returns', label: '返品・再生', icon: 'refresh', functionId: 'R-01' },
    ],
  },
  {
    sec: '在庫',
    items: [
      { href: '/stock', label: '在庫表', icon: 'box', functionId: 'S-01' },
      { href: '/receiving', label: '入荷登録', icon: 'dl', functionId: 'S-03' },
      { href: '/adjustments', label: '在庫調整', icon: 'filter', functionId: 'S-01' },
      { href: '/allocation', label: '引当在庫（確保数）', icon: 'filter', functionId: 'S-08' },
    ],
  },
  {
    sec: '請求・入金',
    items: [
      { href: '/invoices', label: '締め・請求書', icon: 'doc', functionId: 'B-02' },
      { href: '/payments', label: '入金消込', icon: 'yen', functionId: 'B-05' },
      { href: '/ar', label: '売掛残高', icon: 'chart', functionId: 'B-04' },
    ],
  },
  {
    sec: '仕入・支払',
    items: [
      { href: '/purchases', label: '仕入・経費', icon: 'tag', functionId: 'P-01' },
      { href: '/ap', label: '買掛・支払', icon: 'yen', functionId: 'P-03' },
      { href: '/cash', label: '入出金', icon: 'yen', functionId: 'C-01' },
    ],
  },
  {
    sec: '分析',
    items: [
      { href: '/analytics', label: '販売実績', icon: 'chart', functionId: 'A-01' },
      { href: '/royalty', label: 'ロイヤリティ計算', icon: 'tag', functionId: 'Y-02' },
      { href: '/schedule', label: '販売スケジュール', icon: 'cal2', functionId: 'S-08' },
    ],
  },
  {
    sec: 'マスタ',
    items: [
      { href: '/masters/partners', label: '取引先', icon: 'users', functionId: 'M-01' },
      { href: '/masters/shiptos', label: '納品先', icon: 'truck', functionId: 'M-05' },
      { href: '/masters/products', label: '商品・SKU', icon: 'box', functionId: 'M-08' },
      { href: '/masters/sets', label: 'セット登録', icon: 'box', functionId: 'M-10' },
      { href: '/masters/partner-products', label: '得意先別商品', icon: 'tag', functionId: 'M-11' },
      { href: '/masters/warehouses', label: '倉庫', icon: 'db', functionId: 'M-14' },
      { href: '/masters/purchase-items', label: '仕入項目', icon: 'db', functionId: 'M-15' },
      { href: '/masters/royalty-rules', label: 'ロイヤリティ規定', icon: 'tag', functionId: 'Y-02' },
      { href: '/masters/simple', label: '分類・区分・設定', icon: 'db', functionId: 'M-16' },
      { href: '/masters/users', label: 'ユーザー・権限', icon: 'users', functionId: 'M-17' },
    ],
  },
];

export function findNav(pathname: string): { sec: string; item: NavItem } | null {
  let best: { sec: string; item: NavItem } | null = null;
  for (const s of NAV) {
    for (const it of s.items) {
      if (pathname === it.href || pathname.startsWith(it.href + '/')) {
        if (!best || it.href.length > best.item.href.length) best = { sec: s.sec, item: it };
      }
    }
  }
  return best;
}

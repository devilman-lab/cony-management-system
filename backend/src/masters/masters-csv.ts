/**
 * マスタの CSV 書き出し・取り込みの決めごと。
 *
 * 2026-10-01 のご要望：
 *   「原価変更などは編集が大変なので、CSV取り込みで全ての内容を更新できるようにしてほしい。
 *     逆にCSV書き出しもできるようにしてほしい。」
 *
 * 書き出した CSV をそのまま Excel で直して取り込めること（往復できること）を第一に考えてあります。
 * そのため、
 *   - 見出しは日本語。並びも画面と同じ
 *   - 相手のマスタを指す欄は、内部の番号ではなく **コード** で書き出す（取込時にコードから引き直す）
 *   - JAN のような数字だけの文字列は Excel が勝手に数値にしてしまうため ="..." の形で書き出す
 *   - 取り込みは **CSV に載っている列だけ**を書き換える。載っていない列には触らない
 */

/** 欄の種類。書き出しの見せ方と、取り込みの読み取り方を決める。 */
export type CsvKind =
  | 'text'
  | 'number' // 整数
  | 'decimal' // 金額・率（文字列のまま扱う）
  | 'bool' // 有効/無効、○/空
  | 'date' // YYYY-MM-DD
  | 'digits'; // JAN など。Excel に壊されないよう ="..." で書く

/** 相手のマスタを指す欄。CSV にはコードで出し、取込時にコードから番号を引き直す。 */
export interface CsvRef {
  /** 引く先の表 */
  table: string;
  /** 引く先のコード列 */
  codeColumn: string;
  /** 見つからなかったときの文言に使う名前 */
  label: string;
  /** codes 表を引くときの区分（例 PARTNER_DIVISION） */
  codeCategory?: string;
}

export interface CsvColumn {
  /** データベースの列名 */
  field: string;
  /** CSV の見出し（日本語） */
  label: string;
  kind?: CsvKind;
  ref?: CsvRef;
  /** 原価など、SENSITIVE の権限がある人にだけ見せる欄 */
  sensitive?: boolean;
  /** 取り込みで書き換えない欄（突き合わせの鍵など） */
  readOnly?: boolean;
}

export interface MasterCsvDef {
  /** URL に出る名前 */
  slug: string;
  /** データベースの表 */
  table: string;
  /** 画面での呼び名。ファイル名とエラー文に使う */
  label: string;
  /** 権限の機能ID */
  functionId: string;
  /**
   * 行を突き合わせる鍵。CSV の欄（field）で指定する。
   * 鍵が一致する行があれば更新、無ければ追加。
   */
  keyFields: string[];
  columns: CsvColumn[];
}

/* ---------- よく使う欄のかたまり ---------- */

const ACTIVE: CsvColumn = { field: 'is_active', label: '有効', kind: 'bool' };
const SORT: CsvColumn = { field: 'sort_order', label: '並び順', kind: 'number' };
const NOTE: CsvColumn = { field: 'note', label: '備考' };

const ref = (table: string, label: string, codeColumn = 'code'): CsvRef => ({ table, codeColumn, label });
const codeRef = (codeCategory: string, label: string): CsvRef => ({
  table: 'codes',
  codeColumn: 'code',
  label,
  codeCategory,
});

/* ---------- 分類マスタ（10種。形が同じなのでまとめて作る） ---------- */

/** 分類マスタのうち、追加の欄を持つもの。 */
const SIMPLE_EXTRA: Record<string, CsvColumn[]> = {
  delivery_rules: [
    { field: 'lead_time_days', label: '出荷までの日数', kind: 'number' },
    { field: 'allowed_weekdays', label: '出荷できる曜日' },
    { field: 'rule_body', label: 'ルール本文' },
  ],
  work_instructions: [{ field: 'instruction_body', label: '指示内容' }],
};

const SIMPLE_LABELS: Record<string, string> = {
  brands: 'ブランド',
  categories: 'カテゴリー',
  product_classes: '商品分類',
  colors: 'カラー',
  sizes: 'サイズ',
  media: '媒体',
  partner_categories: '取引先カテゴリー',
  sales_categories: '販売カテゴリー',
  delivery_rules: '納品ルール',
  work_instructions: '作業指示内容',
  sales_staff: '販売担当',
};

const simpleDef = (table: string): MasterCsvDef => ({
  slug: table.replace(/_/g, '-'),
  table,
  label: SIMPLE_LABELS[table] ?? table,
  functionId: 'M-16',
  keyFields: ['code'],
  columns: [
    { field: 'code', label: 'コード', readOnly: true },
    { field: 'name', label: '名称' },
    ...(SIMPLE_EXTRA[table] ?? []),
    SORT,
    NOTE,
    ACTIVE,
  ],
});

/* ---------- それぞれのマスタ ---------- */

const PARTNERS: MasterCsvDef = {
  slug: 'partners',
  table: 'partners',
  label: '取引先',
  functionId: 'M-01',
  keyFields: ['partner_code'],
  columns: [
    { field: 'partner_code', label: '取引先コード', readOnly: true },
    { field: 'name1', label: '取引先名' },
    { field: 'name2', label: '取引先名2' },
    { field: 'short_name', label: '略称' },
    { field: 'is_customer', label: '得意先', kind: 'bool' },
    { field: 'is_supplier', label: '仕入先', kind: 'bool' },
    // 海外の取引先。消費税の扱い（免税／課税対象外）はシステム設定 OVERSEAS_TAX_TREATMENT で決める（2026-10-09 マスター編②）
    { field: 'is_overseas', label: '海外', kind: 'bool' },
    { field: 'media_id', label: '媒体コード', ref: ref('media', '媒体') },
    { field: 'partner_category_id', label: '取引先カテゴリーコード', ref: ref('partner_categories', '取引先カテゴリー') },
    { field: 'sales_staff_id', label: '販売担当コード', ref: ref('sales_staff', '販売担当') },
    { field: 'division_code_id', label: '区分', ref: codeRef('PARTNER_DIVISION', '区分') },
    { field: 'division2_code_id', label: '区分2', ref: codeRef('PARTNER_DIVISION2', '区分2') },
    { field: 'invoice_registration_no', label: 'インボイス登録番号' },
    { field: 'invoice_addressee', label: '請求書の宛名' },
    { field: 'invoice_contact_name', label: '請求書の担当者名' },
    { field: 'invoice_note', label: '請求書の備考' },
    { field: 'shipping_fee_threshold', label: '送料無料になる金額', kind: 'decimal' },
    { field: 'shipping_fee_amount', label: '送料', kind: 'decimal' },
    { field: 'default_trade_type', label: '取引区分' },
    { field: 'is_royalty_payee', label: 'ロイヤリティ支払先', kind: 'bool' },
    { field: 'closing_day', label: '締め日', kind: 'number' },
    { field: 'payment_month_offset', label: '支払月（何ヶ月後）', kind: 'number' },
    { field: 'payment_day', label: '支払日', kind: 'number' },
    { field: 'postal_code', label: '郵便番号' },
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    { field: 'tel', label: '電話番号' },
    { field: 'fax', label: 'FAX' },
    SORT,
    NOTE,
    ACTIVE,
  ],
};

const DESTINATIONS: MasterCsvDef = {
  slug: 'delivery-destinations',
  table: 'delivery_destinations',
  label: '納品先',
  functionId: 'M-05',
  keyFields: ['delivery_code'],
  columns: [
    { field: 'delivery_code', label: '納品先コード', readOnly: true },
    { field: 'partner_id', label: '取引先コード', ref: ref('partners', '取引先', 'partner_code') },
    { field: 'name', label: '納品先名' },
    { field: 'partner_delivery_no', label: '先方の納品先番号' },
    { field: 'consignee', label: '荷受人' },
    { field: 'delivery_note_print1', label: '納品書印字1（宛名）' },
    { field: 'delivery_note_print2', label: '納品書印字2（納品先）' },
    { field: 'work_instruction_id', label: '作業指示コード', ref: ref('work_instructions', '作業指示') },
    { field: 'default_warehouse_id', label: '既定倉庫コード', ref: ref('warehouses', '倉庫', 'warehouse_code') },
    { field: 'slip_issue_class_code_id', label: '伝票発行区分', ref: codeRef('SLIP_ISSUE_CLASS', '伝票発行区分') },
    { field: 'postal_code', label: '郵便番号' },
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    { field: 'tel', label: '電話番号' },
    { field: 'fax', label: 'FAX' },
    SORT,
    NOTE,
    ACTIVE,
  ],
};

const PRODUCTS: MasterCsvDef = {
  slug: 'products',
  table: 'products',
  label: '商品',
  functionId: 'M-08',
  keyFields: ['product_code'],
  columns: [
    { field: 'product_code', label: '商品コード', readOnly: true },
    { field: 'product_name', label: '商品名' },
    { field: 'set_product_name', label: 'セット商品名' },
    { field: 'brand_id', label: 'ブランドコード', ref: ref('brands', 'ブランド') },
    { field: 'category_id', label: 'カテゴリーコード', ref: ref('categories', 'カテゴリー') },
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
    { field: 'carton_qty', label: '入数', kind: 'number' },
    // 原価は SENSITIVE の権限がある人にだけ出す。権限がなければ列ごと出さない
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    { field: 'old_cost_price', label: '旧原価', kind: 'decimal', sensitive: true },
    { field: 'is_cost_undecided', label: '原価未定', kind: 'bool', sensitive: true },
    { field: 'tax_rate', label: '税率', kind: 'decimal' },
    { field: 'is_set', label: 'セット商品', kind: 'bool' },
    SORT,
    NOTE,
    ACTIVE,
  ],
};

const SKUS: MasterCsvDef = {
  slug: 'skus',
  table: 'skus',
  label: 'SKU',
  functionId: 'M-09',
  keyFields: ['sku_code'],
  columns: [
    { field: 'sku_code', label: 'SKUコード', readOnly: true },
    { field: 'product_id', label: '商品コード', ref: ref('products', '商品', 'product_code') },
    // SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②）
    { field: 'sku_name', label: 'SKUの商品名' },
    { field: 'color_id', label: 'カラーコード', ref: ref('colors', 'カラー') },
    { field: 'size_id', label: 'サイズコード', ref: ref('sizes', 'サイズ') },
    { field: 'pack_division', label: '入数区分' },
    { field: 'jan', label: 'JANコード', kind: 'digits' },
    { field: 'fba_jan', label: 'FBA用JANコード', kind: 'digits' },
    { field: 'shop_product_code', label: 'ショップ商品コード' },
    // サイズ別の原価。空欄なら商品の原価を使う（1001 ご要望）
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    SORT,
    NOTE,
    ACTIVE,
  ],
};

const PARTNER_PRODUCTS: MasterCsvDef = {
  slug: 'partner-products',
  table: 'partner_products',
  label: '得意先別商品',
  functionId: 'M-11',
  // 1つの取引先に同じ SKU は1件まで。この2つで突き合わせる
  keyFields: ['partner_id', 'sku_id'],
  columns: [
    { field: 'partner_id', label: '取引先コード', ref: ref('partners', '取引先', 'partner_code'), readOnly: true },
    { field: 'sku_id', label: 'SKUコード', ref: ref('skus', 'SKU', 'sku_code'), readOnly: true },
    { field: 'partner_product_code', label: '先方の商品コード' },
    { field: 'partner_jan', label: '先方JAN', kind: 'digits' },
    { field: 'shipping_jan', label: '出荷JAN', kind: 'digits' },
    { field: 'sales_name', label: '販売名' },
    { field: 'sales_name2', label: '販売名2' },
    { field: 'unit_price', label: '単価', kind: 'decimal' },
    { field: 'old_unit_price', label: '旧単価', kind: 'decimal' },
    { field: 'price_changed_date', label: '単価変更日', kind: 'date' },
    { field: 'retail_price', label: '上代', kind: 'decimal' },
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    { field: 'partner_color', label: '先方カラー' },
    { field: 'partner_size', label: '先方サイズ' },
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
    { field: 'memo', label: 'メモ' },
    SORT,
    NOTE,
    ACTIVE,
  ],
};

/** 書き出し・取り込みができるマスタ。slug で引く。 */
export const MASTER_CSV: Record<string, MasterCsvDef> = Object.fromEntries(
  [
    PARTNERS,
    DESTINATIONS,
    PRODUCTS,
    SKUS,
    PARTNER_PRODUCTS,
    ...Object.keys(SIMPLE_LABELS).map(simpleDef),
  ].map((d) => [d.slug, d]),
);

export const CSV_SLUGS = Object.keys(MASTER_CSV);

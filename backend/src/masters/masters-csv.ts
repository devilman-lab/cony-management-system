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

import { rateForTaxDivision } from './purchase-item-tax';

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

/**
 * 1つの欄に複数のコードを持つ欄（取引先のカテゴリー。1001 ご要望「1取引先に複数カテゴリー」）。
 * 中身はひも付けの表に持ち、`field` の列には先頭のコード（代表）を入れる。
 */
export interface CsvMulti {
  /** ひも付けの表 */
  linkTable: string;
  /** ひも付けの表で、この行を指す列 */
  ownerColumn: string;
  /** ひも付けの表で、相手（ref）を指す列 */
  refColumn: string;
}

/** 複数のコードを1欄に書くときの区切り。画面の案内と同じ「、」。取込は「|」「,」も受ける。 */
export const MULTI_SEPARATOR = '、';

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
  /**
   * 選べる値。画面の選択肢と同じものだけを受ける（2026-10-12 受入 No.2・No.6「支払月 7・99 が入る」）。
   * 数値の欄は数で比べる。今入っている値を変えない行は検査しない（昔からの値で取込が止まらないように）。
   */
  options?: readonly (string | number)[];
  /** 選べる値の説明。エラー文に出す（例「0（当月）〜6（6か月後）」） */
  optionsLabel?: string;
  /** 数値の下限・上限（画面・API と同じ） */
  min?: number;
  max?: number;
  /** 数字の桁数（JAN の 8桁・13桁など） */
  digitsLength?: readonly number[];
  /**
   * 書き出しで ="..." の形にする（頭の 0 を Excel に落とされないため。2026-10-12 受入 No.3 D-7）。
   * 相手のマスタを指す欄（コード）は指定しなくても必ずこの形にする。
   */
  excelText?: boolean;
  /** 空欄を空の文字として入れる（データベースでは空にできないが、入力は任意の欄。作業指示の本文など） */
  blankAsEmpty?: boolean;
  multi?: CsvMulti;
}

/** 行ごとの決まりを確かめるときに渡すもの。 */
export interface CsvRowContext {
  /** 新しく作る行か */
  isNew: boolean;
  /** 相手のマスタを指す欄の、今の値のコード（無ければ null） */
  codeOf: (field: string) => string | null;
  /** 区分値「通貨」に登録されているコード（使わないにしたものも含む。画面の登録と同じ） */
  currencies: Set<string>;
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
  /**
   * 有効→無効（使わない）にするのに要る権限。画面の「使わない」と同じにする（2026-10-12 受入 No.3 D-2）。
   * 既定は delete。区分値は画面の「使わない」が update で動くので update。
   */
  deactivateAction?: 'delete' | 'update';
  /**
   * 行全体の決まり（得意先か仕入先のどちらかは必要、など）。`row` は今の値に CSV の値を重ねたもの。
   * 守れていなければ「欄名：理由」を返す。
   */
  rowCheck?: (row: Record<string, unknown>, ctx: CsvRowContext) => string[];
  /**
   * 行から決まる欄を補う（仕入品目の税率を税区分から決める、など）。rowCheck の前に呼ぶ。
   * 返した欄は CSV に列が無くても書き込む。`touched` は CSV で値を変える欄。
   */
  complete?: (row: Record<string, unknown>, ctx: CsvRowContext & { touched: Set<string> }) => Record<string, unknown>;
  /** 鍵のほかに、重なってはいけない欄の組（空欄は数えない） */
  unique?: string[][];
  /** 一覧で編集・書き出しを絞る欄（区分値のカテゴリーなど）。URL の scope にコードを渡す */
  scopeField?: string;
}

/**
 * 書き出しだけのマスタ（2026-10-12 受入 No.2・No.3）。
 * ロイヤリティ規定・セット・ユーザーは1件が複数の行にまたがるため、一覧で編集・取込には向かない。
 * 中身の組み立ては masters-csv.service.ts の exportOnly。
 */
export interface MasterCsvExportOnly {
  slug: string;
  label: string;
  functionId: string;
}

export const MASTER_CSV_EXPORT_ONLY: Record<string, MasterCsvExportOnly> = {
  'royalty-rules': { slug: 'royalty-rules', label: 'ロイヤリティ規定', functionId: 'Y-02' },
  sets: { slug: 'sets', label: 'セット', functionId: 'M-10' },
  users: { slug: 'users', label: 'ユーザー', functionId: 'M-17' },
};

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

/** 頭の 0 を落とされないよう ="..." で書き出す文字の欄（コード・郵便番号・電話番号など） */
const textCode = (field: string, label: string, extra: Partial<CsvColumn> = {}): CsvColumn => ({
  field,
  label,
  excelText: true,
  ...extra,
});

/** 締め日・支払日の選択肢。編集画面と同じ（5日〜25日、末日=99）。 */
export const DAY_OPTIONS = [5, 10, 15, 20, 25, 99] as const;
export const DAY_OPTIONS_LABEL = '5・10・15・20・25（日）か 99（末日）';
/** 支払月（何ヶ月後）の選択肢。当月〜6か月後（1001 ご要望「支払 6ヶ月まで」）。 */
export const PAYMENT_MONTH_OPTIONS = [0, 1, 2, 3, 4, 5, 6] as const;
export const PAYMENT_MONTH_OPTIONS_LABEL = '0（当月）〜6（6か月後）';
/** 取引区分。編集画面と同じ。 */
export const TRADE_TYPE_OPTIONS = ['委託', '買取', '仕入'] as const;
/** 税率。商品・仕入品目の画面と同じ。 */
const TAX_OPTIONS = [0, 8, 10] as const;

/* ---------- 分類マスタ（10種。形が同じなのでまとめて作る） ---------- */

/** 分類マスタのうち、追加の欄を持つもの。 */
const SIMPLE_EXTRA: Record<string, CsvColumn[]> = {
  delivery_rules: [
    { field: 'lead_time_days', label: '出荷までの日数', kind: 'number', min: 0, max: 365 },
    { field: 'allowed_weekdays', label: '出荷できる曜日' },
    { field: 'rule_body', label: 'ルール本文' },
  ],
  // 本文は空でもよい（画面の登録も空で通る）。データベースでは空欄にできないので空の文字で持つ（2026-10-12 受入 No.3 D-4）
  work_instructions: [{ field: 'instruction_body', label: '指示内容', blankAsEmpty: true }],
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
    textCode('code', 'コード', { readOnly: true }),
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
    textCode('partner_code', '取引先コード', { readOnly: true }),
    { field: 'name1', label: '取引先名' },
    { field: 'name2', label: '取引先名2' },
    { field: 'short_name', label: '略称' },
    { field: 'is_customer', label: '得意先', kind: 'bool' },
    { field: 'is_supplier', label: '仕入先', kind: 'bool' },
    // 海外の取引先。消費税の扱い（免税／課税対象外）はシステム設定 OVERSEAS_TAX_TREATMENT で決める（2026-10-09 マスター編②）
    { field: 'is_overseas', label: '海外', kind: 'bool' },
    // 取引通貨（区分値 CURRENCY のコード）。受注・請求・入金はこの通貨で作る（2026-10-12 No.39）
    { field: 'currency', label: '通貨' },
    { field: 'media_id', label: '媒体コード', ref: ref('media', '媒体') },
    // 1取引先に複数のカテゴリー（1001 ご要望 No.8）。「Q1TV、Q1CAT」のように区切って1欄に書く。先頭が代表
    {
      field: 'partner_category_id',
      label: '取引先カテゴリーコード',
      ref: ref('partner_categories', '取引先カテゴリー'),
      multi: { linkTable: 'partner_category_links', ownerColumn: 'partner_id', refColumn: 'partner_category_id' },
    },
    { field: 'sales_staff_id', label: '販売担当コード', ref: ref('sales_staff', '販売担当') },
    { field: 'division_code_id', label: '区分', ref: codeRef('PARTNER_DIVISION', '区分') },
    { field: 'division2_code_id', label: '区分2', ref: codeRef('PARTNER_DIVISION2', '区分2') },
    { field: 'invoice_registration_no', label: 'インボイス登録番号' },
    { field: 'invoice_addressee', label: '請求書の宛名' },
    { field: 'invoice_contact_name', label: '請求書の担当者名' },
    { field: 'invoice_note', label: '請求書の備考' },
    { field: 'shipping_fee_threshold', label: '送料無料になる金額', kind: 'decimal', min: 0 },
    { field: 'shipping_fee_amount', label: '送料', kind: 'decimal', min: 0 },
    { field: 'default_trade_type', label: '取引区分', options: TRADE_TYPE_OPTIONS },
    { field: 'is_royalty_payee', label: 'ロイヤリティ支払先', kind: 'bool' },
    // 締め日・支払は編集画面の選択肢だけを受ける（2026-10-12 受入 No.2・No.6）
    { field: 'closing_day', label: '締め日', kind: 'number', options: DAY_OPTIONS, optionsLabel: DAY_OPTIONS_LABEL },
    {
      field: 'payment_month_offset',
      label: '支払月（何ヶ月後）',
      kind: 'number',
      options: PAYMENT_MONTH_OPTIONS,
      optionsLabel: PAYMENT_MONTH_OPTIONS_LABEL,
    },
    { field: 'payment_day', label: '支払日', kind: 'number', options: DAY_OPTIONS, optionsLabel: DAY_OPTIONS_LABEL },
    textCode('postal_code', '郵便番号'),
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    textCode('tel', '電話番号'),
    textCode('fax', 'FAX'),
    SORT,
    NOTE,
    ACTIVE,
  ],
  // データベースの決まり ck_partners_role と同じ。確定で弾かれる前に下見で止める
  rowCheck: (row, ctx) => [
    ...(row.is_customer || row.is_supplier ? [] : ['得意先・仕入先：どちらかを「有効」にしてください']),
    // 通貨は英大文字3文字のコード（区分値 CURRENCY。2026-10-12 No.39）。新しい行の空欄は円（JPY）になる
    ...(row.currency === undefined || (row.currency === null && ctx.isNew) || /^[A-Z]{3}$/.test(String(row.currency ?? ''))
      ? []
      : ['通貨：英大文字3文字のコードで入力してください（円は JPY、米ドルは USD）']),
    // 区分値に無い通貨は、取引先の画面と同じく断る（3回目の全面テスト。「XYZ」が入り、受注も XYZ で作られていた）
    ...(typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) && !ctx.currencies.has(row.currency)
      ? [`通貨：「${row.currency}」は登録されていません。「分類・区分・設定」の「通貨」タブで足してから入れてください`]
      : []),
  ],
};

const DESTINATIONS: MasterCsvDef = {
  slug: 'delivery-destinations',
  table: 'delivery_destinations',
  label: '納品先',
  functionId: 'M-05',
  keyFields: ['delivery_code'],
  columns: [
    textCode('delivery_code', '納品先コード', { readOnly: true }),
    { field: 'partner_id', label: '取引先コード', ref: ref('partners', '取引先', 'partner_code') },
    { field: 'name', label: '納品先名' },
    textCode('partner_delivery_no', '先方の納品先番号'),
    { field: 'consignee', label: '荷受人' },
    { field: 'delivery_note_print1', label: '納品書印字1（宛名）' },
    { field: 'delivery_note_print2', label: '納品書印字2（納品先）' },
    { field: 'work_instruction_id', label: '作業指示コード', ref: ref('work_instructions', '作業指示') },
    { field: 'default_warehouse_id', label: '既定倉庫コード', ref: ref('warehouses', '倉庫', 'warehouse_code') },
    { field: 'slip_issue_class_code_id', label: '伝票発行区分', ref: codeRef('SLIP_ISSUE_CLASS', '伝票発行区分') },
    textCode('postal_code', '郵便番号'),
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    textCode('tel', '電話番号'),
    textCode('fax', 'FAX'),
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
    textCode('product_code', '商品コード', { readOnly: true }),
    { field: 'product_name', label: '商品名' },
    { field: 'set_product_name', label: 'セット商品名' },
    { field: 'brand_id', label: 'ブランドコード', ref: ref('brands', 'ブランド') },
    { field: 'category_id', label: 'カテゴリーコード', ref: ref('categories', 'カテゴリー') },
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
    { field: 'carton_qty', label: '入数', kind: 'number', min: 0 },
    // 原価は SENSITIVE の権限がある人にだけ出す。権限がなければ列ごと出さない
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    { field: 'old_cost_price', label: '旧原価', kind: 'decimal', sensitive: true },
    { field: 'is_cost_undecided', label: '原価未定', kind: 'bool', sensitive: true },
    { field: 'tax_rate', label: '税率', kind: 'decimal', options: TAX_OPTIONS, optionsLabel: '0・8・10' },
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
    textCode('sku_code', 'SKUコード', { readOnly: true }),
    { field: 'product_id', label: '商品コード', ref: ref('products', '商品', 'product_code') },
    // SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②）
    { field: 'sku_name', label: 'SKUの商品名' },
    { field: 'color_id', label: 'カラーコード', ref: ref('colors', 'カラー') },
    { field: 'size_id', label: 'サイズコード', ref: ref('sizes', 'サイズ') },
    textCode('pack_division', '入数区分'),
    // JAN は画面・API と同じく 8桁か13桁
    { field: 'jan', label: 'JANコード', kind: 'digits', digitsLength: [8, 13] },
    { field: 'fba_jan', label: 'FBA用JANコード', kind: 'digits', digitsLength: [8, 13] },
    textCode('shop_product_code', 'ショップ商品コード'),
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
    textCode('partner_product_code', '先方の商品コード'),
    { field: 'partner_jan', label: '先方JAN', kind: 'digits' },
    { field: 'shipping_jan', label: '出荷JAN', kind: 'digits' },
    { field: 'sales_name', label: '販売名' },
    { field: 'sales_name2', label: '販売名2' },
    { field: 'unit_price', label: '単価', kind: 'decimal' },
    { field: 'old_unit_price', label: '旧単価', kind: 'decimal' },
    { field: 'price_changed_date', label: '単価変更日', kind: 'date' },
    { field: 'retail_price', label: '上代', kind: 'decimal' },
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    textCode('partner_color', '先方カラー'),
    textCode('partner_size', '先方サイズ'),
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
    { field: 'memo', label: 'メモ' },
    SORT,
    NOTE,
    ACTIVE,
  ],
  // 1つの取引先で先方の商品コードは重ねられない（ux_partner_products_code）
  unique: [['partner_id', 'partner_product_code']],
};

/* ---------- 2026-10-12 受入 No.2・No.3 で足したもの（倉庫・仕入品目・区分値） ---------- */

const WAREHOUSES: MasterCsvDef = {
  slug: 'warehouses',
  table: 'warehouses',
  label: '倉庫',
  functionId: 'M-14',
  keyFields: ['warehouse_code'],
  columns: [
    textCode('warehouse_code', '倉庫コード', { readOnly: true }),
    { field: 'short_name', label: '倉庫名' },
    { field: 'is_consignment', label: '委託先', kind: 'bool' },
    { field: 'partner_id', label: '取引先コード', ref: ref('partners', '取引先', 'partner_code') },
    { field: 'media_id', label: '媒体コード', ref: ref('media', '媒体') },
    textCode('postal_code', '郵便番号'),
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    textCode('tel', '電話番号'),
    textCode('fax', 'FAX'),
    SORT,
    NOTE,
    ACTIVE,
  ],
};

const PURCHASE_ITEMS: MasterCsvDef = {
  slug: 'purchase-items',
  table: 'purchase_items',
  label: '仕入品目',
  functionId: 'M-15',
  keyFields: ['purchase_code'],
  columns: [
    textCode('purchase_code', '仕入コード', { readOnly: true }),
    { field: 'item_name', label: '品目名' },
    { field: 'unit_cost', label: '単価', kind: 'decimal' },
    { field: 'brand_id', label: 'ブランドコード', ref: ref('brands', 'ブランド') },
    { field: 'category_id', label: 'カテゴリーコード', ref: ref('categories', 'カテゴリー') },
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
    { field: 'new_tax_rate', label: '税率', kind: 'decimal', options: TAX_OPTIONS, optionsLabel: '0・8・10' },
    { field: 'new_tax_class_code_id', label: '税区分', ref: codeRef('TAX_DIVISION', '税区分') },
    SORT,
    NOTE,
    ACTIVE,
  ],
  // 税率が空のとき、または税区分だけを直したときは、税区分から税率を決める（画面・API と同じ。3回目の全面テスト）
  complete: (row, ctx) => {
    const division = ctx.codeOf('new_tax_class_code_id');
    const expected = division ? rateForTaxDivision(division, '') : undefined;
    if (expected === undefined) return {};
    const blank = row.new_tax_rate === null || row.new_tax_rate === undefined || row.new_tax_rate === '';
    const classOnly = ctx.touched.has('new_tax_class_code_id') && !ctx.touched.has('new_tax_rate');
    return blank || classOnly ? { new_tax_rate: expected } : {};
  },
  // 税区分と税率の食い違い（「非課税」なのに 10% など）は、画面・API と同じく断る（No.32 D10、再テスト R1 N2）
  rowCheck: (row, ctx) => {
    const division = ctx.codeOf('new_tax_class_code_id');
    const expected = division ? rateForTaxDivision(division, '') : undefined;
    if (expected === undefined || row.new_tax_rate === null || row.new_tax_rate === undefined) return [];
    return Number(row.new_tax_rate) === Number(expected)
      ? []
      : [`税率：税区分「${division}」の税率は ${Number(expected)}% です（入力は ${Number(row.new_tax_rate)}%）`];
  },
};

/**
 * 区分値（「区分値」「通貨」「経費科目」タブ）。カテゴリーとコードの2つで突き合わせる。
 * 画面のタブで開いたときは、そのカテゴリーだけを出す（scope）。
 */
const CODES: MasterCsvDef = {
  slug: 'codes',
  table: 'codes',
  label: '区分値',
  functionId: 'M-16',
  keyFields: ['code_category_id', 'code'],
  columns: [
    { field: 'code_category_id', label: '区分カテゴリー', ref: ref('code_categories', '区分カテゴリー'), readOnly: true },
    textCode('code', 'コード', { readOnly: true }),
    { field: 'name', label: '名称' },
    SORT,
    NOTE,
    ACTIVE,
  ],
  // 区分値の「使わない」は画面では更新の権限で行う（削除の経路が無い）
  deactivateAction: 'update',
  scopeField: 'code_category_id',
  // 通貨は伝票にコードのまま3文字で入れる（currency VARCHAR(3)）。画面の登録と同じ決まり
  rowCheck: (row, ctx) =>
    ctx.codeOf('code_category_id') === 'CURRENCY' && !/^[A-Z]{3}$/.test(String(row.code ?? ''))
      ? ['コード：通貨のコードは英大文字3文字で入れてください（例 USD・CNY）']
      : [],
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
    WAREHOUSES,
    PURCHASE_ITEMS,
    CODES,
  ].map((d) => [d.slug, d]),
);

export const CSV_SLUGS = Object.keys(MASTER_CSV);

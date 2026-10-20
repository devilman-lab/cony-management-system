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

import { OVERSEAS_TAX_LABEL, OVERSEAS_TAX_TREATMENTS } from '../common/settings.service';
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
  /**
   * 取り込みで同じ欄として受ける別の見出し（画面の呼び名を変えたとき、新しい名前の見出しでも読めるように。
   * 2026-10-18 マスター編_3 M3-16「品番（商品分類コード）」）。書き出しは label のまま。
   */
  aliases?: readonly string[];
  /** ○×の欄を「有効／無効」以外の言葉で書き出すとき（[真, 偽]。例「対象／対象外」）。取り込みはこの言葉も受ける */
  boolLabels?: readonly [string, string];
  /**
   * 文字の欄で、データベースの値を画面の言葉で書き出すとき（値 → 言葉。例 exempt →「免税（税抜扱い）」）。
   * 取り込みは言葉も値も受ける。options にはデータベースの値を書く（2026-10-18 マスター編_3 M3-07）。
   */
  valueLabels?: Readonly<Record<string, string>>;
  /**
   * 取り込みだけで読む欄。書き出し・一覧で編集・取込の欄の説明には出さない
   * （画面から外した欄を、前に書き出した CSV に列が残っていても読めるように。SKU の入数区分。2026-10-19 受入 X2）。
   */
  importOnly?: boolean;
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
  /**
   * 前の書式の見出し（呼び名を変えて、同じ見出しが前と今とで別の欄を指すようになったもの）。
   * 見出し行に marker があれば前の書式として、labels の見出しを前の欄（field）で読む。
   * SKU の CSV は、前は「SKUコード」＝SKU・「商品コード」＝品番、今は「商品コード」＝SKU・「品番（商品分類コード）」＝品番
   * （2026-10-18 受入 W2。M3-16 の呼び名に CSV もそろえた）。
   */
  legacyHeaders?: { marker: string; labels: Readonly<Record<string, string>> };
  /**
   * 鍵のうち、見出しに無くても・空欄でもよい欄（得意先別商品の「先方の商品コード」。2026-10-16 マスター編_3 M3-26）。
   * 空欄は「空」という値として突き合わせる。見出しに無いときは残りの鍵で突き合わせ、
   * 当てはまる行が2つ以上あればその行はエラーにする（どの行を直すか決められないため）。
   */
  optionalKeyFields?: string[];
  columns: CsvColumn[];
  /**
   * 有効→無効（非表示）にするのに要る権限（2026-10-12 受入 No.3 D-2）。
   * 既定は update。2026-10-16 M3-02 で画面は編集画面の「表示／非表示」（更新の権限）になったので、CSV もそろえた
   * （以前の既定は一覧の「使わない」と同じ delete）。
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
  /**
   * complete で必ず埋める列。追加の行でも CSV に列が無くてよい（作業指示内容の名称をコードで埋める。M3-40）。
   */
  filled?: readonly string[];
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
  // 商品分類のブランド。商品の登録でブランドを選ぶと、そのブランドの分類（と未設定の分類）だけを候補に出す（M3-18・M3-42）
  product_classes: [{ field: 'brand_id', label: 'ブランドコード', ref: { table: 'brands', codeColumn: 'code', label: 'ブランド' } }],
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
    // 作業指示内容は「名称」を使わない（コードと本文だけ。2026-10-16 マスター編3 M3-40）。名称はコードで埋める
    ...(table === 'work_instructions' ? [] : [{ field: 'name', label: '名称' }]),
    ...(SIMPLE_EXTRA[table] ?? []),
    SORT,
    NOTE,
    ACTIVE,
  ],
  ...(table === 'work_instructions' ? { complete: (row: Record<string, unknown>) => ({ name: row.code }), filled: ['name'] } : {}),
});

/* ---------- それぞれのマスタ ---------- */

const PARTNERS: MasterCsvDef = {
  slug: 'partners',
  table: 'partners',
  label: '取引先',
  functionId: 'M-01',
  keyFields: ['partner_code'],
  // 並びは取引先の編集画面と同じ（2026-10-16 マスター編_3 M3-12）。
  // 取引先カテゴリー・通貨は取引先マスタでは扱わない（M3-08・M3-09。データベースの値はそのまま残る）
  columns: [
    textCode('partner_code', '取引先コード', { readOnly: true }),
    { field: 'is_customer', label: '得意先', kind: 'bool' },
    { field: 'is_supplier', label: '仕入先', kind: 'bool' },
    { field: 'is_royalty_payee', label: 'ロイヤリティ支払先', kind: 'bool' },
    { field: 'name1', label: '取引先名', aliases: ['名称①', '名称1'] },
    { field: 'name2', label: '取引先名2', aliases: ['名称②', '名称2'] },
    { field: 'short_name', label: '略称' },
    // 消費税免税区分（M3-07）。空欄＝なし（国内）。選ぶと海外の取引先として税を 0 にする（complete で is_overseas をそろえる）
    {
      field: 'overseas_tax_treatment',
      label: '消費税免税区分',
      options: OVERSEAS_TAX_TREATMENTS,
      optionsLabel: `${OVERSEAS_TAX_LABEL.exempt}・${OVERSEAS_TAX_LABEL.non_taxable}（空欄はなし）`,
      valueLabels: OVERSEAS_TAX_LABEL,
    },
    // 粗利調整販社（区分値 GROSS_MARGIN_ADJUST：TARGET＝対象／NOT_TARGET＝対象外。M3-10）
    { field: 'gross_margin_adjust_code_id', label: '粗利調整販社', ref: codeRef('GROSS_MARGIN_ADJUST', '粗利調整販社') },
    { field: 'sales_staff_id', label: '販売担当コード', ref: ref('sales_staff', '販売担当') },
    { field: 'default_trade_type', label: '取引区分', options: TRADE_TYPE_OPTIONS },
    { field: 'media_id', label: '媒体コード', ref: ref('media', '媒体') },
    { field: 'shipping_fee_threshold', label: '送料無料になる金額', kind: 'decimal', min: 0 },
    { field: 'shipping_fee_amount', label: '送料', kind: 'decimal', min: 0 },
    { field: 'division_code_id', label: '区分', ref: codeRef('PARTNER_DIVISION', '区分') },
    { field: 'division2_code_id', label: '区分2', ref: codeRef('PARTNER_DIVISION2', '区分2') },
    // 締め日・支払は編集画面の選択肢だけを受ける（2026-10-12 受入 No.2・No.6）
    { field: 'closing_day', label: '締め日', kind: 'number', options: DAY_OPTIONS, optionsLabel: DAY_OPTIONS_LABEL },
    { field: 'invoice_registration_no', label: 'インボイス登録番号' },
    {
      field: 'payment_month_offset',
      label: '支払月（何ヶ月後）',
      kind: 'number',
      options: PAYMENT_MONTH_OPTIONS,
      optionsLabel: PAYMENT_MONTH_OPTIONS_LABEL,
    },
    { field: 'payment_day', label: '支払日', kind: 'number', options: DAY_OPTIONS, optionsLabel: DAY_OPTIONS_LABEL },
    // 支払②・入金方法①②・請求書送付方法（M3-11）。登録・表示だけで、支払予定日は支払①で決める
    {
      field: 'payment_month_offset2',
      label: '支払②の月（何ヶ月後）',
      kind: 'number',
      options: PAYMENT_MONTH_OPTIONS,
      optionsLabel: PAYMENT_MONTH_OPTIONS_LABEL,
    },
    { field: 'payment_day2', label: '支払②の日', kind: 'number', options: DAY_OPTIONS, optionsLabel: DAY_OPTIONS_LABEL },
    { field: 'receipt_method1_code_id', label: '入金方法①', ref: codeRef('RECEIPT_METHOD', '入金方法') },
    { field: 'receipt_method2_code_id', label: '入金方法②', ref: codeRef('RECEIPT_METHOD', '入金方法') },
    { field: 'invoice_send_method_code_id', label: '請求書送付方法', ref: codeRef('INVOICE_SEND_METHOD', '請求書送付方法') },
    { field: 'invoice_note', label: '請求書の備考' },
    { field: 'invoice_addressee', label: '請求書の宛名' },
    { field: 'invoice_contact_name', label: '請求書の担当者名' },
    textCode('postal_code', '郵便番号'),
    textCode('tel', '電話番号'),
    textCode('fax', 'FAX'),
    { field: 'address1', label: '住所1' },
    { field: 'address2', label: '住所2' },
    { field: 'invoice_email', label: '請求書送付先メールアドレス' },
    SORT,
    NOTE,
    ACTIVE,
  ],
  // 消費税免税区分を変えた行は「海外」をそろえる（なし＝国内）。画面・API と同じ（M3-07）
  complete: (row, ctx) =>
    ctx.touched.has('overseas_tax_treatment') ? { is_overseas: row.overseas_tax_treatment !== null && row.overseas_tax_treatment !== undefined } : {},
  rowCheck: (row) => [
    // データベースの決まり ck_partners_role と同じ。確定で弾かれる前に下見で止める
    ...(row.is_customer || row.is_supplier ? [] : ['得意先・仕入先：どちらかを「有効」にしてください']),
    // 請求書送付先メールアドレスの形（画面・API と同じ）
    ...(typeof row.invoice_email === 'string' && row.invoice_email !== '' && !EMAIL_RE.test(row.invoice_email)
      ? ['請求書送付先メールアドレス：メールアドレスの形が正しくありません']
      : []),
  ],
};

/** メールアドレスのおおまかな形（zod の email と同じ程度） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    // 見出しは画面の呼び方「品番（商品分類コード）」（M3-16。2026-10-18 受入 W2 で CSV もそろえた）。
    // 前の見出し「商品コード」（この CSV では品番を指していた）と「品番」でも読む
    textCode('product_code', '品番（商品分類コード）', { readOnly: true, aliases: ['品番', '商品コード'] }),
    { field: 'product_name', label: '商品名' },
    { field: 'set_product_name', label: 'セット商品名' },
    { field: 'brand_id', label: 'ブランドコード', ref: ref('brands', 'ブランド') },
    { field: 'category_id', label: 'カテゴリーコード', ref: ref('categories', 'カテゴリー') },
    // 「品番（商品分類コード）」と並んで取り違えやすいので「商品分類（コード）」と呼ぶ。前の見出し「商品分類コード」でも読む（2026-10-19 受入 X2）
    { field: 'product_class_id', label: '商品分類（コード）', ref: ref('product_classes', '商品分類'), aliases: ['商品分類コード'] },
    { field: 'carton_qty', label: '入数', kind: 'number', min: 0 },
    // 原価・旧原価は SKU ごとに持つ（2026-10-18 マスター編_3 M3-19）。商品の原価は SKU の CSV で直す。
    // 今までの CSV に「原価」「旧原価」「原価未定」の列があっても、知らない見出しとして読み飛ばす
    { field: 'tax_rate', label: '税率', kind: 'decimal', options: TAX_OPTIONS, optionsLabel: '0・8・10' },
    { field: 'is_set', label: 'セット商品', kind: 'bool' },
    // ロイヤリティ区分（機械／機械以外）・下代調整対象（M3-23）。今は登録・表示・CSV のみで、計算には使わない（M3-24 確認中）
    { field: 'royalty_class_code_id', label: 'ロイヤリティ区分', ref: codeRef('ROYALTY_CLASS', 'ロイヤリティ区分') },
    { field: 'is_wholesale_adjust_target', label: '下代調整対象', kind: 'bool', boolLabels: ['対象', '対象外'] },
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
  // 前の書式（見出しに「SKUコード」がある CSV）では、「商品コード」は品番を指す。前に書き出した CSV もそのまま読める
  legacyHeaders: { marker: 'SKUコード', labels: { SKUコード: 'sku_code', 商品コード: 'product_id' } },
  columns: [
    // 見出しは画面の呼び方にそろえる。SKU コード＝「商品コード」、商品の品番＝「品番（商品分類コード）」
    // （M3-16。2026-10-18 受入 W2）。前の見出しは legacyHeaders で読み分ける
    textCode('sku_code', '商品コード', { readOnly: true }),
    {
      field: 'product_id',
      label: '品番（商品分類コード）',
      ref: ref('products', '商品', 'product_code'),
      aliases: ['品番'],
    },
    // SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②）
    { field: 'sku_name', label: 'SKUの商品名' },
    { field: 'color_id', label: 'カラーコード', ref: ref('colors', 'カラー') },
    { field: 'size_id', label: 'サイズコード', ref: ref('sizes', 'サイズ') },
    // 入数区分は画面の SKU 表から外した（M3-20）。書き出しには出さず、前に書き出した CSV の列は読む（2026-10-19 受入 X2）
    textCode('pack_division', '入数区分', { importOnly: true }),
    // JAN は画面・API と同じく 8桁か13桁
    { field: 'jan', label: 'JANコード', kind: 'digits', digitsLength: [8, 13] },
    { field: 'fba_jan', label: 'FBA用JANコード', kind: 'digits', digitsLength: [8, 13] },
    textCode('shop_product_code', 'ショップ商品コード'),
    // サイズ別の原価。空欄なら商品の原価を使う（1001 ご要望）
    { field: 'cost_price', label: '原価', kind: 'decimal', sensitive: true },
    // 旧原価も SKU ごと（2026-10-18 マスター編_3 M3-19）
    { field: 'old_cost_price', label: '旧原価', kind: 'decimal', sensitive: true },
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
  // 同じ取引先・同じ SKU で、先方コード・単価の違う行を複数持てる（2026-10-16 マスター編_3 M3-26）。
  // 行は 取引先＋SKU＋先方の商品コード で突き合わせる。先方の商品コードが空の行は 取引先＋SKU ごとに1つまで
  // （画面・API でも同じ決まり）。先方の商品コードの列が無い CSV は、取引先＋SKU の行が1つのときだけ直せる
  keyFields: ['partner_id', 'sku_id', 'partner_product_code'],
  optionalKeyFields: ['partner_product_code'],
  columns: [
    { field: 'partner_id', label: '取引先コード', ref: ref('partners', '取引先', 'partner_code'), readOnly: true },
    // 見出しは画面の呼び方「商品コード」（SKU のコード。M3-16）。前の見出し「SKUコード」でも読む（2026-10-19 受入 X2）
    { field: 'sku_id', label: '商品コード', ref: ref('skus', 'SKU', 'sku_code'), readOnly: true, aliases: ['SKUコード'] },
    // 行を見分ける鍵なので、CSV・一覧で編集では書き換えない（変えるときは編集画面で）
    textCode('partner_product_code', '先方の商品コード', { readOnly: true }),
    { field: 'partner_jan', label: '先方JAN', kind: 'digits' },
    { field: 'shipping_jan', label: '出荷JAN', kind: 'digits' },
    { field: 'sales_name', label: '販売名' },
    { field: 'sales_name2', label: '販売名2' },
    { field: 'unit_price', label: '単価', kind: 'decimal' },
    { field: 'old_unit_price', label: '旧単価', kind: 'decimal' },
    { field: 'price_changed_date', label: '単価変更日', kind: 'date' },
    { field: 'retail_price', label: '上代', kind: 'decimal' },
    // 原価・メモは使わない（2026-10-16 マスター編_3 M3-28「得意先別原価はない」「メモ不要」）。列はデータベースに残す
    textCode('partner_color', '先方カラー'),
    textCode('partner_size', '先方サイズ'),
    { field: 'product_class_id', label: '商品分類コード', ref: ref('product_classes', '商品分類') },
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

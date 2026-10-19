import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OVERSEAS_TAX_TREATMENTS, SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { MastersCrudService, SIMPLE_MASTERS, type SimpleMaster } from './masters-crud.service';
import { DAY_OPTIONS, DAY_OPTIONS_LABEL, PAYMENT_MONTH_OPTIONS, PAYMENT_MONTH_OPTIONS_LABEL } from './masters-csv';
import {
  JAN_RULE_NOTE,
  describeJanClashes,
  janClashesForProductCode,
  janClashesForSku,
  skuNameExpr,
} from './products.service';
import { assertPurchaseItemTax } from './purchase-item-tax';
import { IS_ROYALTY_HISTORY, assertCustomersInMedia } from './royalty-rule-history';
import {
  CUSTOMER_MODES,
  checkRuleGroup,
  planRuleGroupRows,
  readRuleGroup,
  type RuleGroupSpec,
} from './royalty-rule-group';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, '数値で入力してください');
const tax = z.enum(['0.00', '8.00', '10.00']);
const code = z.string().trim().min(1).max(40);

/** 更新時だけ受ける「有効に戻す」用。無効化は専用の経路、復活は PATCH で行う。 */
const Active = { is_active: z.boolean().optional() };

const ListSchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.infer<typeof ListSchema>;

const PartnerProductListSchema = ListSchema.extend({
  partner_id: z.coerce.number().int().positive().optional(),
  sku_id: z.coerce.number().int().positive().optional(),
  /**
   * 取引先マスタの媒体で絞る。以前は販売先カテゴリーで絞っていたが、取引先カテゴリーは使わなくなった
   * （2026-10-16 マスター編_3 M3-08「媒体で区別してるので、取引先カテゴリー不要」）。
   */
  media_id: z.coerce.number().int().positive().optional(),
});
type PartnerProductListQuery = z.infer<typeof PartnerProductListSchema>;

const DestinationListSchema = ListSchema.extend({
  partner_id: z.coerce.number().int().positive().optional(),
});
type DestinationListQuery = z.infer<typeof DestinationListSchema>;

const PartnerProductLookupSchema = z.object({
  partner_id: z.coerce.number().int().positive(),
  sku_id: z.coerce.number().int().positive(),
});
type PartnerProductLookupQuery = z.infer<typeof PartnerProductLookupSchema>;

// ---- 分類マスタ（10種。同じ形なので1つの経路でまとめて扱う） -----------------
const SimpleSchema = z.object({
  code,
  name: z.string().trim().min(1).max(120),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
  // 納品ルールだけ追加の項目を持つ
  lead_time_days: z.number().int().min(0).max(365).nullish(),
  allowed_weekdays: z.string().trim().max(20).nullish(),
  rule_body: z.string().nullish(),
  // 作業指示内容だけ本文を持つ
  instruction_body: z.string().nullish(),
  // 商品分類だけブランドを持つ（空ならどのブランドの商品でも選べる。2026-10-18 マスター編_3 M3-18・M3-42）
  brand_id: z.number().int().positive().nullish(),
});
type SimpleBody = z.infer<typeof SimpleSchema>;
const SimplePatchSchema = SimpleSchema.partial().extend(Active);
type SimplePatchBody = z.infer<typeof SimplePatchSchema>;

// ---- 取引先 -----------------------------------------------------------------
const PartnerSchema = z.object({
  partner_code: z.string().trim().min(1).max(20),
  name1: z.string().trim().min(1).max(120),
  name2: z.string().trim().max(120).nullish(),
  short_name: z.string().trim().max(60).nullish(),
  is_customer: z.boolean().default(false),
  is_supplier: z.boolean().default(false),
  /**
   * 海外の取引先（2026-10-09 マスター編②）。得意先なら締め処理で消費税を 0 にし、
   * 仕入先なら仕入明細の税区分の初期値を免税／課税対象外にする。省略時は国内（false）。
   * 画面は「消費税免税区分」（下の overseas_tax_treatment）で選び、「なし」が false。
   */
  is_overseas: z.boolean().optional(),
  /**
   * 消費税免税区分（2026-10-16 マスター編_3 M3-07）。exempt＝免税（税抜扱い）／non_taxable＝課税対象外／null＝なし。
   * 受注・納品書・請求書・仕入の税の扱いはこれに従う。is_overseas を送らなければ、これから決める
   * （null なら国内）。is_overseas だけ true で送られたとき（空のまま）はシステム設定 OVERSEAS_TAX_TREATMENT に従う。
   */
  overseas_tax_treatment: z.enum(OVERSEAS_TAX_TREATMENTS).nullish(),
  /** 粗利調整販社（区分値 GROSS_MARGIN_ADJUST：対象／対象外。M3-10） */
  gross_margin_adjust_code_id: z.number().int().positive().nullish(),
  /** 入金方法①②（区分値 RECEIPT_METHOD）・請求書送付方法（区分値 INVOICE_SEND_METHOD）。登録・表示だけ（M3-11） */
  receipt_method1_code_id: z.number().int().positive().nullish(),
  receipt_method2_code_id: z.number().int().positive().nullish(),
  invoice_send_method_code_id: z.number().int().positive().nullish(),
  invoice_email: z.string().trim().max(200).email('請求書送付先メールアドレスの形が正しくありません').nullish(),
  /**
   * 取引通貨（区分値 CURRENCY のコード）。受注・請求・入金はこの通貨で作る（2026-10-12 No.39）。
   * 省略時は円（JPY）。区分値に無いコードは assertCurrency で断る。
   */
  currency: z.string().regex(/^[A-Z]{3}$/, '通貨は英大文字3文字のコードで選んでください（例 JPY・USD）').optional(),
  staff_user_id: z.number().int().positive().nullish(),
  /** 既定の販売担当（販売担当マスタ）。受注に引き継ぐ。 */
  sales_staff_id: z.number().int().positive().nullish(),
  media_id: z.number().int().positive().nullish(),
  /** 代表のカテゴリー。一覧の表示や既定値に使う。 */
  partner_category_id: z.number().int().positive().nullish(),
  /**
   * 取引先が持つカテゴリー（複数可）。1取引先で TV とカタログの両方を持つことがある（1001 ご要望）。
   * 渡されたときだけ丸ごと入れ替える。省略したときは今のまま触らない。
   */
  category_ids: z.array(z.number().int().positive()).max(20).optional(),
  invoice_registration_no: z.string().trim().max(20).nullish(),
  invoice_note: z.string().nullish(),
  /** 請求書の宛名・担当者名。空欄なら取引先名を使う（1001 ご要望）。 */
  invoice_addressee: z.string().trim().max(120).nullish(),
  invoice_contact_name: z.string().trim().max(120).nullish(),
  shipping_fee_threshold: decimal.nullish(),
  shipping_fee_amount: decimal.nullish(),
  default_trade_type: z.enum(['委託', '買取', '仕入']).nullish(),
  /** ロイヤリティの支払先。規定の「支払先」の候補をこの印で絞る（1001 ご要望）。 */
  is_royalty_payee: z.boolean().optional(),
  // 締め日・支払は編集画面の選択肢だけを受ける（2026-10-12 受入 No.2・No.6「7・99 が保存され、編集画面は（なし）になる」）。
  // 一覧で編集・CSV も同じ選択肢（masters-csv.ts）
  closing_day: z
    .number()
    .int()
    .refine((v) => (DAY_OPTIONS as readonly number[]).includes(v), `締め日は ${DAY_OPTIONS_LABEL} のどれかです`)
    .nullish(),
  payment_month_offset: z
    .number()
    .int()
    .refine((v) => (PAYMENT_MONTH_OPTIONS as readonly number[]).includes(v), `支払月は ${PAYMENT_MONTH_OPTIONS_LABEL} のどれかです`)
    .nullish(),
  payment_day: z
    .number()
    .int()
    .refine((v) => (DAY_OPTIONS as readonly number[]).includes(v), `支払日は ${DAY_OPTIONS_LABEL} のどれかです`)
    .nullish(),
  // 支払②（M3-11）。選択肢は支払①と同じ。登録・表示だけで、支払予定日は支払①で決める
  payment_month_offset2: z
    .number()
    .int()
    .refine((v) => (PAYMENT_MONTH_OPTIONS as readonly number[]).includes(v), `支払②の月は ${PAYMENT_MONTH_OPTIONS_LABEL} のどれかです`)
    .nullish(),
  payment_day2: z
    .number()
    .int()
    .refine((v) => (DAY_OPTIONS as readonly number[]).includes(v), `支払②の日は ${DAY_OPTIONS_LABEL} のどれかです`)
    .nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PartnerBody = z.infer<typeof PartnerSchema>;

/** 取引先の区分値の欄と、選べる区分値のカテゴリー（別のカテゴリーの値を入れさせない） */
const PARTNER_CODE_FIELDS = {
  gross_margin_adjust_code_id: { category: 'GROSS_MARGIN_ADJUST', label: '粗利調整販社' },
  receipt_method1_code_id: { category: 'RECEIPT_METHOD', label: '入金方法①' },
  receipt_method2_code_id: { category: 'RECEIPT_METHOD', label: '入金方法②' },
  invoice_send_method_code_id: { category: 'INVOICE_SEND_METHOD', label: '請求書送付方法' },
} as const;

/**
 * 「消費税免税区分」と「海外」をそろえる（M3-07）。なし（null）なら国内、選べば海外。
 * 国内にするときは区分も消す（国内なのに免税の区分が残らないように）。
 */
function syncOverseas<T extends { is_overseas?: boolean; overseas_tax_treatment?: string | null }>(v: T): T {
  if (v.is_overseas === undefined && v.overseas_tax_treatment !== undefined) {
    return { ...v, is_overseas: v.overseas_tax_treatment !== null };
  }
  if (v.is_overseas === false) return { ...v, overseas_tax_treatment: null };
  return v;
}

// ---- 納品先 -----------------------------------------------------------------
const DestinationSchema = z.object({
  partner_id: z.number().int().positive(),
  delivery_code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  partner_delivery_no: z.string().trim().max(40).nullish(),
  consignee: z.string().trim().max(120).nullish(),
  delivery_note_print1: z.string().nullish(),
  delivery_note_print2: z.string().nullish(),
  work_instruction_id: z.number().int().positive().nullish(),
  /**
   * 納品ルール。2026-10-01 のご指摘で **画面からは外した**（不要とのこと）。
   * API は今まで通り受け付ける。すでに入っている値を消さないため、また
   * 使うことになったときに画面を戻すだけで済むようにするため。
   */
  delivery_rule_id: z.number().int().positive().nullish(),
  default_warehouse_id: z.number().int().positive().nullish(),
  slip_issue_class_code_id: z.number().int().positive().nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type DestinationBody = z.infer<typeof DestinationSchema>;

// ---- 商品 -------------------------------------------------------------------
const ProductSchema = z.object({
  product_code: z.string().trim().min(1).max(40),
  product_name: z.string().trim().min(1).max(200),
  set_product_name: z.string().trim().max(200).nullish(),
  brand_id: z.number().int().positive().nullish(),
  category_id: z.number().int().positive().nullish(),
  product_class_id: z.number().int().positive().nullish(),
  carton_qty: z.number().int().min(0).nullish(),
  cost_price: decimal.default('0'),
  /** 旧原価。原価を変えたときに前の値を残す（1001 ご要望）。 */
  old_cost_price: decimal.nullish(),
  is_cost_undecided: z.boolean().default(false),
  tax_rate: tax.default('10.00'),
  is_set: z.boolean().default(false),
  /** ロイヤリティ区分（区分値 ROYALTY_CLASS：機械／機械以外。2026-10-18 マスター編_3 M3-23）。今は登録・表示のみ */
  royalty_class_code_id: z.number().int().positive().nullish(),
  /** 下代調整対象（対象／対象外。M3-23）。今は登録・表示のみ */
  is_wholesale_adjust_target: z.boolean().default(false),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type ProductBody = z.infer<typeof ProductSchema>;

// ---- SKU --------------------------------------------------------------------
const SkuSchema = z.object({
  product_id: z.number().int().positive(),
  sku_code: z.string().trim().min(1).max(40),
  /** SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②） */
  sku_name: z.string().trim().max(200).nullish(),
  color_id: z.number().int().positive().nullish(),
  size_id: z.number().int().positive().nullish(),
  pack_division: z.string().trim().max(10).nullish(),
  jan: z
    .string()
    .trim()
    .regex(/^\d{8}$|^\d{13}$/, 'JANコードは8桁または13桁の数字で入力してください')
    .nullish(),
  /** FBA専用のJAN。出荷依頼書・JAN発行でコニーJANの代わりに使う（1001 ご要望）。 */
  fba_jan: z
    .string()
    .trim()
    .regex(/^\d{8}$|^\d{13}$/, 'FBAのJANコードは8桁または13桁の数字で入力してください')
    .nullish(),
  /** ショップ側の商品コード（1001 ご要望）。 */
  shop_product_code: z.string().trim().max(60).nullish(),
  /** このSKUだけの原価。空欄なら商品の原価を使う（サイズ別原価。1001 ご要望）。 */
  cost_price: decimal.nullish(),
  /** 旧原価。原価を変えたときに前の値を残す。原価と同じく SKU ごと（2026-10-18 マスター編_3 M3-19） */
  old_cost_price: decimal.nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type SkuBody = z.infer<typeof SkuSchema>;

/**
 * 商品の登録で、SKU もまとめて1回で登録するとき（2026-10-18 受入 W1 N5）。row_no は画面の SKU 表の行番号（理由に出す）。
 * 以前は商品を登録してから SKU を1行ずつ登録していたため、SKU が重なって断られると、SKU の無い商品だけが残っていた。
 */
const ProductCreateSchema = ProductSchema.extend({
  skus: z
    .array(SkuSchema.omit({ product_id: true }).extend({ row_no: z.number().int().positive().optional() }))
    .max(500)
    .optional(),
});
type ProductCreateBody = z.infer<typeof ProductCreateSchema>;

// ---- セット登録 -------------------------------------------------------------
const SetSchema = z.object({
  sku_id: z.number().int().positive(),
  components: z
    .array(
      z.object({
        component_sku_id: z.number().int().positive(),
        qty: z.string().regex(/^\d+(\.\d+)?$/, '構成数は0より大きい数値で入力してください'),
        sort_order: z.number().int().nullish(),
      }),
    )
    .min(1, '構成品を1件以上登録してください'),
  note: z.string().nullish(),
});
type SetBody = z.infer<typeof SetSchema>;
/** セットの編集（構成の入れ替え）。セット SKU は変えられないので受け取らない（M-14） */
// 表示／非表示（is_active）も編集画面で切り替える（2026-10-16 マスター編3 M3-02）
const SetUpdateSchema = SetSchema.omit({ sku_id: true }).extend(Active);
type SetUpdateBody = z.infer<typeof SetUpdateSchema>;

// ---- 得意先別商品 -----------------------------------------------------------
const PartnerProductSchema = z.object({
  partner_id: z.number().int().positive(),
  sku_id: z.number().int().positive(),
  // 空は「無し」として持つ。同じ取引先・SKU で先方の商品コードが無い行は1つまで（M3-26）なので、空文字と無しを分けない
  partner_product_code: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => (v === '' ? null : v)),
  partner_jan: z.string().trim().max(20).nullish(),
  jan_code: z.string().trim().max(20).nullish(),
  /** 出荷用のJAN。受注入力で先方JANから引く（1001 ご要望）。 */
  shipping_jan: z.string().trim().max(20).nullish(),
  sales_name: z.string().trim().max(200).nullish(),
  sales_name2: z.string().trim().max(200).nullish(),
  unit_price: decimal.default('0'),
  /** 旧単価と、単価を変えた日。値上げ・値下げの経緯を残すため（1001 ご要望）。 */
  old_unit_price: decimal.nullish(),
  price_changed_date: ymd.nullish(),
  /** 上代。納品書「上代あり」に印字する（9/15 ご回答で得意先別商品マスタに置くと確定）。 */
  retail_price: decimal.nullish(),
  // 原価・メモは画面から外した（2026-10-16 マスター編_3 M3-28「得意先別原価はない」「メモ不要」）。
  // 列は残すので、送られてきたら受けるが、どこの計算にも使わない（粗利の原価は SKU → 商品の順）
  cost_price: decimal.nullish(),
  partner_color: z.string().trim().max(40).nullish(),
  partner_size: z.string().trim().max(40).nullish(),
  color_name: z.string().trim().max(40).nullish(),
  size_name: z.string().trim().max(40).nullish(),
  memo: z.string().nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PartnerProductBody = z.infer<typeof PartnerProductSchema>;

// ---- 倉庫 -------------------------------------------------------------------
const WarehouseSchema = z.object({
  warehouse_code: z.string().trim().min(1).max(20),
  short_name: z.string().trim().min(1).max(60),
  is_consignment: z.boolean().default(false),
  partner_id: z.number().int().positive().nullish(),
  media_id: z.number().int().positive().nullish(),
  postal_code: z.string().trim().max(8).nullish(),
  address1: z.string().trim().max(200).nullish(),
  address2: z.string().trim().max(200).nullish(),
  tel: z.string().trim().max(20).nullish(),
  fax: z.string().trim().max(20).nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type WarehouseBody = z.infer<typeof WarehouseSchema>;

// ---- 仕入マスタ（仕入品目） -------------------------------------------------
const PurchaseItemSchema = z.object({
  purchase_code: z.string().trim().min(1).max(60),
  item_name: z.string().trim().min(1).max(200),
  unit_cost: decimal.default('0'),
  brand_id: z.number().int().positive().nullish(),
  category_id: z.number().int().positive().nullish(),
  product_class_id: z.number().int().positive().nullish(),
  new_tax_rate: tax.nullish(),
  /** 税区分（課税10%／軽減8%／非課税／不課税）。区分値 TAX_DIVISION（1001 ご要望）。 */
  new_tax_class_code_id: z.number().int().positive().nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type PurchaseItemBody = z.infer<typeof PurchaseItemSchema>;

// ---- 汎用区分 ---------------------------------------------------------------
const CodeSchema = z.object({
  code_category_code: code,
  code,
  name: z.string().trim().min(1).max(120),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});
type CodeBody = z.infer<typeof CodeSchema>;

/**
 * プログラムがコードで引いている区分値（M3-39 の削除で守るもの）。'*' はそのカテゴリーの値すべて。
 * 消すと入荷・在庫調整・引当・税の計算などが「登録されていません」で止まるため、使われていなくても消さない。
 */
const PROTECTED_CODES: Record<string, readonly string[] | '*'> = {
  QUALITY_DIVISION: '*',
  TAX_DIVISION: '*',
  ADJUSTMENT_REASON: ['OTHER', 'STOCKTAKE', 'REFURB'],
  CURRENCY: ['JPY'],
};

// ---- ロイヤリティ規定 -------------------------------------------------------
// 販売先の指定のしかた（媒体全体／対象／対象外）と、行のまとまりの作り方は royalty-rule-group.ts。
/** 1件の規定で選べる販売先の上限。ご要望の「20社まで」。 */
const MAX_RULE_CUSTOMERS = 20;
/** 1件の規定で選べる「対象の商品」「対象外の商品」の上限（それぞれ）。M3-33 */
const MAX_RULE_PRODUCTS = 50;

/** 絞り込みを重ねると .innerType() で素の形に戻せないため、素の形は名前を付けて持つ。 */
const RoyaltyRuleBase = z.object({
  payee_partner_id: z.number().int().positive(),
  brand_id: z.number().int().positive().nullish(),
  /** 昔の1件だけの商品の欄。product_ids が無いときだけ見る */
  product_id: z.number().int().positive().nullish(),
  /** 対象の商品（M3-33。空ならブランド配下のすべて） */
  product_ids: z
    .array(z.number().int().positive())
    .max(MAX_RULE_PRODUCTS, `対象の商品は${MAX_RULE_PRODUCTS}件までです`)
    .optional(),
  /** 対象外の商品（M3-33）。料率の行より優先して、この商品だけロイヤリティを付けない */
  excluded_product_ids: z
    .array(z.number().int().positive())
    .max(MAX_RULE_PRODUCTS, `対象外の商品は${MAX_RULE_PRODUCTS}件までです`)
    .optional(),
  customer_partner_id: z.number().int().positive().nullish(),
  /** 媒体。空欄ならすべての媒体（1001 ご要望）。 */
  media_id: z.number().int().positive().nullish(),
  customer_mode: z.enum(CUSTOMER_MODES).default('媒体全体'),
  /** 上の指定で選んだ販売先。媒体全体のときは空。 */
  customer_partner_ids: z
    .array(z.number().int().positive())
    .max(MAX_RULE_CUSTOMERS, `販売先は${MAX_RULE_CUSTOMERS}社までです`)
    .default([]),
  is_excluded: z.boolean().default(false),
  // 計算の基準は請求月（＝売上。締めた請求の月に計上）に統一した（2026-10-16 M3-32）。画面では選ばせない。
  // 出荷・入金は計算の経路を残してあるので API では受け付ける
  calc_base: z.enum(['売上', '出荷', '入金']).default('売上'),
  rate: z.string().regex(/^\d(\.\d{1,4})?$/, '料率は 0.0500（5%）のような形で入力してください').nullish(),
  fixed_amount: decimal.nullish(),
  valid_from: ymd,
  valid_to: ymd.nullish(),
  sort_order: z.number().int().nullish(),
  note: z.string().nullish(),
});

const RoyaltyRuleSchema = RoyaltyRuleBase
  .refine((v) => !(v.is_excluded && (v.rate || v.fixed_amount)), {
    message: '対象外の規定には料率・定額を入力しません',
  })
  /**
   * 料率は「対象外だけを入れるとき」以外は必ず要る。
   * 対象外のときに料率も入れると「媒体全体にこの料率、ただしこの数社は対象外」の1枚になる。
   * 料率を入れなければ「この数社は対象外」だけを足す形になり、料率は別の規定が受け持つ。
   */
  .refine(
    (v) =>
      v.customer_mode === '対象外' ||
      v.is_excluded ||
      (v.excluded_product_ids?.length ?? 0) > 0 ||
      Boolean(v.rate || v.fixed_amount),
    { message: '料率か定額のどちらかを入力してください' },
  )
  .refine((v) => v.customer_mode === '媒体全体' || v.customer_partner_ids.length > 0, {
    message: '販売先を1社以上選んでください。媒体の全販売先を対象にするときは「媒体全体」を選びます',
  })
  .refine((v) => v.customer_mode !== '媒体全体' || v.customer_partner_ids.length === 0, {
    message: '「媒体全体」を選んだときは販売先を選びません',
  })
  .refine((v) => new Set(v.customer_partner_ids).size === v.customer_partner_ids.length, {
    message: '同じ販売先が重なっています',
  })
  // 媒体は入力必須（1001 ご要望「媒体が入力必須で…」）。画面だけでなく API でも止める
  .refine((v) => v.media_id != null, { message: '媒体を選んでください', path: ['media_id'] });
type RoyaltyRuleBody = z.infer<typeof RoyaltyRuleSchema>;

/**
 * マスタの登録・更新。
 *
 * **マスタは物理削除しない。**伝票から参照されているため、使わなくなったものは
 * 「無効」にして一覧から外す。過去の伝票はそのまま読める。
 */
@Controller('masters')
export class MastersWriteController {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly crud: MastersCrudService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
  ) {}

  // ---- 分類マスタ -----------------------------------------------------------
  /** ブランド・カラー・サイズなど、同じ形の10種をまとめて扱う。 */
  @Get('simple/:kind')
  @RequirePermission('M-16', 'view')
  listSimple(
    @Param('kind') kind: string,
    @Query(new ZodValidationPipe(ListSchema)) query: ListQuery,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.list(table, {
      ...query,
      // 作業指示は本文（出荷指示書に印字する文言）も検索できるようにする。
      // 納品先マスタで中身から探せないと選べないため（1001 ご要望）。
      searchColumns: table === 'work_instructions' ? ['code', 'name', 'instruction_body'] : ['code', 'name'],
      orderBy: ['sort_order', 'code'],
    });
  }

  @Post('simple/:kind')
  @RequirePermission('M-16', 'create')
  createSimple(
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(SimpleSchema)) body: SimpleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    const values = this.simpleValues(table, body);
    // 作業指示の本文は必須の列。新規で本文が無いときは、これまでどおり備考を本文として使う
    if (table === 'work_instructions' && values.instruction_body === undefined) values.instruction_body = body.note ?? '';
    return this.crud.create(table, values, user.id);
  }

  @Patch('simple/:kind/:id')
  @RequirePermission('M-16', 'update')
  updateSimple(
    @Param('kind') kind: string,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SimplePatchSchema)) body: SimplePatchBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.update(table, id, this.simpleValues(table, body), SIMPLE_MASTERS[table], user.id);
  }

  @Post('simple/:kind/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-16', 'delete')
  deactivateSimple(
    @Param('kind') kind: string,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const table = this.simpleTable(kind);
    return this.crud.setActive(table, id, false, SIMPLE_MASTERS[table], user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('simple/:kind/:id')
  @RequirePermission('M-16', 'delete')
  removeSimple(@Param('kind') kind: string, @Param('id', ParseIntPipe) id: number) {
    const table = this.simpleTable(kind);
    return this.crud.remove(table, id, SIMPLE_MASTERS[table]);
  }

  private simpleTable(kind: string): SimpleMaster {
    if (!(kind in SIMPLE_MASTERS)) {
      throw new NotFoundException(
        `マスタ「${kind}」はありません。次のいずれかを指定してください：${Object.keys(SIMPLE_MASTERS).join('、')}`,
      );
    }
    return kind as SimpleMaster;
  }

  /** 分類マスタごとに存在する列だけを残す。 */
  private simpleValues(table: SimpleMaster, body: Partial<SimpleBody> & { is_active?: boolean }): Record<string, unknown> {
    const base: Record<string, unknown> = {
      code: body.code,
      name: body.name,
      sort_order: body.sort_order,
      note: body.note,
      is_active: body.is_active,
    };
    if (table === 'delivery_rules') {
      base.lead_time_days = body.lead_time_days;
      base.allowed_weekdays = body.allowed_weekdays;
      base.rule_body = body.rule_body;
    }
    if (table === 'work_instructions') {
      // 本文が送られてきたときだけ直す。送られてこない更新（「有効に戻す」や名前だけの修正）で
      // 本文が空や備考の値で上書きされ、検索にも出なくなっていた（1001 のご指摘への対応の後で判明）
      if (body.instruction_body !== undefined) base.instruction_body = body.instruction_body ?? '';
    }
    // 商品分類のブランド（M3-18・M3-42）。送られてきたときだけ直す（「有効に戻す」などで消さない）
    if (table === 'product_classes') base.brand_id = body.brand_id;
    return base;
  }

  // ---- 取引先 ---------------------------------------------------------------
  @Post('partners')
  @RequirePermission('M-01', 'create')
  async createPartner(
    @Body(new ZodValidationPipe(PartnerSchema)) body: PartnerBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { category_ids, ...rest } = body;
    const values = syncOverseas(rest);
    // 海外にしたのに区分が空なら、いまのシステム設定の扱いを取引先の区分として入れる（空のままだと
    // 画面・CSV で「なし」と見え、別の欄を直して取り込んだときに国内に戻ってしまうため）
    if (values.is_overseas === true && !values.overseas_tax_treatment) {
      values.overseas_tax_treatment = await this.settings.overseasTaxTreatment(null);
    }
    await this.assertCurrency(values.currency);
    await this.assertPartnerCodes(values);
    // 代表のカテゴリーは、持っているカテゴリーの先頭にそろえる（一覧で編集・CSV と同じ。受入 No.8）
    if (category_ids !== undefined && values.partner_category_id === undefined) values.partner_category_id = category_ids[0] ?? null;
    const row = await this.crud.create('partners', values, user.id);
    await this.savePartnerCategories(Number(row.id), category_ids, user.id);
    return { ...row, category_ids: category_ids ?? [] };
  }

  /**
   * 取引先の通貨が区分値 CURRENCY にあるか（2026-10-12 No.39）。
   * 「使わない」にした通貨でも、今その通貨の取引先を直せるよう、有無だけを見る。
   */
  private async assertCurrency(code: string | undefined): Promise<void> {
    if (code === undefined) return;
    const found = await this.db
      .selectFrom('codes as c')
      .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
      .select('c.id')
      .where('cc.code', '=', 'CURRENCY')
      .where('c.code', '=', code)
      .executeTakeFirst();
    if (!found) {
      throw new BadRequestException(`通貨「${code}」は登録されていません。「分類・区分・設定」の「通貨」タブで足してから選んでください`);
    }
  }

  /** 粗利調整販社・入金方法・請求書送付方法が、それぞれの区分値のカテゴリーの値か（M3-10・M3-11） */
  private async assertPartnerCodes(values: Partial<Record<keyof typeof PARTNER_CODE_FIELDS, number | null>>): Promise<void> {
    for (const [field, { category, label }] of Object.entries(PARTNER_CODE_FIELDS)) {
      const id = values[field as keyof typeof PARTNER_CODE_FIELDS];
      if (id === undefined || id === null) continue;
      const found = await this.db
        .selectFrom('codes as c')
        .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
        .select('c.id')
        .where('cc.code', '=', category)
        .where('c.id', '=', id)
        .executeTakeFirst();
      if (!found) throw new BadRequestException(`${label}の選択肢が見つかりません（ID: ${id}）。画面を開き直して選び直してください`);
    }
  }

  @Patch('partners/:id')
  @RequirePermission('M-01', 'update')
  async updatePartner(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PartnerSchema.partial().extend(Active))) body: Partial<PartnerBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { category_ids, ...rest } = body;
    const values = syncOverseas(rest);
    // 海外にしたのに区分が空なら、今の区分（無ければシステム設定）を入れる（作るときと同じ理由）
    if (values.is_overseas === true && !values.overseas_tax_treatment) {
      const cur = await this.db.selectFrom('partners').select('overseas_tax_treatment').where('id', '=', id).executeTakeFirst();
      values.overseas_tax_treatment = await this.settings.overseasTaxTreatment(cur?.overseas_tax_treatment ?? null);
    }
    await this.assertPartnerCodes(values);
    // 代表のカテゴリーは、持っているカテゴリーの先頭にそろえる（一覧で編集・CSV と同じ。受入 No.8）
    if (category_ids !== undefined && values.partner_category_id === undefined) values.partner_category_id = category_ids[0] ?? null;

    // カテゴリーだけを直すこともある。そのときは取引先そのものに書くことが無いので、
    // crud.update を呼ぶと「更新する項目がありません」で弾かれてしまう。
    const hasOther = Object.values(values).some((v) => v !== undefined);
    if (!hasOther && category_ids === undefined) {
      throw new BadRequestException('更新する項目がありません');
    }
    await this.assertCurrency(values.currency);
    const row = hasOther
      ? await this.crud.update('partners', id, values, '取引先', user.id)
      : await this.crud.findOne('partners', id, '取引先');

    await this.savePartnerCategories(id, category_ids, user.id);
    return row;
  }

  /**
   * 取引先のカテゴリー（複数）を入れ替える。
   * undefined のときは触らない（カテゴリーを送っていない更新で、既存を消さないため）。
   */
  private async savePartnerCategories(partnerId: number, ids: number[] | undefined, userId: number): Promise<void> {
    if (ids === undefined) return;
    const unique = [...new Set(ids)];
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('partner_category_links').where('partner_id', '=', partnerId).execute();
      if (unique.length === 0) return;
      await trx
        .insertInto('partner_category_links')
        .values(unique.map((cid) => ({ partner_id: partnerId, partner_category_id: cid, created_by: userId })))
        .execute();
    });
  }

  @Post('partners/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-01', 'delete')
  deactivatePartner(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('partners', id, false, '取引先', user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('partners/:id')
  @RequirePermission('M-01', 'delete')
  removePartner(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('partners', id, '取引先');
  }

  // ---- 納品先 ---------------------------------------------------------------
  /** 納品先の一覧。取引先で絞れ、取引先名も一緒に返す。 */
  /** 納品先の一覧。作業指示は名前も返す（画面で検索して選ぶため）。 */
  @Get('delivery-destinations')
  @RequirePermission('M-05', 'view')
  async listDestinations(@Query(new ZodValidationPipe(DestinationListSchema)) query: DestinationListQuery) {
    let base = this.db
      .selectFrom('delivery_destinations as d')
      .innerJoin('partners as p', 'p.id', 'd.partner_id')
      // 作業指示は画面で検索して選ぶので、名前も返す（1001 ご要望）
      .leftJoin('work_instructions as wi', 'wi.id', 'd.work_instruction_id');
    if (!query.include_inactive) base = base.where('d.is_active', '=', true);
    if (query.partner_id !== undefined) base = base.where('d.partner_id', '=', query.partner_id);
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('d.delivery_code', 'ilike', like),
          eb('d.name', 'ilike', like),
          eb('d.consignee', 'ilike', like),
          eb('p.name1', 'ilike', like),
          eb('p.short_name', 'ilike', like),
          eb('p.partner_code', 'ilike', like),
        ]),
      );
    }
    const [items, total] = await Promise.all([
      base
        .selectAll('d')
        .select([
          'p.partner_code as partner_code',
          'p.name1 as partner_name',
          // 一覧の取引先は「取引先コード」と「略称」の2列で出す（2026-10-16 マスター編_3 M3-13）
          'p.short_name as partner_short_name',
          'wi.name as work_instruction_name',
          'wi.code as work_instruction_code',
          // 編集画面で「作業指示内容」（選んだ作業指示の本文）を読めるようにする（2026-10-09 マスター編② M-04）
          'wi.instruction_body as work_instruction_body',
        ])
        .orderBy('p.partner_code')
        .orderBy('d.sort_order', sql`asc nulls last`)
        .orderBy('d.delivery_code')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  @Post('delivery-destinations')
  @RequirePermission('M-05', 'create')
  createDestination(
    @Body(new ZodValidationPipe(DestinationSchema)) body: DestinationBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('delivery_destinations', body, user.id);
  }

  @Patch('delivery-destinations/:id')
  @RequirePermission('M-05', 'update')
  updateDestination(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(DestinationSchema.partial().extend(Active))) body: Partial<DestinationBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('delivery_destinations', id, body, '納品先', user.id);
  }

  @Post('delivery-destinations/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-05', 'delete')
  deactivateDestination(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('delivery_destinations', id, false, '納品先', user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('delivery-destinations/:id')
  @RequirePermission('M-05', 'delete')
  removeDestination(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('delivery_destinations', id, '納品先');
  }

  // ---- 商品 -----------------------------------------------------------------
  /**
   * 商品の登録。skus を付けると、商品と SKU を1つのトランザクションで登録する（W1 N5）。
   * SKU のどれかが登録できなければ（商品コードの重なり・JAN の左6桁ルールなど）、行ごとの理由を返して何も登録しない。
   */
  @Post('products')
  @RequirePermission('M-08', 'create')
  async createProduct(
    @Body(new ZodValidationPipe(ProductCreateSchema)) body: ProductCreateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { skus, ...product } = body;
    if (!skus || skus.length === 0) return this.crud.create('products', product, user.id);
    // SKU の登録は SKU の「作成」の権限（POST skus と同じ）
    if (!(await this.auth.can(user.id, 'M-09', 'create'))) {
      throw new ForbiddenException('SKU を登録する権限がありません（SKU の「作成」の権限が要ります）');
    }
    return this.db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('products').select('id').where('product_code', '=', product.product_code).executeTakeFirst();
      if (dup) throw new ConflictException('この品番はすでに登録されています');
      const row = await trx
        .insertInto('products')
        .values({ ...product, created_by: user.id, updated_by: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 先に全部の行を確かめ、理由を行ごとにまとめて返す（1行目で止めず、直すところが一度に分かるように）
      const problems: string[] = [];
      const label = (k: (typeof skus)[number], i: number) => `SKU ${k.row_no ?? i + 1}行目（商品コード ${k.sku_code}）`;
      const codes = skus.map((k) => k.sku_code);
      const taken = new Map(
        (
          await trx
            .selectFrom('skus as s')
            .innerJoin('products as p', 'p.id', 's.product_id')
            .select(['s.sku_code as sku_code', 'p.product_code as product_code'])
            .where('s.sku_code', 'in', codes)
            .execute()
        ).map((r) => [r.sku_code, r.product_code]),
      );
      for (let i = 0; i < skus.length; i += 1) {
        const k = skus[i];
        if (codes.indexOf(k.sku_code) !== i) {
          problems.push(`${label(k, i)}：同じ商品コードの行がほかにもあります`);
        } else if (taken.has(k.sku_code)) {
          problems.push(`${label(k, i)}：この商品コードはすでに品番 ${taken.get(k.sku_code)} で登録されています`);
        }
        if (k.jan) {
          const clashes = await janClashesForSku(trx, { sku_code: k.sku_code, product_id: Number(row.id), jan: k.jan });
          if (clashes.length > 0) problems.push(`${label(k, i)}：${describeJanClashes(clashes)}。${JAN_RULE_NOTE}`);
        }
      }
      if (problems.length > 0) {
        throw new ConflictException(`SKU を登録できないため、商品も登録していません。直してからもう一度「登録する」を押してください。${problems.join('／')}`);
      }
      for (const { row_no: _rowNo, ...k } of skus) {
        void _rowNo;
        await trx
          .insertInto('skus')
          .values({ ...k, product_id: Number(row.id), created_by: user.id, updated_by: user.id })
          .execute();
      }
      return { ...row, sku_count: skus.length };
    });
  }

  @Patch('products/:id')
  @RequirePermission('M-08', 'update')
  async updateProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ProductSchema.partial().extend(Active))) body: Partial<ProductBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 品番を付け替えるときは、その商品の全 SKU の JAN が「品番の左6桁が違う商品」と重ならないかを見る（No.16）。
    // JAN の引き金は skus にしか無く、品番だけを変えるとすり抜けていた。
    // CSV 取り込み・一覧で編集は品番が鍵（変えられない）なので、品番を変えられる入口はここだけ。
    if (body.product_code !== undefined) {
      const cur = await this.db.selectFrom('products').select('product_code').where('id', '=', id).executeTakeFirst();
      if (cur && cur.product_code !== body.product_code) {
        const clashes = await janClashesForProductCode(this.db, id, body.product_code);
        if (clashes.length > 0) {
          throw new ConflictException(
            `品番を ${body.product_code} に変えると、JAN が品番の左6桁が違う商品と重なります：${describeJanClashes(clashes)}。` +
              `${JAN_RULE_NOTE}。先にその SKU の JAN を直してから品番を変えてください`,
          );
        }
      }
    }
    return this.crud.update('products', id, body, '商品', user.id);
  }

  @Post('products/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-08', 'delete')
  deactivateProduct(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('products', id, false, '商品', user.id);
  }

  // 商品・SKU・セットの削除（DELETE products/:id・skus/:id・sets/:id）は products.controller.ts にある。
  // SKU ごと消すことと、どこで使われているかを数える処理を ProductsService に持たせたため（2026-10-09 マスター編②）。

  // ---- SKU ------------------------------------------------------------------
  @Post('skus')
  @RequirePermission('M-09', 'create')
  async createSku(
    @Body(new ZodValidationPipe(SkuSchema)) body: SkuBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (body.jan) await this.assertSkuJan({ sku_code: body.sku_code, product_id: body.product_id, jan: body.jan });
    return this.crud.create('skus', body, user.id);
  }

  @Patch('skus/:id')
  @RequirePermission('M-09', 'update')
  async updateSku(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SkuSchema.partial().extend(Active))) body: Partial<SkuBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const cur = await this.db
      .selectFrom('skus')
      .select(['sku_code', 'jan', 'product_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!cur) throw new NotFoundException(`SKU が見つかりません（ID: ${id}）`);

    // JAN・商品が今と同じなら書かない。JAN の引き金（trg_skus_jan）は「書いた」だけで動くため、
    // 決まりに合わなくなっていた SKU は、入数区分だけを直そうとしても JAN のエラーで保存できなかった（No.16）
    const patch: Partial<SkuBody> & { is_active?: boolean } = { ...body };
    if (patch.jan !== undefined && (patch.jan ?? null) === (cur.jan ?? null)) delete patch.jan;
    if (patch.product_id !== undefined && patch.product_id === Number(cur.product_id)) delete patch.product_id;

    // JAN か商品を変えるときは、相手の品番・SKU コードまで出して断る
    const jan = patch.jan !== undefined ? patch.jan : cur.jan;
    if ((patch.jan !== undefined || patch.product_id !== undefined) && jan) {
      await this.assertSkuJan({ id, sku_code: patch.sku_code ?? cur.sku_code, product_id: patch.product_id ?? Number(cur.product_id), jan });
    }
    // 送られた欄がすべて今と同じ JAN・商品だけだったとき
    if (Object.values(patch).every((v) => v === undefined)) return this.crud.findOne('skus', id, 'SKU');
    return this.crud.update('skus', id, patch, 'SKU', user.id);
  }

  /** SKU の JAN が「品番の左6桁が違う商品」と重なっていれば、相手の品番・SKU コードを出して断る（No.16） */
  private async assertSkuJan(sku: { id?: number; sku_code: string; product_id: number; jan: string }): Promise<void> {
    const clashes = await janClashesForSku(this.db, sku);
    if (clashes.length > 0) {
      throw new ConflictException(`${describeJanClashes(clashes)}。${JAN_RULE_NOTE}`);
    }
  }

  // ---- セット登録 -----------------------------------------------------------
  /**
   * セット登録（新規・コピー）。セット自体は在庫を持たず、構成している商品から引き落とす。
   *
   * 新しく作るだけで、すでにセット登録のある SKU には書かない（409）。以前は同じ SKU なら構成を
   * 黙って入れ替えており、コピーで登録済みのセット SKU を選ぶと、受注で使っているセットの構成まで
   * 上書きされた（M-14）。構成を入れ替えるのは編集（PUT sets/:id）だけ。
   */
  @Post('sets')
  @RequirePermission('M-10', 'create')
  async createSet(
    @Body(new ZodValidationPipe(SetSchema)) body: SetBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const sku = await this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('set_headers as h', 'h.sku_id', 's.id')
      .select(['s.sku_code as sku_code', 'p.is_set as is_set', 'h.id as set_id'])
      .where('s.id', '=', body.sku_id)
      .executeTakeFirst();
    if (!sku) throw new BadRequestException('セット SKU が見つかりません。選び直してください');
    // 画面の候補と同じく、商品マスタで「セット商品」にした商品の SKU だけ（M-15）
    if (!sku.is_set) {
      throw new BadRequestException(
        `SKU ${sku.sku_code} はセット商品ではありません。商品マスタで「セット商品」にした商品の SKU を選んでください`,
      );
    }
    const exists = `セット SKU ${sku.sku_code} はすでにセット登録があります。直すときは一覧の「編集」から`;
    if (sku.set_id !== null) throw new ConflictException(exists);

    try {
      return await this.db.transaction().execute(async (trx) => {
        const header = await trx
          .insertInto('set_headers')
          .values({ sku_id: body.sku_id, note: body.note ?? null, created_by: user.id, updated_by: user.id })
          .returning(['id', 'sku_id'])
          .executeTakeFirstOrThrow();
        await this.writeSetComponents(trx, Number(header.id), body.components, user.id);
        return { ...header, components: body.components.length };
      });
    } catch (e) {
      // 調べたあとに別の人が同じ SKU で登録した場合
      if ((e as { code?: string; constraint?: string }).constraint === 'set_headers_sku_id_key') {
        throw new ConflictException(exists);
      }
      throw e;
    }
  }

  /** セットの編集。構成品と備考を入れ替える。セット SKU は変えない（M-14） */
  @Put('sets/:id')
  @RequirePermission('M-10', 'update')
  async updateSet(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SetUpdateSchema)) body: SetUpdateBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const header = await trx
        .updateTable('set_headers')
        .set({ note: body.note ?? null, ...(body.is_active !== undefined ? { is_active: body.is_active } : {}), updated_by: user.id, updated_at: new Date() })
        .where('id', '=', id)
        .returning(['id', 'sku_id'])
        .executeTakeFirst();
      if (!header) throw new NotFoundException(`セット登録が見つかりません（ID: ${id}）`);
      await trx.deleteFrom('set_components').where('set_header_id', '=', id).execute();
      await this.writeSetComponents(trx, id, body.components, user.id);
      return { ...header, components: body.components.length };
    });
  }

  private async writeSetComponents(
    trx: ConyDatabase,
    headerId: number,
    components: SetBody['components'],
    userId: number,
  ): Promise<void> {
    // 構成品にセット商品（自分自身・別のセット）は入れられない。セットは在庫を持たないので、
    // そのセットを受注すると構成品の在庫が引けず、「実在庫 0」で登録できなくなっていた（3回目の全面テスト）
    const setParts = await trx
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .select('s.sku_code as sku_code')
      .where('s.id', 'in', components.map((c) => c.component_sku_id))
      .where('p.is_set', '=', true)
      .execute();
    if (setParts.length > 0) {
      throw new BadRequestException(
        `構成品にセット商品は選べません（${setParts.map((r) => r.sku_code).join('、')}）。単品の SKU を選んでください`,
      );
    }
    await trx
      .insertInto('set_components')
      .values(
        components.map((c, i) => ({
          set_header_id: headerId,
          component_sku_id: c.component_sku_id,
          qty: c.qty,
          sort_order: c.sort_order ?? i + 1,
          created_by: userId,
        })),
      )
      .execute();
  }

  @Get('sets')
  @RequirePermission('M-10', 'view')
  async listSets(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    let base = this.db
      .selectFrom('set_headers as h')
      .innerJoin('skus as s', 's.id', 'h.sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      // 一覧にカラー・サイズ・商品分類を出すため（1001 のご指摘）。
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .leftJoin('product_classes as pc', 'pc.id', 'p.product_class_id');
    // 「使わないものも表示」を外しているときは、非表示にしたセットを出さない（M3-02。ほかのマスタと同じ）
    if (!query.include_inactive) base = base.where('h.is_active', '=', true);
    // 一覧の検索欄（キーワードで一覧を絞る。1001 のご指摘。以前は検索語を受け取っても使っていなかった）
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('s.sku_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
          eb('s.sku_name', 'ilike', like),
          eb('p.product_code', 'ilike', like),
          eb('cl.name', 'ilike', like),
          eb('sz.name', 'ilike', like),
          eb('pc.name', 'ilike', like),
        ]),
      );
    }
    const counted = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
    const items = await base
      .select([
        'h.id as id',
        'h.sku_id as sku_id',
        's.sku_code as sku_code',
        // SKU の商品名があればそれ（2026-10-09 マスター編②）
        skuNameExpr('s', 'p').as('product_name'),
        // 一覧の商品名は「商品名　カラー　サイズ」（例 骨盤ショーツ07　2枚組　ブラック　S。2026-10-09 マスター編②）。
        // 同じ商品のセットが色・サイズ違いで並ぶため、商品名だけでは見分けられなかった
        sql<string>`concat_ws('　', ${skuNameExpr('s', 'p')}, cl.name, sz.name)`.as('display_name'),
        'cl.name as color_name',
        'sz.name as size_name',
        'pc.name as product_class_name',
        'h.is_active as is_active',
        (eb) =>
          eb
            .selectFrom('set_components as c')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('c.set_header_id', '=', 'h.id')
            .as('component_count'),
      ])
      .orderBy('s.sku_code', 'asc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();
    // 件数は絞り込み後の全件数（ページ送りのため。以前は1ページ分の件数を返していて51件目以降に進めなかった）
    return { items, total: counted?.n ?? 0, limit: query.limit, offset: query.offset };
  }

  @Get('sets/:id')
  @RequirePermission('M-10', 'view')
  async findSet(@Param('id', ParseIntPipe) id: number) {
    const header = await this.crud.findOne('set_headers', id, 'セット登録');
    // 編集で開いたとき、セット SKU の欄にも「SKU　商品名 カラー サイズ」を出すため（2026-10-09 マスター編②）
    const setSku = await this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .select(['s.sku_code as sku_code', skuNameExpr('s', 'p').as('product_name'), 'cl.name as color_name', 'sz.name as size_name'])
      .where('s.id', '=', Number(header.sku_id))
      .executeTakeFirst();
    const components = await this.db
      .selectFrom('set_components as c')
      .innerJoin('skus as s', 's.id', 'c.component_sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      // 編集で開いたときも構成品のカラー・サイズを出すため（1001 のご指摘）
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .select([
        'c.id as id',
        'c.component_sku_id as component_sku_id',
        's.sku_code as sku_code',
        skuNameExpr('s', 'p').as('product_name'),
        'cl.name as color_name',
        'sz.name as size_name',
        'c.qty as qty',
      ])
      .where('c.set_header_id', '=', id)
      .orderBy('c.sort_order', sql`asc nulls last`)
      .execute();
    return {
      ...header,
      sku_code: setSku?.sku_code ?? null,
      product_name: setSku?.product_name ?? null,
      color_name: setSku?.color_name ?? null,
      size_name: setSku?.size_name ?? null,
      components,
    };
  }

  // ---- 得意先別商品 ---------------------------------------------------------
  /** 得意先別商品の一覧。取引先・SKU で絞れ、名称も一緒に返す（画面で ID だけ見せない）。 */
  @Get('partner-products')
  @RequirePermission('M-11', 'view')
  async listPartnerProducts(
    @Query(new ZodValidationPipe(PartnerProductListSchema)) query: PartnerProductListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 原価は「機微項目の参照」がある人にだけ返す（閲覧者には出さない。商品マスタの stripCost と同じ扱い）
    const showCost = await this.auth.canSeeSensitive(user.id);
    let base = this.db
      .selectFrom('partner_products as pp')
      .innerJoin('partners as p', 'p.id', 'pp.partner_id')
      .innerJoin('skus as s', 's.id', 'pp.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      // 一覧にカラー・サイズ・商品分類を出すため（1001 のご指摘）。
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .leftJoin('product_classes as pc', 'pc.id', 'pr.product_class_id')
      // 取引先マスタの媒体（販売先カテゴリーに代えて一覧に出し、絞り込みにも使う。2026-10-16 マスター編_3 M3-08）
      .leftJoin('media as md', 'md.id', 'p.media_id');
    if (!query.include_inactive) base = base.where('pp.is_active', '=', true);
    if (query.partner_id !== undefined) base = base.where('pp.partner_id', '=', query.partner_id);
    if (query.sku_id !== undefined) base = base.where('pp.sku_id', '=', query.sku_id);
    if (query.media_id !== undefined) base = base.where('p.media_id', '=', query.media_id);
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('pp.partner_product_code', 'ilike', like),
          eb('pp.sales_name', 'ilike', like),
          eb('pp.partner_jan', 'ilike', like),
          eb('s.sku_code', 'ilike', like),
          eb('p.partner_code', 'ilike', like),
          eb('p.name1', 'ilike', like),
          eb('p.short_name', 'ilike', like),
        ]),
      );
    }
    const [items, total] = await Promise.all([
      base
        .selectAll('pp')
        .select([
          'p.partner_code as partner_code',
          'p.name1 as partner_name',
          // 一覧は取引先をコードと略称の2列で出す（2026-10-16 マスター編_3 M3-25「略称がいい」）
          'p.short_name as partner_short_name',
          'md.name as media_name',
          // 取引先の通貨。単価・上代はこの通貨の金額なので、外貨は小数2桁で見せる（2026-10-13 再テスト）
          'p.currency as partner_currency',
          's.sku_code as sku_code',
          // SKU の商品名があればそれ（2026-10-09 マスター編②。編集画面の自社SKUの全文表示にも使う）
          skuNameExpr('s', 'pr').as('product_name'),
          'cl.name as color_name',
          'sz.name as size_name',
          // 得意先別商品が持つ「印字するカラー／サイズ」。上の2つ（SKU マスタの名前）と同じ名前で返すと
          // 上書きされ、編集画面に SKU の名前が入って、保存のたびに印字の値が書き換わっていた
          'pp.color_name as print_color_name',
          'pp.size_name as print_size_name',
          'pc.name as product_class_name',
        ])
        .orderBy('p.partner_code')
        .orderBy('s.sku_code')
        // 同じ取引先・SKU の行が複数あるとき（M3-26）は表示順 → 登録順
        .orderBy(sql`pp.sort_order nulls last`)
        .orderBy('pp.id')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);
    const shown = showCost ? items : items.map(({ cost_price: _cost, ...rest }) => rest);
    return { items: shown, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 受注入力で使う。取引先×SKU の得意先別商品（専用コード・卸単価・上代）を、使っている行すべて返す（無ければ空）。
   * 同じ SKU に先方コード・単価の違う行が複数あるときは、受注入力でどれかを選ぶ（2026-10-16 マスター編_3 M3-26）。
   * 並びは表示順 → 登録順。受注入力の権限だけで呼べるようにしてある。
   */
  @Get('partner-products/lookup')
  @RequirePermission('O-01', 'view')
  lookupPartnerProduct(@Query(new ZodValidationPipe(PartnerProductLookupSchema)) query: PartnerProductLookupQuery) {
    return (
      this.db
        .selectFrom('partner_products')
        // 先方JAN・出荷JANも返す。受注入力で「先方のJANを入れたら出荷用のJANを出す」ため（1001 ご要望）。
        // 販売名・備考は、複数の行から選ぶときの見分けに使う
        .select(['id', 'partner_product_code', 'partner_jan', 'shipping_jan', 'sales_name', 'unit_price', 'retail_price', 'note'])
        .where('partner_id', '=', query.partner_id)
        .where('sku_id', '=', query.sku_id)
        .where('is_active', '=', true)
        .orderBy(sql`sort_order nulls last`)
        .orderBy('id')
        .execute()
    );
  }

  /**
   * 同じ取引先・同じ SKU で、先方の商品コードが無い行は1つまで（2026-10-16 マスター編_3 M3-26）。
   * CSV・一覧で編集は「取引先＋SKU＋先方の商品コード」で行を見分けるため、コードの無い行が2つあると見分けられない。
   * 2行目からは先方の商品コードを入れてもらう。
   */
  private async assertOneUncodedPartnerProduct(partnerId: number, skuId: number, code: string | null | undefined, exceptId?: number) {
    if (code) return;
    let q = this.db
      .selectFrom('partner_products')
      .select('id')
      .where('partner_id', '=', partnerId)
      .where('sku_id', '=', skuId)
      .where(sql<boolean>`nullif(btrim(partner_product_code), '') is null`);
    if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
    if (await q.executeTakeFirst()) {
      throw new ConflictException(
        '同じ取引先・同じ SKU で、先方の商品コードが空の行がすでにあります。2行目からは先方の商品コードを入れてください（行を見分けるため）',
      );
    }
  }

  @Post('partner-products')
  @RequirePermission('M-11', 'create')
  async createPartnerProduct(
    @Body(new ZodValidationPipe(PartnerProductSchema)) body: PartnerProductBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.assertOneUncodedPartnerProduct(body.partner_id, body.sku_id, body.partner_product_code);
    return this.crud.create('partner_products', body, user.id);
  }

  @Patch('partner-products/:id')
  @RequirePermission('M-11', 'update')
  async updatePartnerProduct(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PartnerProductSchema.partial().extend(Active))) body: Partial<PartnerProductBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 取引先・SKU・先方の商品コードのどれかを変えるときだけ見る（無い行は下の update が 404 にする）
    if (body.partner_id !== undefined || body.sku_id !== undefined || body.partner_product_code !== undefined) {
      const cur = await this.db
        .selectFrom('partner_products')
        .select(['partner_id', 'sku_id', 'partner_product_code'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (cur) {
        await this.assertOneUncodedPartnerProduct(
          body.partner_id ?? Number(cur.partner_id),
          body.sku_id ?? Number(cur.sku_id),
          body.partner_product_code !== undefined ? body.partner_product_code : cur.partner_product_code,
          id,
        );
      }
    }
    return this.crud.update('partner_products', id, body, '得意先別商品', user.id);
  }

  @Post('partner-products/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-11', 'delete')
  deactivatePartnerProduct(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('partner_products', id, false, '得意先別商品', user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('partner-products/:id')
  @RequirePermission('M-11', 'delete')
  removePartnerProduct(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('partner_products', id, '得意先別商品');
  }

  // ---- 倉庫 -----------------------------------------------------------------
  @Post('warehouses')
  @RequirePermission('M-14', 'create')
  createWarehouse(
    @Body(new ZodValidationPipe(WarehouseSchema)) body: WarehouseBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.create('warehouses', body, user.id);
  }

  @Patch('warehouses/:id')
  @RequirePermission('M-14', 'update')
  updateWarehouse(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(WarehouseSchema.partial().extend(Active))) body: Partial<WarehouseBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('warehouses', id, body, '倉庫', user.id);
  }

  @Post('warehouses/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-14', 'delete')
  deactivateWarehouse(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('warehouses', id, false, '倉庫', user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('warehouses/:id')
  // 倉庫マスタの機能IDは M-14（以前は存在しない M-13 を指していて、管理者でも削除できなかった）
  @RequirePermission('M-14', 'delete')
  removeWarehouse(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('warehouses', id, '倉庫');
  }

  // ---- 仕入マスタ -----------------------------------------------------------
  @Get('purchase-items')
  @RequirePermission('M-15', 'view')
  async listPurchaseItems(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    const page = await this.crud.list('purchase_items', {
      ...query,
      searchColumns: ['purchase_code', 'item_name'],
      orderBy: ['sort_order', 'purchase_code'],
    });
    // 一覧にブランド・商品分類・カテゴリーの名前も出す（2026-10-18 マスター編_3 M3-30）。
    // 画面の選択肢（200件まで）から引くと、件数の多い商品分類で名前が欠けるため、ここで引いて添える
    const ids = (field: string) =>
      [...new Set(page.items.map((r) => r[field]).filter((v) => v !== null && v !== undefined).map(Number))];
    const names = async (table: 'brands' | 'categories' | 'product_classes', field: string) => {
      const list = ids(field);
      if (list.length === 0) return new Map<number, { code: string; name: string }>();
      const rows = await this.db.selectFrom(table).select(['id', 'code', 'name']).where('id', 'in', list).execute();
      return new Map(rows.map((r) => [Number(r.id), { code: r.code, name: r.name }]));
    };
    const [brands, categories, classes] = await Promise.all([
      names('brands', 'brand_id'),
      names('categories', 'category_id'),
      names('product_classes', 'product_class_id'),
    ]);
    return {
      ...page,
      items: page.items.map((r) => ({
        ...r,
        brand_name: brands.get(Number(r.brand_id))?.name ?? null,
        category_name: categories.get(Number(r.category_id))?.name ?? null,
        product_class_code: classes.get(Number(r.product_class_id))?.code ?? null,
        product_class_name: classes.get(Number(r.product_class_id))?.name ?? null,
      })),
    };
  }

  @Post('purchase-items')
  @RequirePermission('M-15', 'create')
  async createPurchaseItem(
    @Body(new ZodValidationPipe(PurchaseItemSchema)) body: PurchaseItemBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 税率は税区分から決まる。食い違い（税率 10%・非課税など）は断る（T3 No.32）
    return this.crud.create('purchase_items', await assertPurchaseItemTax(this.db, body), user.id);
  }

  @Patch('purchase-items/:id')
  @RequirePermission('M-15', 'update')
  async updatePurchaseItem(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PurchaseItemSchema.partial().extend(Active))) body: Partial<PurchaseItemBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const current = await this.db
      .selectFrom('purchase_items')
      .select(['new_tax_rate', 'new_tax_class_code_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException(`仕入品目が見つかりません（ID: ${id}）`);
    return this.crud.update('purchase_items', id, await assertPurchaseItemTax(this.db, body, current), '仕入品目', user.id);
  }

  @Post('purchase-items/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-15', 'delete')
  deactivatePurchaseItem(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.crud.setActive('purchase_items', id, false, '仕入品目', user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   */
  @Delete('purchase-items/:id')
  @RequirePermission('M-15', 'delete')
  removePurchaseItem(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('purchase_items', id, '仕入項目');
  }

  // ---- 汎用区分 -------------------------------------------------------------
  /** 区分値の追加。カテゴリーはコードで指定する（例 ADJUSTMENT_REASON）。 */
  @Post('codes')
  @RequirePermission('M-16', 'create')
  async createCode(
    @Body(new ZodValidationPipe(CodeSchema)) body: CodeBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const category = await this.db
      .selectFrom('code_categories')
      .select('id')
      .where('code', '=', body.code_category_code)
      .executeTakeFirst();

    if (!category) {
      throw new BadRequestException(`区分カテゴリー「${body.code_category_code}」が登録されていません`);
    }
    // 通貨は伝票（仕入・入出金）にコードのまま3文字で保存する（currency VARCHAR(3)）。
    // 4文字以上のコードを足せてしまうと、その通貨を選んだ伝票が保存できなくなる（M-23 で画面から足せるようにしたため）。
    if (body.code_category_code === 'CURRENCY' && !/^[A-Z]{3}$/.test(body.code)) {
      throw new BadRequestException('通貨のコードは英大文字3文字で入力してください（例 USD・CNY）');
    }

    return this.crud.create(
      'codes',
      {
        code_category_id: category.id,
        code: body.code,
        name: body.name,
        sort_order: body.sort_order,
        note: body.note,
      },
      user.id,
    );
  }

  /**
   * 区分値の変更。is_active=false で「使わない」（2026-10-09 マスター編② M-23「通貨・経費科目」タブ）。
   * 伝票が区分値を参照しているので消さずに無効にする。無効の値は選択肢（GET codes/:categoryCode）から外れる。
   */
  @Patch('codes/:id')
  @RequirePermission('M-16', 'update')
  updateCode(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CodeSchema.partial().omit({ code_category_code: true }).extend(Active)))
    body: Partial<Omit<CodeBody, 'code_category_code'>> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.crud.update('codes', id, body, '区分値', user.id);
  }

  /**
   * 区分値の削除（2026-10-16 マスター編3 M3-39。区分値・通貨・経費科目のタブにも削除を付けた）。
   * 使われているものは理由（どこで何件）を出して断り、編集画面の「非表示」に誘導する。
   *  - プログラムがコードで引いている値（PROTECTED_CODES）は、使われていなくても消さない。
   *  - 通貨は伝票・取引先にコードの文字のまま持つ（外部キーが無い）ので、currency の列を数えて断る。
   */
  @Delete('codes/:id')
  @RequirePermission('M-16', 'delete')
  async removeCode(@Param('id', ParseIntPipe) id: number) {
    const row = await this.db
      .selectFrom('codes as c')
      .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
      .select(['c.code as code', 'c.name as name', 'cc.code as category', 'cc.name as category_name'])
      .where('c.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`区分値が見つかりません（ID: ${id}）`);

    const keep = PROTECTED_CODES[row.category];
    if (keep === '*' || keep?.includes(row.code)) {
      throw new ConflictException(
        `「${row.name}」（${row.code}）はシステムの処理で使う${row.category_name}のため削除できません。` +
          `選択肢から外したいときは、編集画面で「非表示」にしてください`,
      );
    }
    if (row.category === 'CURRENCY') {
      const where = await this.currencyUsages(row.code);
      if (where) {
        throw new ConflictException(
          `この通貨（${row.code}）は次で使われているため削除できません：${where}。` +
            `選択肢から外したいときは、編集画面で「非表示」にしてください`,
        );
      }
    }
    return this.crud.remove('codes', id, '区分値');
  }

  /** 通貨のコードを文字のまま持つ列（currency）を、表ごとに数える（「取引先 2件、仕入 1件」の形） */
  private async currencyUsages(code: string): Promise<string> {
    const cols = await sql<{ table_name: string }>`
      select c.table_name
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = current_schema()
         and c.column_name = 'currency'
         and t.table_type = 'BASE TABLE'
       order by c.table_name`.execute(this.db);
    const labels: Record<string, string> = {
      partners: '取引先',
      sales_orders: '受注',
      purchases: '仕入',
      invoices: '請求書',
      cash_receipts: '入金',
      cash_payments: '支払',
      cash_transactions: '入出金',
      ap_ledgers: '買掛',
      ar_ledgers: '売掛',
    };
    const out: string[] = [];
    for (const { table_name } of cols.rows) {
      // 表の名前はデータベースの定義から取ったもの。通貨のコードは値としてのみ渡る
      const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table_name)} where currency = ${code}`.execute(this.db);
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) out.push(`${labels[table_name] ?? table_name} ${n}件`);
    }
    return out.join('、');
  }

  /**
   * 区分値の管理用の一覧。「使わない」にした値も is_active を付けて返す。
   * 選択肢用の GET codes/:categoryCode（lookups.controller.ts）は有効な値だけを返すので、
   * そのままでは一度「使わない」にした値を画面から戻せなくなるため（M-23）。
   */
  @Get('codes/:categoryCode/all')
  @RequirePermission('M-16', 'view')
  async listAllCodes(@Param('categoryCode') categoryCode: string) {
    const category = await this.db
      .selectFrom('code_categories')
      .select(['id', 'code', 'name'])
      .where('code', '=', categoryCode)
      .executeTakeFirst();
    if (!category) throw new NotFoundException(`区分カテゴリーが見つかりません（${categoryCode}）`);

    const values = await this.db
      .selectFrom('codes')
      .select(['id', 'code', 'name', 'sort_order', 'note', 'is_active'])
      .where('code_category_id', '=', category.id)
      .orderBy('is_active', 'desc')
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('code', 'asc')
      .execute();
    return { category, values };
  }

  /** システム設定の変更。端数処理や送料の条件をプログラムなしで切り替える。 */
  @Patch('settings/:key')
  @RequirePermission('M-16', 'update')
  async updateSetting(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(z.object({ value_text: z.string().nullable() })))
    body: { value_text: string | null },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const setting = await this.db
      .selectFrom('system_settings')
      .select(['setting_key', 'is_user_editable'])
      .where('setting_key', '=', key)
      .executeTakeFirst();

    if (!setting) throw new NotFoundException(`設定「${key}」はありません`);
    if (!setting.is_user_editable) throw new ForbiddenException(`設定「${key}」は画面から変更できません`);

    const row = await this.db
      .updateTable('system_settings')
      .set({ value_text: body.value_text, updated_by: user.id, updated_at: new Date() })
      .where('setting_key', '=', key)
      .returning(['setting_key', 'name', 'value_text', 'value_type'])
      .executeTakeFirstOrThrow();
    // 設定は短時間覚えているので、変えたその場で捨てて即座に効かせる。
    this.settings.invalidate();
    return row;
  }

  // ---- ロイヤリティ規定 -----------------------------------------------------
  /**
   * ロイヤリティ規定。支払先 × ブランド（または商品） × 販売先 × 期間で決める。
   * ブランド・商品・販売先を空欄にすると「すべて」になる。
   * 料率を変えるときは、既存の行を書き換えず新しい適用開始日で行を足す。
   */
  /**
   * 一覧。1枚のフォームから作った行のまとまりを **1件** として返す。
   *
   * 「媒体テレビ・5%・20社のうち2社だけ対象外」は中では3行だが、画面には1件に見せる。
   * まとまりの鍵は COALESCE(rule_group_id, id)。昔から入っている1行だけの規定も
   * rule_group_id が空欄なので「自分1行だけのまとまり」として同じ扱いになる。
   *
   * 編集で外れた「編集前の版」の行（royalty-rule-history.ts）は、まとまりの1件に数えず、
   * 別の規定としても出さない（件数だけ history_count で返す）。
   * 「使わないものも表示」が外れているとき（include_inactive なし）は、使わないにした規定を出さない。
   */
  @Get('royalty-rules')
  @RequirePermission('Y-02', 'view')
  async listRoyaltyRules(@Query(new ZodValidationPipe(ListSchema)) query: ListQuery) {
    const gid = sql<number>`coalesce(r.rule_group_id, r.id)`;
    const shownRow = query.include_inactive
      ? sql<boolean>`not ${IS_ROYALTY_HISTORY}`
      : sql<boolean>`r.is_active and not ${IS_ROYALTY_HISTORY}`;

    // 件数の区切り（limit/offset）は「まとまり」に掛ける。行に掛けると、まとまりが
    // 途中で切れて販売先が欠けたまま表示されてしまう。
    const groups = await this.db
      .selectFrom('royalty_rules as r')
      .innerJoin('partners as payee', 'payee.id', 'r.payee_partner_id')
      .select([
        gid.as('gid'),
        sql<string>`min(payee.name1)`.as('payee_sort'),
        sql<string>`max(r.valid_from)`.as('valid_sort'),
      ])
      .where(shownRow)
      .groupBy(gid)
      .orderBy('payee_sort', 'asc')
      .orderBy('valid_sort', 'desc')
      .orderBy('gid', 'asc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();

    const counted = await this.db
      .selectFrom('royalty_rules as r')
      .select(sql<number>`count(distinct coalesce(r.rule_group_id, r.id))`.as('n'))
      .where(shownRow)
      .executeTakeFirst();
    const total = Number(counted?.n ?? 0);
    if (groups.length === 0) return { items: [], total, limit: query.limit, offset: query.offset };

    const rows = await this.db
      .selectFrom('royalty_rules as r')
      .innerJoin('partners as payee', 'payee.id', 'r.payee_partner_id')
      .leftJoin('brands as b', 'b.id', 'r.brand_id')
      .leftJoin('products as p', 'p.id', 'r.product_id')
      .leftJoin('partners as cust', 'cust.id', 'r.customer_partner_id')
      .leftJoin('media as md', 'md.id', 'r.media_id')
      .select([
        'r.id as id',
        gid.as('gid'),
        'r.rule_group_id as rule_group_id',
        'r.payee_partner_id as payee_partner_id',
        'payee.name1 as payee_name',
        'r.brand_id as brand_id',
        'b.name as brand_name',
        'r.product_id as product_id',
        'p.product_name as product_name',
        'p.product_code as product_code',
        'r.customer_partner_id as customer_partner_id',
        'cust.name1 as customer_name',
        'r.media_id as media_id',
        'md.name as media_name',
        'r.note as note',
        'r.is_excluded as is_excluded',
        'r.calc_base as calc_base',
        'r.rate as rate',
        'r.fixed_amount as fixed_amount',
        'r.valid_from as valid_from',
        'r.valid_to as valid_to',
        'r.scope_priority as scope_priority',
        'r.is_active as is_active',
        IS_ROYALTY_HISTORY.as('is_history'),
      ])
      .where(
        gid,
        'in',
        groups.map((g) => Number(g.gid)),
      )
      // 代表行（料率を持つ行）を先に、対象外の行を後に並べる
      .orderBy('r.is_excluded', 'asc')
      .orderBy('r.id', 'asc')
      .execute();

    const byGroup = new Map<number, typeof rows>();
    for (const row of rows) {
      const key = Number(row.gid);
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(row);
      else byGroup.set(key, [row]);
    }

    const items = groups
      .map((g) => {
        const all = byGroup.get(Number(g.gid)) ?? [];
        // 編集前の版はまとまりの中身に入れない
        const bucket = all.filter((r) => !r.is_history);
        // 代表行＝まとまりを指していない行
        const head = bucket.find((r) => r.rule_group_id === null) ?? bucket[0];
        if (!head) return null;
        // 販売先の指定・対象の商品・対象外の商品は、行のまとまりから読む（royalty-rule-group.ts）
        const spec = readRuleGroup(bucket);
        const customerName = new Map(bucket.map((r) => [Number(r.customer_partner_id), r.customer_name ?? '']));
        const product = new Map(bucket.map((r) => [Number(r.product_id), { name: r.product_name ?? '', code: r.product_code ?? '' }]));
        const productsOf = (ids: number[]) => ids.map((id) => ({ id, ...(product.get(id) ?? { name: '', code: '' }) }));
        const { gid: _gid, is_history: _history, product_code: _code, ...rest } = head;
        return {
          ...rest,
          customer_mode: spec.mode,
          // 画面に出す販売先。対象外のときは「外した社」、対象のときは「対象の社」
          customers: spec.customerIds.map((id) => ({ id, name: customerName.get(id) ?? '' })),
          customer_count: spec.customerIds.length,
          /** 対象の商品（空ならブランド配下のすべて）と対象外の商品（M3-33） */
          products: productsOf(spec.productIds),
          excluded_products: productsOf(spec.excludedProductIds),
          /** このまとまりが中では何行か */
          row_count: bucket.length,
          /** 編集前の版として残している行の数（計算済みの月の根拠） */
          history_count: all.length - bucket.length,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items, total, limit: query.limit, offset: query.offset };
  }

  /**
   * 登録。販売先・商品を複数選んだときは、1枚のフォームから複数行を作って1つのまとまりにする。
   * 行の作り方は royalty-rule-group.ts（planRuleGroupRows）。
   *
   *   対象   … 選んだ販売先ぶんの行を作る（それぞれ料率を持つ）
   *   対象外 … 「販売先=すべて・料率あり」の代表行＋「選んだ販売先・対象外」の行。
   *            計算のときは指定の細かい行が勝つので、選んだ社だけが外れる。
   *            料率を入れなければ対象外の行だけを作る（料率は別の規定が受け持つ）。
   *   対象の商品   … 選んだ商品ごとに料率の行を作る（M3-33。1件ずつ登録しなくてよい）
   *   対象外の商品 … 選んだ商品の対象外の行を、料率の行より優先される形で作る（M3-33）
   */
  @Post('royalty-rules')
  @RequirePermission('Y-02', 'create')
  async createRoyaltyRule(
    @Body(new ZodValidationPipe(RoyaltyRuleSchema)) body: RoyaltyRuleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { customer_mode, customer_partner_ids, product_ids, excluded_product_ids, ...values } = body;
    // 規定の媒体の販売先だけを選べる（他の媒体の販売先だと、計算では黙って 0 円になるため）
    await assertCustomersInMedia(
      this.db,
      values.media_id ?? null,
      customer_partner_ids.length > 0 ? customer_partner_ids : values.customer_partner_id ? [values.customer_partner_id] : [],
    );
    const productIds = product_ids ?? (values.product_id ? [values.product_id] : []);
    const excludedProductIds = excluded_product_ids ?? [];
    // 販売先も商品も複数選んでいないときは、今までどおり1行だけ作る（昔の API の使い方もこのまま）。
    if (customer_partner_ids.length === 0 && productIds.length <= 1 && excludedProductIds.length === 0) {
      await this.assertRuleProductsInBrand(values.brand_id ?? null, productIds);
      return this.crud.create('royalty_rules', { ...values, product_id: productIds[0] ?? null }, user.id);
    }
    const spec: RuleGroupSpec = { mode: customer_mode, customerIds: customer_partner_ids, productIds, excludedProductIds };
    await this.assertRuleGroup(spec, values);
    return this.db.transaction().execute((trx) => this.writeRoyaltyGroup(trx, null, spec, values, user.id));
  }

  /**
   * 更新。:id はまとまりの代表行。
   * 販売先の指定・対象の商品・対象外の商品が送られてきたときは、このまとまりの行を作り直す。
   * 送られてこなかったものは今のまま。
   */
  @Patch('royalty-rules/:id')
  @RequirePermission('Y-02', 'update')
  async updateRoyaltyRule(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(RoyaltyRuleBase.partial().extend(Active)))
    body: Partial<RoyaltyRuleBody> & { is_active?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { customer_mode, customer_partner_ids, product_ids, excluded_product_ids, ...values } = body;

    const row = await this.db.selectFrom('royalty_rules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException(`ロイヤリティ規定が見つかりません（ID: ${id}）`);
    if (row.rule_group_id !== null) {
      throw new BadRequestException('このまとまりの代表の行を開いてから直してください');
    }

    // 「使わない」「有効に戻す」だけのときは、まとまり全体の行をそろえて切り替える。
    // 代表の1行だけを切り替えると、2社目以降の行が計算に効き続けていた。
    const onlyActive =
      Object.keys(values).every((k) => k === 'is_active') &&
      customer_mode === undefined &&
      customer_partner_ids === undefined &&
      product_ids === undefined &&
      excluded_product_ids === undefined;
    if (onlyActive && values.is_active !== undefined) {
      return this.setRoyaltyGroupActive(id, values.is_active, user.id);
    }

    // 送られてこなかった指定は、今の指定のまま中身だけを直す（まとまりの全行にそろえて反映する）
    const current = await this.royaltyGroupSpec(this.db, id);
    const spec: RuleGroupSpec = {
      mode: customer_mode ?? current.mode,
      customerIds: customer_partner_ids ?? (customer_mode === undefined ? current.customerIds : []),
      productIds:
        product_ids ?? (values.product_id !== undefined ? (values.product_id ? [values.product_id] : []) : current.productIds),
      excludedProductIds: excluded_product_ids ?? current.excludedProductIds,
    };

    const merged = { ...row, ...values };
    await this.assertRuleGroup(spec, merged);

    return this.db.transaction().execute(async (trx) => {
      const result = await this.writeRoyaltyGroup(trx, id, spec, merged, user.id);
      if (values.is_active !== undefined) await this.setRoyaltyGroupActive(result.id, values.is_active, user.id, trx);
      return result;
    });
  }

  /** まとまりの中身の検査（登録・更新で共通） */
  private async assertRuleGroup(spec: RuleGroupSpec, values: Record<string, unknown>) {
    if (values.media_id == null) throw new BadRequestException('媒体を選んでください');
    const message = checkRuleGroup(spec, Boolean(values.rate || values.fixed_amount), {
      customers: MAX_RULE_CUSTOMERS,
      products: MAX_RULE_PRODUCTS,
    });
    if (message) throw new BadRequestException(message);
    await assertCustomersInMedia(this.db, Number(values.media_id), spec.customerIds);
    await this.assertRuleProductsInBrand((values.brand_id ?? null) as number | null, [
      ...spec.productIds,
      ...spec.excludedProductIds,
    ]);
  }

  /**
   * ブランドを選んだ規定の商品は、そのブランドの商品に限る。
   * 違うブランドの商品は計算でどの明細にも当たらず、対象外にしたつもりでも効かないため（M3-33）。
   */
  private async assertRuleProductsInBrand(brandId: number | null, productIds: number[]) {
    if (productIds.length === 0) return;
    const rows = await this.db
      .selectFrom('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .select(['p.id as id', 'p.product_name as product_name', 'p.brand_id as brand_id'])
      .where('p.id', 'in', productIds)
      .execute();
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const id of productIds) {
      const p = byId.get(id);
      if (!p) throw new BadRequestException(`商品が見つかりません（ID: ${id}）`);
      if (brandId !== null && Number(p.brand_id) !== Number(brandId)) {
        const brand = await this.db.selectFrom('brands').select('name').where('id', '=', brandId).executeTakeFirst();
        throw new BadRequestException(
          `${p.product_name} はブランド『${brand?.name ?? brandId}』の商品ではありません。ブランドを空欄にするか、そのブランドの商品を選んでください`,
        );
      }
    }
  }

  /** まとまりの今の販売先の指定・対象の商品・対象外の商品（一覧と同じ読み方） */
  private async royaltyGroupSpec(db: ConyDatabase, headId: number): Promise<RuleGroupSpec> {
    const rows = await db
      .selectFrom('royalty_rules as r')
      .select(['r.customer_partner_id as customer_partner_id', 'r.product_id as product_id', 'r.is_excluded as is_excluded'])
      .where((eb) => eb.or([eb('r.id', '=', headId), eb('r.rule_group_id', '=', headId)]))
      .where(sql<boolean>`not ${IS_ROYALTY_HISTORY}`)
      .orderBy('r.id', 'asc')
      .execute();
    return readRuleGroup(rows);
  }

  /** まとまり（代表行と配下の行）をそろえて有効／無効にする。編集前の版は「使わない」のまま触らない */
  private async setRoyaltyGroupActive(headId: number, isActive: boolean, userId: number, trx?: ConyDatabase) {
    const db = trx ?? this.db;
    const rows = await db
      .updateTable('royalty_rules as r')
      .set({ is_active: isActive, updated_by: userId, updated_at: new Date() })
      .where((eb) => eb.or([eb('r.id', '=', headId), eb('r.rule_group_id', '=', headId)]))
      .where(sql<boolean>`not ${IS_ROYALTY_HISTORY}`)
      .returning('r.id')
      .execute();
    if (rows.length === 0) throw new NotFoundException(`ロイヤリティ規定が見つかりません（ID: ${headId}）`);
    return { id: headId, is_active: isActive, rows: rows.length };
  }

  /**
   * まとまりを書き込む。headId が null なら新しく作り、あれば今の行を直す。
   * 料率は料率の行だけが持つ。対象外の行は料率を持てない（DB の制約 ck_royalty_excl）。
   *
   * 直すときは行を消して作り直さず、（販売先, 商品）ごとに今の行をそのまま直す。
   * 月次計算の明細（royalty_calculation_lines）は「どの規定を当てたか」を行の ID で持つため、
   * 消して作り直すと、一度計算に使った規定は直せなくなっていた（外部キーで消せない）。
   * 外した販売先・商品の行は、計算に使っていなければ消し、使っていれば「編集前の版」として
   * まとまりにぶら下げたまま「使わない」にする（過去の計算の根拠は残る。royalty-rule-history.ts）。
   * 以前はまとまりから切り離していたため、利用者の作っていない「無効」の規定が一覧に増え、
   * 「有効に戻す」で元の料率が復活していた（2026-10-12 T3 No.37 D3）。
   */
  private async writeRoyaltyGroup(
    trx: ConyDatabase,
    headId: number | null,
    spec: RuleGroupSpec,
    values: Record<string, unknown>,
    userId: number,
  ) {
    const rate = (values.rate ?? null) as string | null;
    const fixed = (values.fixed_amount ?? null) as string | null;
    const shared = {
      payee_partner_id: values.payee_partner_id as number,
      brand_id: (values.brand_id ?? null) as number | null,
      media_id: (values.media_id ?? null) as number | null,
      calc_base: (values.calc_base ?? '売上') as string,
      valid_from: values.valid_from as string,
      valid_to: (values.valid_to ?? null) as string | null,
      sort_order: (values.sort_order ?? null) as number | null,
      note: (values.note ?? null) as string | null,
    };
    // 直すときは、今の「使う／使わない」を引き継ぐ（使わないにした規定を直しても、勝手に使うに戻さない）
    const isActive = values.is_active === undefined ? true : Boolean(values.is_active);

    // 作りたい行の並び。先頭がまとまりの代表になる（royalty-rule-group.ts）
    const wants = planRuleGroupRows(spec, Boolean(rate || fixed));
    const keyOf = (customer: unknown, product: unknown) =>
      `${customer === null ? 0 : Number(customer)}:${product === null ? 0 : Number(product)}`;

    const existing = headId
      ? await trx
          .selectFrom('royalty_rules as r')
          .select(['r.id as id', 'r.customer_partner_id as customer_partner_id', 'r.product_id as product_id'])
          .where((eb) => eb.or([eb('r.id', '=', headId), eb('r.rule_group_id', '=', headId)]))
          .where(sql<boolean>`not ${IS_ROYALTY_HISTORY}`)
          .orderBy('r.id', 'asc')
          .execute()
      : [];
    const byKey = new Map(existing.map((r) => [keyOf(r.customer_partner_id, r.product_id), Number(r.id)]));

    const keptIds: number[] = [];
    for (const w of wants) {
      const body = {
        ...shared,
        customer_partner_id: w.customer,
        product_id: w.product,
        is_excluded: w.excluded,
        // 対象外の行は料率を持たない。料率の行より優先されて、この販売先・商品だけ外れる。
        rate: w.excluded ? null : rate,
        fixed_amount: w.excluded ? null : fixed,
        is_active: isActive,
        rule_group_id: null as number | null,
        // 使い直す行が編集前の版だったときは、印を外して今の規定に戻す
        superseded_at: null as Date | null,
      };
      let rowId = byKey.get(keyOf(w.customer, w.product));
      if (rowId === undefined) {
        // 前に外して「使わない」で残した行（計算に使っていた行）があれば、それを使い直す。
        // 同じ範囲の規定は1行しか持てない（ux_royalty_rules_scope）ため。
        const reuse = await trx
          .selectFrom('royalty_rules')
          .select('id')
          .where('payee_partner_id', '=', shared.payee_partner_id)
          .where(sql<boolean>`coalesce(brand_id, 0) = ${shared.brand_id ?? 0}`)
          .where(sql<boolean>`coalesce(product_id, 0) = ${w.product ?? 0}`)
          .where(sql<boolean>`coalesce(customer_partner_id, 0) = ${w.customer ?? 0}`)
          .where(sql<boolean>`coalesce(media_id, 0) = ${shared.media_id ?? 0}`)
          .where('valid_from', '=', shared.valid_from)
          .where('is_active', '=', false)
          .executeTakeFirst();
        rowId = reuse ? Number(reuse.id) : undefined;
      }
      if (rowId !== undefined) {
        await trx
          .updateTable('royalty_rules')
          .set({ ...body, updated_by: userId, updated_at: new Date() })
          .where('id', '=', rowId)
          .execute();
      } else {
        const ins = await trx
          .insertInto('royalty_rules')
          .values({ ...body, created_by: userId, updated_by: userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        rowId = Number(ins.id);
      }
      keptIds.push(rowId);
    }

    // 代表は、今の代表行が残るならそれのまま（画面が持っている :id を変えないため）
    const newHead = headId !== null && keptIds.includes(headId) ? headId : keptIds[0];
    const others = keptIds.filter((x) => x !== newHead);
    if (others.length > 0) {
      await trx.updateTable('royalty_rules').set({ rule_group_id: newHead }).where('id', 'in', others).execute();
    }
    // 代表が替わったときは、前の代表にぶら下げていた編集前の版も新しい代表に付け替える
    // （前の代表を消すと ON DELETE CASCADE で一緒に消えようとし、計算の明細が指しているので失敗するため）
    if (headId !== null && newHead !== headId) {
      await trx
        .updateTable('royalty_rules as r')
        .set({ rule_group_id: newHead })
        .where('r.rule_group_id', '=', headId)
        .where(IS_ROYALTY_HISTORY)
        .execute();
    }

    // 外した販売先・商品の行
    const dropped = existing.map((r) => Number(r.id)).filter((x) => !keptIds.includes(x));
    if (dropped.length > 0) {
      const used = await trx
        .selectFrom('royalty_calculation_lines')
        .select('royalty_rule_id')
        .distinct()
        .where('royalty_rule_id', 'in', dropped)
        .execute();
      const usedIds = new Set(used.map((u) => Number(u.royalty_rule_id)));
      const keepAsHistory = dropped.filter((x) => usedIds.has(x));
      const removable = dropped.filter((x) => !usedIds.has(x));
      if (keepAsHistory.length > 0) {
        await trx
          .updateTable('royalty_rules')
          .set({ is_active: false, rule_group_id: newHead, superseded_at: new Date(), updated_by: userId, updated_at: new Date() })
          .where('id', 'in', keepAsHistory)
          .execute();
      }
      if (removable.length > 0) await trx.deleteFrom('royalty_rules').where('id', 'in', removable).execute();
    }

    return {
      id: newHead,
      customer_mode: spec.mode,
      customer_count: spec.customerIds.length,
      product_count: spec.productIds.length,
      excluded_product_count: spec.excludedProductIds.length,
      row_count: keptIds.length,
    };
  }

  @Post('royalty-rules/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('Y-02', 'delete')
  async deactivateRoyaltyRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    // 配下の行を指されたときも、まとまり全体を止める
    const row = await this.db.selectFrom('royalty_rules').select(['id', 'rule_group_id']).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException(`ロイヤリティ規定が見つかりません（ID: ${id}）`);
    return this.setRoyaltyGroupActive(Number(row.rule_group_id ?? row.id), false, user.id);
  }

  /**
   * 一覧から消す。どこからも使われていないものだけ消せる。
   * 使われているものは 409 で断り、「使わない」に誘導する（1001 のご要望）。
   *
   * 代表行を消すと、そこに属する販売先の行も一緒に消える（rule_group_id の ON DELETE CASCADE）。
   */
  @Delete('royalty-rules/:id')
  @RequirePermission('Y-02', 'delete')
  removeRoyaltyRule(@Param('id', ParseIntPipe) id: number) {
    return this.crud.remove('royalty_rules', id, 'ロイヤリティ規定');
  }
}

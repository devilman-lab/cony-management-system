// ---------------------------------------------------------------------------
// AUTO-GENERATED - DO NOT EDIT BY HAND
//
// Source : docs/02-schema.sql
// Command: powershell -ExecutionPolicy Bypass -File scripts\generate-db-types.ps1
//
// Type mapping notes
//   NUMERIC / money_amt / qty_num / tax_rate -> string
//     node-postgres returns NUMERIC as text. Keeping it as a string means an
//     amount can never silently pass through a float. Do the arithmetic in SQL.
//   DATE -> string (YYYY-MM-DD), TIMESTAMPTZ -> Date
//     A bare date has no timezone, so it must not become a Date object.
//   BIGINT -> number
//     src/db/database.module.ts registers an int8 parser. Safe for row ids.
// ---------------------------------------------------------------------------

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** A column the database always computes. Never written from the application. */
type Computed<T> = ColumnType<T, never, never>;

/** ユーザー（作業4名／閲覧20名） */
export interface UsersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(60)] */
  login_id: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [VARCHAR(255)] */
  email: string | null;
  /** [TEXT] */
  password_hash: string;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [BIGINT] */
  updated_by: number | null;
}
export type Users = Selectable<UsersTable>;
export type NewUsers = Insertable<UsersTable>;
export type UsersUpdate = Updateable<UsersTable>;

/** ロール（ADMIN／OPERATOR／ACCOUNTING／VIEWER） */
export interface RolesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(80)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Roles = Selectable<RolesTable>;
export type NewRoles = Insertable<RolesTable>;
export type RolesUpdate = Updateable<RolesTable>;

export interface UserRolesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> users / BIGINT] */
  user_id: number;
  /** [-> roles / BIGINT] */
  role_id: number;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type UserRoles = Selectable<UserRolesTable>;
export type NewUserRoles = Insertable<UserRolesTable>;
export type UserRolesUpdate = Updateable<UserRolesTable>;

/** 機能単位の権限定義。is_sensitive は機微項目の参照制御に使用 */
export interface PermissionsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 機能ID（M-01, O-01 …）  [VARCHAR(20)] */
  function_id: string;
  /** view/create/update/delete/print  [VARCHAR(20)] */
  action: string;
  /** [VARCHAR(120)] */
  name: string;
  /** 原価・仕入単価・ロイヤリティ  [BOOLEAN] */
  is_sensitive: Generated<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type Permissions = Selectable<PermissionsTable>;
export type NewPermissions = Insertable<PermissionsTable>;
export type PermissionsUpdate = Updateable<PermissionsTable>;

export interface RolePermissionsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> roles / BIGINT] */
  role_id: number;
  /** [-> permissions / BIGINT] */
  permission_id: number;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type RolePermissions = Selectable<RolePermissionsTable>;
export type NewRolePermissions = Insertable<RolePermissionsTable>;
export type RolePermissionsUpdate = Updateable<RolePermissionsTable>;

/** 区分カテゴリー */
export interface CodeCategoriesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 例：PARTNER_DIVISION  [VARCHAR(60)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type CodeCategories = Selectable<CodeCategoriesTable>;
export type NewCodeCategories = Insertable<CodeCategoriesTable>;
export type CodeCategoriesUpdate = Updateable<CodeCategoriesTable>;

/** 汎用区分。ソースコードに固定値を持たない */
export interface CodesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> code_categories / BIGINT] */
  code_category_id: number;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Codes = Selectable<CodesTable>;
export type NewCodes = Insertable<CodesTable>;
export type CodesUpdate = Updateable<CodesTable>;

/** 採番ルール。採番時は行を排他ロックする */
export interface NumberingRulesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  target: string;
  /** [VARCHAR(10)] */
  prefix: string | null;
  /** [BOOLEAN] */
  use_yyyymm: Generated<boolean>;
  /** [SMALLINT] */
  seq_length: Generated<number>;
  /** [BIGINT] */
  current_value: Generated<number>;
  /** [VARCHAR(10)] */
  reset_unit: Generated<string>;
  /** [VARCHAR(10)] */
  last_reset_key: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
}
export type NumberingRules = Selectable<NumberingRulesTable>;
export type NewNumberingRules = Insertable<NumberingRulesTable>;
export type NumberingRulesUpdate = Updateable<NumberingRulesTable>;

/** 添付ファイル（実体はストレージ、DBはメタデータのみ） */
export interface AttachmentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  ref_table: string;
  /** [BIGINT] */
  ref_id: number;
  /** [VARCHAR(255)] */
  file_name: string;
  /** 実体はDBに格納しない  [TEXT] */
  storage_path: string;
  /** [VARCHAR(120)] */
  mime_type: string | null;
  /** [BIGINT] */
  byte_size: number | null;
  /** 出荷指示時の印刷対象  [BOOLEAN] */
  is_print_target: Generated<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type Attachments = Selectable<AttachmentsTable>;
export type NewAttachments = Insertable<AttachmentsTable>;
export type AttachmentsUpdate = Updateable<AttachmentsTable>;

export interface AuditLogsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> users / BIGINT] */
  user_id: number | null;
  /** [TIMESTAMPTZ] */
  acted_at: Generated<Date>;
  /** [VARCHAR(40)] */
  ref_table: string;
  /** [BIGINT] */
  ref_id: number | null;
  /** [VARCHAR(20)] */
  action: string;
  /** [JSONB] */
  before_data: unknown | null;
  /** [JSONB] */
  after_data: unknown | null;
}
export type AuditLogs = Selectable<AuditLogsTable>;
export type NewAuditLogs = Insertable<AuditLogsTable>;
export type AuditLogsUpdate = Updateable<AuditLogsTable>;

/** 販売担当（ログイン利用者とは別のマスタ） */
export interface SalesStaffTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SalesStaff = Selectable<SalesStaffTable>;
export type NewSalesStaff = Insertable<SalesStaffTable>;
export type SalesStaffUpdate = Updateable<SalesStaffTable>;

/** 媒体 */
export interface MediaTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Media = Selectable<MediaTable>;
export type NewMedia = Insertable<MediaTable>;
export type MediaUpdate = Updateable<MediaTable>;

/** 取引先カテゴリー（確保数管理に使用） */
export interface PartnerCategoriesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type PartnerCategories = Selectable<PartnerCategoriesTable>;
export type NewPartnerCategories = Insertable<PartnerCategoriesTable>;
export type PartnerCategoriesUpdate = Updateable<PartnerCategoriesTable>;

/** 販売カテゴリー（OA＝オンエア／カタログ／WEB 等）。貴社指示によりマスタ登録して選択 */
export interface SalesCategoriesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SalesCategories = Selectable<SalesCategoriesTable>;
export type NewSalesCategories = Insertable<SalesCategoriesTable>;
export type SalesCategoriesUpdate = Updateable<SalesCategoriesTable>;

/** 取引先（得意先・仕入先。Amazon等プラットフォームも1取引先として登録） */
export interface PartnersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(20)] */
  partner_code: string;
  /** [VARCHAR(120)] */
  name1: string;
  /** [VARCHAR(120)] */
  name2: string | null;
  /** [VARCHAR(60)] */
  short_name: string | null;
  /** [BOOLEAN] */
  is_customer: Generated<boolean>;
  /** [BOOLEAN] */
  is_supplier: Generated<boolean>;
  /** [-> users / BIGINT] */
  staff_user_id: number | null;
  /** 既定の販売担当。受注に引き継ぐ（v1.7）  [-> sales_staff / BIGINT] */
  sales_staff_id: number | null;
  /** [-> media / BIGINT] */
  media_id: number | null;
  /** [-> partner_categories / BIGINT] */
  partner_category_id: number | null;
  /** 粗利調整対象  [-> codes / BIGINT] */
  gross_margin_adjust_code_id: number | null;
  /** 区分  [-> codes / BIGINT] */
  division_code_id: number | null;
  /** 区分2  [-> codes / BIGINT] */
  division2_code_id: number | null;
  /** 適格請求書発行事業者番号  [VARCHAR(20)] */
  invoice_registration_no: string | null;
  /** 毎月請求書発行  [-> codes / BIGINT] */
  monthly_invoice_code_id: number | null;
  /** 電子化  [-> codes / BIGINT] */
  digitized_code_id: number | null;
  /** 請求書事項  [TEXT] */
  invoice_note: string | null;
  /** 送料3万以下・直送  [-> codes / BIGINT] */
  shipping_fee_rule_code_id: number | null;
  /** この金額以下の出荷に送料を請求。NULL＝既定値  [money_amt] */
  shipping_fee_threshold: string | null;
  /** 請求する送料額。NULL＝既定値  [money_amt] */
  shipping_fee_amount: string | null;
  /** 既定の取引条件（委託／買取）。受注で自動表示し変更可  [VARCHAR(10)] */
  default_trade_type: string | null;
  /** ロイヤリティは royalty_rules に一本化したため、取引先側では持たない（v1.5）。 支払先であるかどうかは、その取引先を指す規定があるかどうかで決まる。 締め日（99＝月末）  [SMALLINT] */
  closing_day: number | null;
  /** [SMALLINT] */
  payment_month_offset: number | null;
  /** [SMALLINT] */
  payment_day: number | null;
  /** [VARCHAR(8)] */
  postal_code: string | null;
  /** [VARCHAR(200)] */
  address1: string | null;
  /** [VARCHAR(200)] */
  address2: string | null;
  /** [VARCHAR(20)] */
  tel: string | null;
  /** [VARCHAR(20)] */
  fax: string | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Partners = Selectable<PartnersTable>;
export type NewPartners = Insertable<PartnersTable>;
export type PartnersUpdate = Updateable<PartnersTable>;

/** 納品ルール */
export interface DeliveryRulesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** 暫定  [SMALLINT] */
  lead_time_days: number | null;
  /** 暫定（例：1,2,3,4,5）  [VARCHAR(20)] */
  allowed_weekdays: string | null;
  /** 自由記述。確定前でも運用可能  [TEXT] */
  rule_body: string | null;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type DeliveryRules = Selectable<DeliveryRulesTable>;
export type NewDeliveryRules = Insertable<DeliveryRulesTable>;
export type DeliveryRulesUpdate = Updateable<DeliveryRulesTable>;

/** 作業指示内容（納品先ごとの梱包・荷札指示） */
export interface WorkInstructionsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** 出荷指示書に印字し倉庫現場へ届ける  [TEXT] */
  instruction_body: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type WorkInstructions = Selectable<WorkInstructionsTable>;
export type NewWorkInstructions = Insertable<WorkInstructionsTable>;
export type WorkInstructionsUpdate = Updateable<WorkInstructionsTable>;

/** 倉庫（自社・委託） */
export interface WarehousesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(20)] */
  warehouse_code: string;
  /** [VARCHAR(60)] */
  short_name: string;
  /** [-> codes / BIGINT] */
  division_code_id: number | null;
  /** [BOOLEAN] */
  is_consignment: Generated<boolean>;
  /** [-> partners / BIGINT] */
  partner_id: number | null;
  /** [-> media / BIGINT] */
  media_id: number | null;
  /** FK は delivery_destinations 作成後に付与  [BIGINT] */
  delivery_destination_id: number | null;
  /** [VARCHAR(8)] */
  postal_code: string | null;
  /** [VARCHAR(200)] */
  address1: string | null;
  /** [VARCHAR(200)] */
  address2: string | null;
  /** [VARCHAR(20)] */
  tel: string | null;
  /** [VARCHAR(20)] */
  fax: string | null;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Warehouses = Selectable<WarehousesTable>;
export type NewWarehouses = Insertable<WarehousesTable>;
export type WarehousesUpdate = Updateable<WarehousesTable>;

/** 納品先（1取引先に複数） */
export interface DeliveryDestinationsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [VARCHAR(20)] */
  delivery_code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** 得意先が発行している納品先No  [VARCHAR(40)] */
  partner_delivery_no: string | null;
  /** 荷受人  [VARCHAR(120)] */
  consignee: string | null;
  /** [-> codes / BIGINT] */
  division_code_id: number | null;
  /** [-> codes / BIGINT] */
  master_search_code_id: number | null;
  /** [-> codes / BIGINT] */
  slip_issue_class_code_id: number | null;
  /** [TEXT] */
  delivery_note_print1: string | null;
  /** [TEXT] */
  delivery_note_print2: string | null;
  /** [-> work_instructions / BIGINT] */
  work_instruction_id: number | null;
  /** [-> delivery_rules / BIGINT] */
  delivery_rule_id: number | null;
  /** [-> warehouses / BIGINT] */
  default_warehouse_id: number | null;
  /** [VARCHAR(8)] */
  postal_code: string | null;
  /** [VARCHAR(200)] */
  address1: string | null;
  /** [VARCHAR(200)] */
  address2: string | null;
  /** [VARCHAR(20)] */
  tel: string | null;
  /** [VARCHAR(20)] */
  fax: string | null;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type DeliveryDestinations = Selectable<DeliveryDestinationsTable>;
export type NewDeliveryDestinations = Insertable<DeliveryDestinationsTable>;
export type DeliveryDestinationsUpdate = Updateable<DeliveryDestinationsTable>;

/** ブランド（LUXCEAR、芦屋美整体 等） */
export interface BrandsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Brands = Selectable<BrandsTable>;
export type NewBrands = Insertable<BrandsTable>;
export type BrandsUpdate = Updateable<BrandsTable>;

/** カテゴリー */
export interface CategoriesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Categories = Selectable<CategoriesTable>;
export type NewCategories = Insertable<CategoriesTable>;
export type CategoriesUpdate = Updateable<CategoriesTable>;

/** 商品分類 */
export interface ProductClassesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type ProductClasses = Selectable<ProductClassesTable>;
export type NewProductClasses = Insertable<ProductClassesTable>;
export type ProductClassesUpdate = Updateable<ProductClassesTable>;

/** カラー。code は SKU コードの3〜4桁目に対応（例：03＝シフォンピンク） */
export interface ColorsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Colors = Selectable<ColorsTable>;
export type NewColors = Insertable<ColorsTable>;
export type ColorsUpdate = Updateable<ColorsTable>;

/** サイズ。code は SKU コードの5〜6桁目に対応（例：06＝L） */
export interface SizesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Sizes = Selectable<SizesTable>;
export type NewSizes = Insertable<SizesTable>;
export type SizesUpdate = Updateable<SizesTable>;

/** 商品（品番レベル） */
export interface ProductsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 商品ID＝商品コード  [VARCHAR(40)] */
  product_code: string;
  /** [VARCHAR(200)] */
  product_name: string;
  /** [VARCHAR(200)] */
  set_product_name: string | null;
  /** [-> brands / BIGINT] */
  brand_id: number | null;
  /** [-> categories / BIGINT] */
  category_id: number | null;
  /** [-> product_classes / BIGINT] */
  product_class_id: number | null;
  /** [INTEGER] */
  carton_qty: number | null;
  /** 閲覧者には非表示  [money_amt] */
  cost_price: Generated<string>;
  /** [BOOLEAN] */
  is_cost_undecided: Generated<boolean>;
  /** ロイヤリティは royalty_rules に一本化したため、商品側では持たない（v1.5）  [tax_rate] */
  tax_rate: Generated<string>;
  /** [-> codes / BIGINT] */
  division_code_id: number | null;
  /** [-> codes / BIGINT] */
  display_code_id: number | null;
  /** true は在庫を持たない  [BOOLEAN] */
  is_set: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Products = Selectable<ProductsTable>;
export type NewProducts = Insertable<ProductsTable>;
export type ProductsUpdate = Updateable<ProductsTable>;

/** SKU（品番-カラー2桁+サイズ2桁-入数区分） */
export interface SkusTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> products / BIGINT] */
  product_id: number;
  /** 例：FT1196-0306-100  [VARCHAR(40)] */
  sku_code: string;
  /** [-> colors / BIGINT] */
  color_id: number | null;
  /** [-> sizes / BIGINT] */
  size_id: number | null;
  /** 100＝単品 / 200＝2枚組  [VARCHAR(10)] */
  pack_division: string | null;
  /** [VARCHAR(20)] */
  jan: string | null;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Skus = Selectable<SkusTable>;
export type NewSkus = Insertable<SkusTable>;
export type SkusUpdate = Updateable<SkusTable>;

/** セット登録。セット自体は在庫を持たない */
export interface SetHeadersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SetHeaders = Selectable<SetHeadersTable>;
export type NewSetHeaders = Insertable<SetHeadersTable>;
export type SetHeadersUpdate = Updateable<SetHeadersTable>;

/** セット構成。引当時に展開して各構成品から引き落とす */
export interface SetComponentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> set_headers / BIGINT] */
  set_header_id: number;
  /** [-> skus / BIGINT] */
  component_sku_id: number;
  /** [qty_num] */
  qty: string;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type SetComponents = Selectable<SetComponentsTable>;
export type NewSetComponents = Insertable<SetComponentsTable>;
export type SetComponentsUpdate = Updateable<SetComponentsTable>;

/** 取引先別商品。Amazon SKU 等の専用コード読み替えの中核 */
export interface PartnerProductsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** 取引先専用コード（例：Amazon TO-GXZN-60W8）  [VARCHAR(60)] */
  partner_product_code: string | null;
  /** [VARCHAR(20)] */
  partner_jan: string | null;
  /** [VARCHAR(20)] */
  jan_code: string | null;
  /** 販売名  [VARCHAR(200)] */
  sales_name: string | null;
  /** 販売名_2  [VARCHAR(200)] */
  sales_name2: string | null;
  /** [money_amt] */
  unit_price: Generated<string>;
  /** [money_amt] */
  old_unit_price: string | null;
  /** 上代。納品書「上代あり」に印字（v1.6）  [money_amt] */
  retail_price: string | null;
  /** [DATE] */
  price_changed_date: string | null;
  /** 閲覧者には非表示  [money_amt] */
  cost_price: string | null;
  /** 販社色  [VARCHAR(40)] */
  partner_color: string | null;
  /** 販社サイズ  [VARCHAR(40)] */
  partner_size: string | null;
  /** [VARCHAR(40)] */
  color_name: string | null;
  /** [VARCHAR(40)] */
  size_name: string | null;
  /** ロイヤリティは royalty_rules に一本化したため、ここでは持たない（v1.5）  [-> product_classes / BIGINT] */
  product_class_id: number | null;
  /** [TEXT] */
  memo: string | null;
  /** [TEXT] */
  other: string | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type PartnerProducts = Selectable<PartnerProductsTable>;
export type NewPartnerProducts = Insertable<PartnerProductsTable>;
export type PartnerProductsUpdate = Updateable<PartnerProductsTable>;

/** 取引先別単価履歴。過去伝票の再計算に使用 */
export interface PartnerProductPricesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partner_products / BIGINT] */
  partner_product_id: number;
  /** [money_amt] */
  unit_price: string;
  /** [DATE] */
  valid_from: string;
  /** [DATE] */
  valid_to: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type PartnerProductPrices = Selectable<PartnerProductPricesTable>;
export type NewPartnerProductPrices = Insertable<PartnerProductPricesTable>;
export type PartnerProductPricesUpdate = Updateable<PartnerProductPricesTable>;

/** 在庫。有効在庫＝実在庫−引当済（生成列）。整合性はDBで担保する */
export interface StocksTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number;
  /** [VARCHAR(40)] */
  lot_no: Generated<string>;
  /** [DATE] */
  expiry_date: string | null;
  /** 良品／不良／返品検品待ち  [-> codes / BIGINT] */
  quality_code_id: number;
  /** [qty_num] */
  qty_on_hand: Generated<string>;
  /** [qty_num] */
  qty_allocated: Generated<string>;
  /** [qty_num] */
  qty_available: Computed<string | null>;
  /** [VARCHAR(40)] */
  consignment_product_code: string | null;
  /** [qty_num] */
  consignment_qty: string | null;
  /** 閲覧者には非表示  [money_amt] */
  cost_price: string | null;
  /** [-> partners / BIGINT] */
  partner_id: number | null;
  /** [DATE] */
  planned_sales_month: string | null;
  /** [DATE] */
  planned_arrival_month: string | null;
  /** [-> product_classes / BIGINT] */
  defective_class_id: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Stocks = Selectable<StocksTable>;
export type NewStocks = Insertable<StocksTable>;
export type StocksUpdate = Updateable<StocksTable>;

/** 在庫移動履歴。追記専用（UPDATE/DELETE を行わない） */
export interface StockMovementsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> stocks / BIGINT] */
  stock_id: number;
  /** [VARCHAR(20)] */
  movement_type: string;
  /** [VARCHAR(40)] */
  ref_table: string;
  /** [BIGINT] */
  ref_id: number;
  /** [qty_num] */
  qty: string;
  /** [qty_num] */
  qty_before: string;
  /** [qty_num] */
  qty_after: string;
  /** [TIMESTAMPTZ] */
  moved_at: Generated<Date>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type StockMovements = Selectable<StockMovementsTable>;
export type NewStockMovements = Insertable<StockMovementsTable>;
export type StockMovementsUpdate = Updateable<StockMovementsTable>;

/** 確保数（引当在庫）。販売カテゴリー×SKU×期間、任意で取引先。受注登録時にここから減る */
export interface ReservationsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 任意。空なら販売カテゴリー全体の枠（v1.7）  [-> partners / BIGINT] */
  partner_id: number | null;
  /** [-> sales_categories / BIGINT] */
  sales_category_id: number;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [DATE] */
  period_from: string;
  /** [DATE] */
  period_to: string;
  /** [qty_num] */
  reserved_qty: Generated<string>;
  /** [qty_num] */
  consumed_qty: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Reservations = Selectable<ReservationsTable>;
export type NewReservations = Insertable<ReservationsTable>;
export type ReservationsUpdate = Updateable<ReservationsTable>;

/** 入荷（指示・実績） */
export interface ReceiptsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  receipt_no: string;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number;
  /** [-> partners / BIGINT] */
  supplier_partner_id: number | null;
  /** [DATE] */
  planned_date: string | null;
  /** [DATE] */
  received_date: string | null;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Receipts = Selectable<ReceiptsTable>;
export type NewReceipts = Insertable<ReceiptsTable>;
export type ReceiptsUpdate = Updateable<ReceiptsTable>;

export interface ReceiptLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> receipts / BIGINT] */
  receipt_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [qty_num] */
  qty: string;
  /** [VARCHAR(40)] */
  lot_no: string | null;
  /** [DATE] */
  expiry_date: string | null;
  /** [money_amt] */
  cost_price: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type ReceiptLines = Selectable<ReceiptLinesTable>;
export type NewReceiptLines = Insertable<ReceiptLinesTable>;
export type ReceiptLinesUpdate = Updateable<ReceiptLinesTable>;

/** 受注。order_type により適用項目・検証・出力帳票が切り替わる */
export interface SalesOrdersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  order_no: string;
  /** 卸／直送／通販  [VARCHAR(20)] */
  order_type: string;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [-> delivery_destinations / BIGINT] */
  delivery_destination_id: number | null;
  /** [-> sales_categories / BIGINT] */
  sales_category_id: number;
  /** [VARCHAR(10)] */
  trade_type: Generated<string>;
  /** 販売担当。取引先マスタの既定担当を初期値に受注ごとに変更可（v1.7）  [-> sales_staff / BIGINT] */
  sales_staff_id: number | null;
  /** 先方の発注番号  [VARCHAR(40)] */
  po_no: string | null;
  /** 先方の発注行番号（販社CSVに含まれる）  [INTEGER] */
  po_line_no: number | null;
  /** 受注日（システム内部。締め・実績に使う）  [DATE] */
  order_date: string;
  /** 出荷日。受注フォームでは「出荷日」として表示する（確認事項⑥）  [DATE] */
  ship_date: string | null;
  /** 納品日。受注フォームでは「納品日」として表示する（確認事項⑥）  [DATE] */
  delivery_date: string | null;
  /** 納品希望日  [DATE] */
  requested_delivery_date: string | null;
  /** [-> warehouses / BIGINT] */
  ship_from_warehouse_id: number | null;
  /** [VARCHAR(120)] */
  direct_name: string | null;
  /** [VARCHAR(120)] */
  direct_kana: string | null;
  /** [VARCHAR(8)] */
  direct_postal_code: string | null;
  /** [VARCHAR(200)] */
  direct_address1: string | null;
  /** [VARCHAR(200)] */
  direct_address2: string | null;
  /** [VARCHAR(20)] */
  direct_tel: string | null;
  /** 出荷備考 → 出荷指示書  [TEXT] */
  shipping_remarks: string | null;
  /** 納品書備考 → 納品書  [TEXT] */
  delivery_note_remarks: string | null;
  /** 送料調整。入力すると自動計算した送料を上書きする  [money_amt] */
  shipping_fee_adjustment: string | null;
  /** サンプル出荷は false。出荷指示書は出て在庫も落ちるが、売上・請求には乗らない  [BOOLEAN] */
  is_billable: Generated<boolean>;
  /** [VARCHAR(30)] */
  channel: string | null;
  /** FK は external_orders 作成後に付与  [BIGINT] */
  external_order_id: number | null;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [BOOLEAN] */
  is_cancelled: Generated<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SalesOrders = Selectable<SalesOrdersTable>;
export type NewSalesOrders = Insertable<SalesOrdersTable>;
export type SalesOrdersUpdate = Updateable<SalesOrdersTable>;

/** 受注明細。負数数量・非商品行を初日から許容する */
export interface SalesOrderLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> sales_orders / BIGINT] */
  sales_order_id: number;
  /** [INTEGER] */
  line_no: number;
  /** セット商品行の line_no。内訳商品行がこれを指す（CSV は出現順で親子を表現するため取込時に補完）  [INTEGER] */
  parent_line_no: number | null;
  /** 商品／セット商品／内訳商品／販促品／送料／値引／非商品。OMS の「商品種別」に対応  [VARCHAR(20)] */
  line_type: string;
  /** [-> skus / BIGINT] */
  sku_id: number | null;
  /** [-> partner_products / BIGINT] */
  partner_product_id: number | null;
  /** [VARCHAR(200)] */
  item_name: string;
  /** 負数を許容（販促品・値引）  [qty_num] */
  qty: string;
  /** [money_amt] */
  unit_price: Generated<string>;
  /** [tax_rate] */
  tax_rate: Generated<string>;
  /** [money_amt] */
  amount: Generated<string>;
  /** [qty_num] */
  allocated_qty: Generated<string>;
  /** どの引当在庫の枠から減らしたか（v1.7）  [-> reservations / BIGINT] */
  reservation_id: number | null;
  /** 在庫の引当対象かどうか。「商品ではない行は引当対象から外す」を構造で表現する。 セット商品行は引当しない（内訳商品行から構成品の在庫を引き落とすため）。  [BOOLEAN] */
  is_stock_target: Computed<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type SalesOrderLines = Selectable<SalesOrderLinesTable>;
export type NewSalesOrderLines = Insertable<SalesOrderLinesTable>;
export type SalesOrderLinesUpdate = Updateable<SalesOrderLinesTable>;

/** 出荷。同梱があるため受注と1:1とは限らない */
export interface ShipmentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 伝票管理番号（例：D0209475）  [VARCHAR(30)] */
  shipment_no: string;
  /** [-> sales_orders / BIGINT] */
  sales_order_id: number | null;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number;
  /** [DATE] */
  planned_ship_date: string | null;
  /** [DATE] */
  ship_date: string | null;
  /** [VARCHAR(60)] */
  carrier: string | null;
  /** [VARCHAR(40)] */
  tracking_no: string | null;
  /** [VARCHAR(30)] */
  shipping_label_type: string | null;
  /** [money_amt] */
  cod_amount: string | null;
  /** [DATE] */
  delivery_date_specified: string | null;
  /** [VARCHAR(20)] */
  delivery_time_slot: string | null;
  /** 同梱先（自己参照）  [-> shipments / BIGINT] */
  consolidated_to_shipment_id: number | null;
  /** [money_amt] */
  shipping_fee: string | null;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** 確定と印刷は分離  [TIMESTAMPTZ] */
  confirmed_at: Date | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Shipments = Selectable<ShipmentsTable>;
export type NewShipments = Insertable<ShipmentsTable>;
export type ShipmentsUpdate = Updateable<ShipmentsTable>;

export interface ShipmentLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> shipments / BIGINT] */
  shipment_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [-> sales_order_lines / BIGINT] */
  sales_order_line_id: number | null;
  /** [-> skus / BIGINT] */
  sku_id: number | null;
  /** [VARCHAR(200)] */
  item_name: string;
  /** [qty_num] */
  qty: string;
  /** [money_amt] */
  unit_price: Generated<string>;
  /** [tax_rate] */
  tax_rate: Generated<string>;
  /** [money_amt] */
  amount: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type ShipmentLines = Selectable<ShipmentLinesTable>;
export type NewShipmentLines = Insertable<ShipmentLinesTable>;
export type ShipmentLinesUpdate = Updateable<ShipmentLinesTable>;

/** 引当。削除時は解除して有効在庫を戻す（実在庫は不変） */
export interface AllocationsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> sales_order_lines / BIGINT] */
  sales_order_line_id: number;
  /** [-> stocks / BIGINT] */
  stock_id: number;
  /** セット展開後の構成品  [-> skus / BIGINT] */
  sku_id: number;
  /** [qty_num] */
  qty: string;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TIMESTAMPTZ] */
  released_at: Date | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Allocations = Selectable<AllocationsTable>;
export type NewAllocations = Insertable<AllocationsTable>;
export type AllocationsUpdate = Updateable<AllocationsTable>;

/** 帳票発行履歴 */
export interface ShipmentDocumentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> shipments / BIGINT] */
  shipment_id: number;
  /** [VARCHAR(30)] */
  document_type: string;
  /** [TIMESTAMPTZ] */
  printed_at: Date | null;
  /** [-> users / BIGINT] */
  printed_by: number | null;
  /** [VARCHAR(10)] */
  output_format: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type ShipmentDocuments = Selectable<ShipmentDocumentsTable>;
export type NewShipmentDocuments = Insertable<ShipmentDocumentsTable>;
export type ShipmentDocumentsUpdate = Updateable<ShipmentDocumentsTable>;

/** 返品。return_amount は売掛残高一覧の「返品額」に集計される */
export interface ReturnsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  return_no: string;
  /** [VARCHAR(20)] */
  return_type: string;
  /** [-> partners / BIGINT] */
  partner_id: number | null;
  /** [-> shipments / BIGINT] */
  original_shipment_id: number | null;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number;
  /** [DATE] */
  return_date: string;
  /** [money_amt] */
  return_amount: Generated<string>;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Returns = Selectable<ReturnsTable>;
export type NewReturns = Insertable<ReturnsTable>;
export type ReturnsUpdate = Updateable<ReturnsTable>;

export interface ReturnLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> returns / BIGINT] */
  return_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [qty_num] */
  qty: string;
  /** [money_amt] */
  unit_price: Generated<string>;
  /** [tax_rate] */
  tax_rate: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type ReturnLines = Selectable<ReturnLinesTable>;
export type NewReturnLines = Insertable<ReturnLinesTable>;
export type ReturnLinesUpdate = Updateable<ReturnLinesTable>;

/** 再生（検品して良品在庫へ戻す） */
export interface RefurbishmentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> return_lines / BIGINT] */
  return_line_id: number;
  /** [TIMESTAMPTZ] */
  inspected_at: Generated<Date>;
  /** 良品として在庫へ戻す  [qty_num] */
  good_qty: Generated<string>;
  /** 不良在庫へ  [qty_num] */
  defective_qty: Generated<string>;
  /** 暫定：保持のみ、会計連携なし  [money_amt] */
  refurbish_cost: string | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type Refurbishments = Selectable<RefurbishmentsTable>;
export type NewRefurbishments = Insertable<RefurbishmentsTable>;
export type RefurbishmentsUpdate = Updateable<RefurbishmentsTable>;

/** 請求（取引先別締め日） */
export interface InvoicesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  invoice_no: string;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [DATE] */
  closing_date: string;
  /** 取引先別締め期間  [DATE] */
  period_from: string;
  /** [DATE] */
  period_to: string;
  /** 前回請求残高  [money_amt] */
  prev_invoice_balance: Generated<string>;
  /** 今回入金額  [money_amt] */
  current_receipt_amount: Generated<string>;
  /** 繰越残高  [money_amt] */
  carryover_balance: Generated<string>;
  /** 出荷  [money_amt] */
  shipment_amount: Generated<string>;
  /** 返品額  [money_amt] */
  return_amount: Generated<string>;
  /** 未計上10%  [money_amt] */
  unposted_10: Generated<string>;
  /** 未計上8%  [money_amt] */
  unposted_8: Generated<string>;
  /** 手数料  [money_amt] */
  fee_amount: Generated<string>;
  /** 調整10%  [money_amt] */
  adjust_10: Generated<string>;
  /** 調整8%  [money_amt] */
  adjust_8: Generated<string>;
  /** 送料（3万円以下ルール）  [money_amt] */
  shipping_fee_amount: Generated<string>;
  /** 当月請求額  [money_amt] */
  current_invoice_amount: Generated<string>;
  /** 今回請求残高  [money_amt] */
  current_balance: Generated<string>;
  /** [VARCHAR(40)] */
  po_no: string | null;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** 請求書には印刷しない  [TIMESTAMPTZ] */
  issued_at: Date | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Invoices = Selectable<InvoicesTable>;
export type NewInvoices = Insertable<InvoicesTable>;
export type InvoicesUpdate = Updateable<InvoicesTable>;

export interface InvoiceLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> invoices / BIGINT] */
  invoice_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [-> shipments / BIGINT] */
  shipment_id: number | null;
  /** [-> returns / BIGINT] */
  return_id: number | null;
  /** [VARCHAR(200)] */
  item_name: string;
  /** [qty_num] */
  qty: Generated<string>;
  /** [money_amt] */
  unit_price: Generated<string>;
  /** [tax_rate] */
  tax_rate: Generated<string>;
  /** [money_amt] */
  amount: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type InvoiceLines = Selectable<InvoiceLinesTable>;
export type NewInvoiceLines = Insertable<InvoiceLinesTable>;
export type InvoiceLinesUpdate = Updateable<InvoiceLinesTable>;

/** 請求書上部に配置する税率別内訳の出力元 */
export interface InvoiceTaxSummariesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> invoices / BIGINT] */
  invoice_id: number;
  /** [tax_rate] */
  tax_rate: string;
  /** [money_amt] */
  taxable_base: Generated<string>;
  /** [money_amt] */
  tax_amount: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type InvoiceTaxSummaries = Selectable<InvoiceTaxSummariesTable>;
export type NewInvoiceTaxSummaries = Insertable<InvoiceTaxSummariesTable>;
export type InvoiceTaxSummariesUpdate = Updateable<InvoiceTaxSummariesTable>;

/** 売掛元帳 */
export interface ArLedgersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [DATE] */
  period_from: string;
  /** [DATE] */
  period_to: string;
  /** [money_amt] */
  opening_balance: Generated<string>;
  /** [money_amt] */
  charge_amount: Generated<string>;
  /** [money_amt] */
  receipt_amount: Generated<string>;
  /** [money_amt] */
  closing_balance: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type ArLedgers = Selectable<ArLedgersTable>;
export type NewArLedgers = Insertable<ArLedgersTable>;
export type ArLedgersUpdate = Updateable<ArLedgersTable>;

/** 入金と消込 */
export interface CashReceiptsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [DATE] */
  receipt_date: string;
  /** [money_amt] */
  amount: string;
  /** [-> invoices / BIGINT] */
  invoice_id: number | null;
  /** [money_amt] */
  applied_amount: Generated<string>;
  /** FK は cash_transactions 作成後に付与  [BIGINT] */
  cash_transaction_id: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type CashReceipts = Selectable<CashReceiptsTable>;
export type NewCashReceipts = Insertable<CashReceiptsTable>;
export type CashReceiptsUpdate = Updateable<CashReceiptsTable>;

/** 仕入マスタ */
export interface PurchaseItemsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** 例：Z-SA-1216-100  [VARCHAR(60)] */
  purchase_code: string;
  /** [VARCHAR(200)] */
  item_name: string;
  /** 閲覧者・作業者に非表示  [money_amt] */
  unit_cost: Generated<string>;
  /** [-> codes / BIGINT] */
  sales_price_setting_code_id: number | null;
  /** [-> codes / BIGINT] */
  purchase_price_setting_code_id: number | null;
  /** [-> codes / BIGINT] */
  tax_exempt_code_id: number | null;
  /** [tax_rate] */
  new_tax_rate: string | null;
  /** [-> codes / BIGINT] */
  new_tax_class_code_id: number | null;
  /** [-> categories / BIGINT] */
  category_id: number | null;
  /** [-> brands / BIGINT] */
  brand_id: number | null;
  /** [-> product_classes / BIGINT] */
  product_class_id: number | null;
  /** [INTEGER] */
  sort_order: number | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type PurchaseItems = Selectable<PurchaseItemsTable>;
export type NewPurchaseItems = Insertable<PurchaseItemsTable>;
export type PurchaseItemsUpdate = Updateable<PurchaseItemsTable>;

/** 仕入・経費 */
export interface PurchasesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  purchase_no: string;
  /** 仕入／経費  [VARCHAR(10)] */
  division: string;
  /** [-> codes / BIGINT] */
  process_code_id: number | null;
  /** [DATE] */
  purchase_date: string;
  /** 海外仕入に対応  [VARCHAR(3)] */
  currency: Generated<string>;
  /** [NUMERIC(12,6)] */
  exchange_rate: string | null;
  /** [-> codes / BIGINT] */
  expense_code_id: number | null;
  /** [DATE] */
  delivery_date: string | null;
  /** [DATE] */
  payment_date1: string | null;
  /** [DATE] */
  payment_date2: string | null;
  /** [-> partners / BIGINT] */
  supplier_partner_id: number;
  /** [-> brands / BIGINT] */
  brand_id: number | null;
  /** [-> product_classes / BIGINT] */
  product_class_id: number | null;
  /** [money_amt] */
  total_amount: Generated<string>;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type Purchases = Selectable<PurchasesTable>;
export type NewPurchases = Insertable<PurchasesTable>;
export type PurchasesUpdate = Updateable<PurchasesTable>;

export interface PurchaseLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> purchases / BIGINT] */
  purchase_id: number;
  /** [INTEGER] */
  line_no: number;
  /** 費用区分  [-> codes / BIGINT] */
  cost_division_code_id: number | null;
  /** [-> purchase_items / BIGINT] */
  purchase_item_id: number | null;
  /** [VARCHAR(200)] */
  item_name: string;
  /** [qty_num] */
  qty: Generated<string>;
  /** [money_amt] */
  unit_cost: Generated<string>;
  /** [money_amt] */
  subtotal: Generated<string>;
  /** [-> codes / BIGINT] */
  tax_division_code_id: number | null;
  /** [tax_rate] */
  tax_rate: Generated<string>;
  /** 費用の配賦先  [-> brands / BIGINT] */
  target_brand_id: number | null;
  /** [-> product_classes / BIGINT] */
  target_product_class_id: number | null;
  /** [-> products / BIGINT] */
  target_product_id: number | null;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type PurchaseLines = Selectable<PurchaseLinesTable>;
export type NewPurchaseLines = Insertable<PurchaseLinesTable>;
export type PurchaseLinesUpdate = Updateable<PurchaseLinesTable>;

/** 買掛元帳 */
export interface ApLedgersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [DATE] */
  period_from: string;
  /** [DATE] */
  period_to: string;
  /** [money_amt] */
  opening_balance: Generated<string>;
  /** [money_amt] */
  charge_amount: Generated<string>;
  /** [money_amt] */
  payment_amount: Generated<string>;
  /** [money_amt] */
  closing_balance: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type ApLedgers = Selectable<ApLedgersTable>;
export type NewApLedgers = Insertable<ApLedgersTable>;
export type ApLedgersUpdate = Updateable<ApLedgersTable>;

/** 出金と消込 */
export interface CashPaymentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number;
  /** [DATE] */
  payment_date: string;
  /** [money_amt] */
  amount: string;
  /** [-> purchases / BIGINT] */
  purchase_id: number | null;
  /** [money_amt] */
  applied_amount: Generated<string>;
  /** FK は cash_transactions 作成後に付与  [BIGINT] */
  cash_transaction_id: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type CashPayments = Selectable<CashPaymentsTable>;
export type NewCashPayments = Insertable<CashPaymentsTable>;
export type CashPaymentsUpdate = Updateable<CashPaymentsTable>;

/** 入出金（手形2本立て・相殺・小切手・集金・海外送金に対応） */
export interface CashTransactionsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  cash_transaction_no: string;
  /** [VARCHAR(3)] */
  currency: Generated<string>;
  /** [DATE] */
  target_month: string;
  /** [DATE] */
  scheduled_date: string | null;
  /** 入金／出金  [VARCHAR(10)] */
  division: string;
  /** [-> codes / BIGINT] */
  type_code_id: number | null;
  /** [VARCHAR(60)] */
  sales_staff_name: string | null;
  /** [-> partners / BIGINT] */
  partner_id: number | null;
  /** [VARCHAR(60)] */
  partner_contact: string | null;
  /** [money_amt] */
  amount: Generated<string>;
  /** [DATE] */
  bill_due_date1: string | null;
  /** 手形決済日①／手形①  [money_amt] */
  bill_amount1: string | null;
  /** [DATE] */
  bill_due_date2: string | null;
  /** 手形決済日②／手形②  [money_amt] */
  bill_amount2: string | null;
  /** [DATE] */
  transaction_date: string | null;
  /** 振込  [money_amt] */
  transfer_amount: string | null;
  /** 現金  [money_amt] */
  cash_amount: string | null;
  /** カード（v1.6）  [money_amt] */
  card_amount: string | null;
  /** 手数料  [money_amt] */
  fee_amount: string | null;
  /** 集金  [money_amt] */
  collection_amount: string | null;
  /** 相殺  [money_amt] */
  offset_amount: string | null;
  /** 小切手  [money_amt] */
  check_amount: string | null;
  /** 海外送金$  [money_amt] */
  overseas_usd: string | null;
  /** 海外送金CNY  [money_amt] */
  overseas_cny: string | null;
  /** [BIGINT] */
  expense_id: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type CashTransactions = Selectable<CashTransactionsTable>;
export type NewCashTransactions = Insertable<CashTransactionsTable>;
export type CashTransactionsUpdate = Updateable<CashTransactionsTable>;

/** ロイヤリティ規定。支払先×ブランド（商品）×販売先×期間で料率・定額・対象外を決める */
export interface RoyaltyRulesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** ロイヤリティを受け取る相手。取引先マスタに登録する  [-> partners / BIGINT] */
  payee_partner_id: number;
  /** 空欄＝支払先に紐づく全ブランド  [-> brands / BIGINT] */
  brand_id: number | null;
  /** 空欄＝ブランド配下の全商品  [-> products / BIGINT] */
  product_id: number | null;
  /** 販売先。空欄にすると、すべての販売先が対象になる  [-> partners / BIGINT] */
  customer_partner_id: number | null;
  /** この組み合わせではロイヤリティが発生しないことを表す  [BOOLEAN] */
  is_excluded: Generated<boolean>;
  /** 売上／出荷／入金  [VARCHAR(20)] */
  calc_base: Generated<string>;
  /** [NUMERIC(7,4)] */
  rate: string | null;
  /** [money_amt] */
  fixed_amount: string | null;
  /** [DATE] */
  valid_from: string;
  /** [DATE] */
  valid_to: string | null;
  /** 同じ出荷に複数の規定が当てはまるとき、この値が大きい行を採用する  [INTEGER] */
  scope_priority: Computed<number | null>;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type RoyaltyRules = Selectable<RoyaltyRulesTable>;
export type NewRoyaltyRules = Insertable<RoyaltyRulesTable>;
export type RoyaltyRulesUpdate = Updateable<RoyaltyRulesTable>;

/** ロイヤリティ計算。支払先ごとに毎月1枚。確定すると、あとで料率を直しても金額は動かない */
export interface RoyaltyCalculationsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [DATE] */
  target_month: string;
  /** [-> partners / BIGINT] */
  payee_partner_id: number;
  /** [VARCHAR(20)] */
  calc_base: Generated<string>;
  /** 計算のもとになった金額の合計  [money_amt] */
  total_base_amount: Generated<string>;
  /** ロイヤリティ額の合計  [money_amt] */
  total_amount: Generated<string>;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TIMESTAMPTZ] */
  calculated_at: Generated<Date>;
  /** 確定後は料率を変えても金額が動かない  [TIMESTAMPTZ] */
  confirmed_at: Date | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type RoyaltyCalculations = Selectable<RoyaltyCalculationsTable>;
export type NewRoyaltyCalculations = Insertable<RoyaltyCalculationsTable>;
export type RoyaltyCalculationsUpdate = Updateable<RoyaltyCalculationsTable>;

export interface RoyaltyCalculationLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> royalty_calculations / BIGINT] */
  royalty_calculation_id: number;
  /** 販売先  [-> partners / BIGINT] */
  customer_partner_id: number | null;
  /** [-> brands / BIGINT] */
  brand_id: number | null;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** 適用した規定  [-> royalty_rules / BIGINT] */
  royalty_rule_id: number | null;
  /** [qty_num] */
  qty: Generated<string>;
  /** [money_amt] */
  base_amount: Generated<string>;
  /** [NUMERIC(7,4)] */
  rate: string | null;
  /** [money_amt] */
  fixed_amount: string | null;
  /** [money_amt] */
  royalty_amount: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type RoyaltyCalculationLines = Selectable<RoyaltyCalculationLinesTable>;
export type NewRoyaltyCalculationLines = Insertable<RoyaltyCalculationLinesTable>;
export type RoyaltyCalculationLinesUpdate = Updateable<RoyaltyCalculationLinesTable>;

/** 取込バッチ。バッチ単位で取消できる（出荷確定済みは不可） */
export interface ImportBatchesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** OMS_ORDER / AMAZON_TRANSACTION / PARTNER_ORDER  [VARCHAR(30)] */
  import_type: string;
  /** FK は import_templates 作成後に付与  [BIGINT] */
  import_template_id: number | null;
  /** [VARCHAR(255)] */
  file_name: string;
  /** [TIMESTAMPTZ] */
  imported_at: Generated<Date>;
  /** [-> users / BIGINT] */
  imported_by: number | null;
  /** [INTEGER] */
  total_count: Generated<number>;
  /** [INTEGER] */
  success_count: Generated<number>;
  /** [INTEGER] */
  error_count: Generated<number>;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
}
export type ImportBatches = Selectable<ImportBatchesTable>;
export type NewImportBatches = Insertable<ImportBatchesTable>;
export type ImportBatchesUpdate = Updateable<ImportBatchesTable>;

/** OMS受注の原本。冪等性は (channel, external_order_no) で担保 */
export interface ExternalOrdersTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> import_batches / BIGINT] */
  import_batch_id: number;
  /** 通販＝受注ルート／販社＝販社名  [VARCHAR(30)] */
  channel: string;
  /** 販社取込のとき解決した取引先  [-> partners / BIGINT] */
  partner_id: number | null;
  /** [VARCHAR(60)] */
  external_order_no: string;
  /** 先方の発注番号（販社CSV）  [VARCHAR(40)] */
  po_no: string | null;
  /** 先方指定の納品先コード（販社CSV）  [VARCHAR(20)] */
  delivery_code: string | null;
  /** [TIMESTAMPTZ] */
  ordered_at: Date | null;
  /** [VARCHAR(60)] */
  payment_method: string | null;
  /** [money_amt] */
  payment_fee: string | null;
  /** 合計請求金額（検算用）  [money_amt] */
  total_amount: string | null;
  /** 同梱元の受注番号（実CSVはこちらに値が入る）  [VARCHAR(60)] */
  consolidated_from: string | null;
  /** 同梱先の受注番号  [VARCHAR(60)] */
  consolidated_to: string | null;
  /** 伝票管理番号（D02094xx）  [VARCHAR(30)] */
  slip_management_no: string | null;
  /** [VARCHAR(40)] */
  tracking_no: string | null;
  /** [VARCHAR(60)] */
  warehouse_name: string | null;
  /** [DATE] */
  ship_date: string | null;
  /** [-> sales_orders / BIGINT] */
  sales_order_id: number | null;
  /** 取り込んだCSV行の原本  [JSONB] */
  raw_data: unknown;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  error_message: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
}
export type ExternalOrders = Selectable<ExternalOrdersTable>;
export type NewExternalOrders = Insertable<ExternalOrdersTable>;
export type ExternalOrdersUpdate = Updateable<ExternalOrdersTable>;

export interface ExternalOrderLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> external_orders / BIGINT] */
  external_order_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [VARCHAR(20)] */
  line_type: string | null;
  /** [VARCHAR(200)] */
  item_name: string | null;
  /** 販促品は -1  [qty_num] */
  qty: string | null;
  /** [money_amt] */
  unit_price: string | null;
  /** 上代（白鳩・ラベルヴィのCSVに含まれる）  [money_amt] */
  retail_price: string | null;
  /** 自社商品コード（例：FT1196-0306-100）  [VARCHAR(60)] */
  external_sku_code: string | null;
  /** JANは販社側でExcel保存され指数表記に壊れていることがある。取込時に桁数を検査する  [VARCHAR(20)] */
  external_jan: string | null;
  /** 販社の自社品番（例：白鳩 C71FT1151W）  [VARCHAR(60)] */
  partner_product_code: string | null;
  /** [-> skus / BIGINT] */
  sku_id: number | null;
  /** [JSONB] */
  raw_data: unknown | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type ExternalOrderLines = Selectable<ExternalOrderLinesTable>;
export type NewExternalOrderLines = Insertable<ExternalOrderLinesTable>;
export type ExternalOrderLinesUpdate = Updateable<ExternalOrderLinesTable>;

/** Amazon等の決済レポート。売上／返品／経費／入金の4系統へ振り分ける */
export interface PlatformTransactionsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> import_batches / BIGINT] */
  import_batch_id: number;
  /** [VARCHAR(30)] */
  platform: string;
  /** [VARCHAR(40)] */
  settlement_no: string | null;
  /** [VARCHAR(40)] */
  transaction_type: string;
  /** [TIMESTAMPTZ] */
  transaction_at: Date | null;
  /** [VARCHAR(60)] */
  external_order_no: string | null;
  /** Amazon SKU（TO-GXZN-60W8 等）  [VARCHAR(60)] */
  external_sku_code: string | null;
  /** 得意先別商品マスタ経由で解決  [-> skus / BIGINT] */
  sku_id: number | null;
  /** [TEXT] */
  description: string | null;
  /** [qty_num] */
  qty: string | null;
  /** [money_amt] */
  product_sales: string | null;
  /** [money_amt] */
  product_sales_tax: string | null;
  /** [money_amt] */
  shipping_fee: string | null;
  /** [money_amt] */
  shipping_tax: string | null;
  /** [money_amt] */
  points_cost: string | null;
  /** [money_amt] */
  promo_discount: string | null;
  /** [money_amt] */
  promo_discount_tax: string | null;
  /** [money_amt] */
  commission_fee: string | null;
  /** [money_amt] */
  fba_fee: string | null;
  /** [money_amt] */
  other_fee: string | null;
  /** [money_amt] */
  other_amount: string | null;
  /** [money_amt] */
  total_amount: string | null;
  /** [VARCHAR(30)] */
  status: string | null;
  /** [JSONB] */
  raw_data: unknown;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
}
export type PlatformTransactions = Selectable<PlatformTransactionsTable>;
export type NewPlatformTransactions = Insertable<PlatformTransactionsTable>;
export type PlatformTransactionsUpdate = Updateable<PlatformTransactionsTable>;

/** 販売スケジュール */
export interface SalesSchedulesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> partners / BIGINT] */
  partner_id: number | null;
  /** [-> sales_categories / BIGINT] */
  sales_category_id: number | null;
  /** [-> skus / BIGINT] */
  sku_id: number | null;
  /** [DATE] */
  planned_sales_month: string | null;
  /** [DATE] */
  planned_arrival_month: string | null;
  /** [qty_num] */
  planned_qty: string | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SalesSchedules = Selectable<SalesSchedulesTable>;
export type NewSalesSchedules = Insertable<SalesSchedulesTable>;
export type SalesSchedulesUpdate = Updateable<SalesSchedulesTable>;

/** 汎用クエリ集計の条件保存 */
export interface SavedQueriesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(120)] */
  name: string;
  /** [VARCHAR(40)] */
  target: string;
  /** [JSONB] */
  conditions: unknown;
  /** [VARCHAR(20)] */
  share_scope: Generated<string>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SavedQueries = Selectable<SavedQueriesTable>;
export type NewSavedQueries = Insertable<SavedQueriesTable>;
export type SavedQueriesUpdate = Updateable<SavedQueriesTable>;

/** 取込テンプレート。販社ごとの発注CSV書式を登録する */
export interface ImportTemplatesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(40)] */
  template_code: string;
  /** [VARCHAR(120)] */
  name: string;
  /** 対象の販社。NULL＝汎用  [-> partners / BIGINT] */
  partner_id: number | null;
  /** [VARCHAR(30)] */
  import_type: Generated<string>;
  /** CP932／UTF8  [VARCHAR(20)] */
  file_encoding: Generated<string>;
  /** [BOOLEAN] */
  has_header: Generated<boolean>;
  /** 見出しの前に読み飛ばす行数  [SMALLINT] */
  skip_rows: Generated<number>;
  /** [VARCHAR(4)] */
  delimiter: string;
  /** csv＝CSVの番号／auto＝自社採番  [VARCHAR(10)] */
  order_no_source: Generated<string>;
  /** sku_code／jan／partner_code  [VARCHAR(20)] */
  sku_match_key: Generated<string>;
  /** [VARCHAR(20)] */
  default_order_type: Generated<string>;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type ImportTemplates = Selectable<ImportTemplatesTable>;
export type NewImportTemplates = Insertable<ImportTemplatesTable>;
export type ImportTemplatesUpdate = Updateable<ImportTemplatesTable>;

/** 取込テンプレートの列マッピング。CSVの何列目を何として読むか */
export interface ImportTemplateColumnsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> import_templates / BIGINT] */
  import_template_id: number;
  /** CSVの左から何列目か（1始まり）  [SMALLINT] */
  column_index: number;
  /** CSVの見出し（照合用）  [VARCHAR(120)] */
  source_header: string | null;
  /** 取込先の項目  [VARCHAR(60)] */
  target_field: string;
  /** trim／date_slash／date_ymd／number／jan13  [VARCHAR(40)] */
  transform: string | null;
  /** [BOOLEAN] */
  is_required: Generated<boolean>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type ImportTemplateColumns = Selectable<ImportTemplateColumnsTable>;
export type NewImportTemplateColumns = Insertable<ImportTemplateColumnsTable>;
export type ImportTemplateColumnsUpdate = Updateable<ImportTemplateColumnsTable>;

/** 在庫調整（返品・再生・調整フォームの「調整」） */
export interface StockAdjustmentsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(30)] */
  adjustment_no: string;
  /** [-> warehouses / BIGINT] */
  warehouse_id: number;
  /** [DATE] */
  adjustment_date: string;
  /** 棚卸差異／破損／紛失／品質振替  [-> codes / BIGINT] */
  reason_code_id: number | null;
  /** [VARCHAR(20)] */
  status: Generated<string>;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type StockAdjustments = Selectable<StockAdjustmentsTable>;
export type NewStockAdjustments = Insertable<StockAdjustmentsTable>;
export type StockAdjustmentsUpdate = Updateable<StockAdjustmentsTable>;

export interface StockAdjustmentLinesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [-> stock_adjustments / BIGINT] */
  stock_adjustment_id: number;
  /** [INTEGER] */
  line_no: number;
  /** [-> skus / BIGINT] */
  sku_id: number;
  /** [VARCHAR(40)] */
  lot_no: Generated<string>;
  /** 良品→不良 の振替に使う  [-> codes / BIGINT] */
  from_quality_code_id: number | null;
  /** [-> codes / BIGINT] */
  to_quality_code_id: number | null;
  /** 増減。負数は減算  [qty_num] */
  qty: string;
  /** [TEXT] */
  note: string | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
}
export type StockAdjustmentLines = Selectable<StockAdjustmentLinesTable>;
export type NewStockAdjustmentLines = Insertable<StockAdjustmentLinesTable>;
export type StockAdjustmentLinesUpdate = Updateable<StockAdjustmentLinesTable>;

/** システム設定。端数処理・送料条件・取込モード等を画面から変更できるようにする */
export interface SystemSettingsTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** [VARCHAR(60)] */
  setting_key: string;
  /** TAX／SHIPPING／IMPORT／ROYALTY／DOCUMENT／ORDER／REFERENCE  [VARCHAR(40)] */
  setting_group: string;
  /** [VARCHAR(120)] */
  name: string;
  /** [TEXT] */
  value_text: string | null;
  /** text／number／boolean／date  [VARCHAR(10)] */
  value_type: string;
  /** 選択肢（カンマ区切り）。NULL＝自由入力  [TEXT] */
  allowed_values: string | null;
  /** [TEXT] */
  description: string | null;
  /** [BOOLEAN] */
  is_user_editable: Generated<boolean>;
  /** [INTEGER] */
  sort_order: number | null;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type SystemSettings = Selectable<SystemSettingsTable>;
export type NewSystemSettings = Insertable<SystemSettingsTable>;
export type SystemSettingsUpdate = Updateable<SystemSettingsTable>;

/** 郵便番号マスタ（日本郵便 KEN_ALL）。保守契約の定期更新対象 */
export interface PostalCodesTable {
  /** [BIGINT] */
  id: Generated<number>;
  /** ハイフンなし7桁  [VARCHAR(7)] */
  postal_code: string;
  /** [VARCHAR(20)] */
  prefecture: string;
  /** [VARCHAR(60)] */
  city: string;
  /** 町域。以下に掲載がない場合は空  [VARCHAR(120)] */
  town: Generated<string>;
  /** [VARCHAR(40)] */
  prefecture_kana: string | null;
  /** [VARCHAR(80)] */
  city_kana: string | null;
  /** [VARCHAR(160)] */
  town_kana: string | null;
  /** 全国地方公共団体コード  [VARCHAR(5)] */
  jis_code: string | null;
  /** 同一郵便番号に複数町域がある  [BOOLEAN] */
  is_multi_town: Generated<boolean>;
  /** [VARCHAR(10)] */
  source: Generated<string>;
  /** 取り込んだ版（YYYYMM）  [VARCHAR(6)] */
  data_version: string | null;
  /** [BOOLEAN] */
  is_active: Generated<boolean>;
  /** [TIMESTAMPTZ] */
  created_at: Generated<Date>;
  /** [-> users / BIGINT] */
  created_by: number | null;
  /** [TIMESTAMPTZ] */
  updated_at: Generated<Date>;
  /** [-> users / BIGINT] */
  updated_by: number | null;
}
export type PostalCodes = Selectable<PostalCodesTable>;
export type NewPostalCodes = Insertable<PostalCodesTable>;
export type PostalCodesUpdate = Updateable<PostalCodesTable>;

/** Every table in the cony schema. Passed to Kysely as its database type. */
export interface DB {
  allocations: AllocationsTable;
  ap_ledgers: ApLedgersTable;
  ar_ledgers: ArLedgersTable;
  attachments: AttachmentsTable;
  audit_logs: AuditLogsTable;
  brands: BrandsTable;
  cash_payments: CashPaymentsTable;
  cash_receipts: CashReceiptsTable;
  cash_transactions: CashTransactionsTable;
  categories: CategoriesTable;
  code_categories: CodeCategoriesTable;
  codes: CodesTable;
  colors: ColorsTable;
  delivery_destinations: DeliveryDestinationsTable;
  delivery_rules: DeliveryRulesTable;
  external_order_lines: ExternalOrderLinesTable;
  external_orders: ExternalOrdersTable;
  import_batches: ImportBatchesTable;
  import_template_columns: ImportTemplateColumnsTable;
  import_templates: ImportTemplatesTable;
  invoice_lines: InvoiceLinesTable;
  invoice_tax_summaries: InvoiceTaxSummariesTable;
  invoices: InvoicesTable;
  media: MediaTable;
  numbering_rules: NumberingRulesTable;
  partner_categories: PartnerCategoriesTable;
  partner_product_prices: PartnerProductPricesTable;
  partner_products: PartnerProductsTable;
  partners: PartnersTable;
  permissions: PermissionsTable;
  platform_transactions: PlatformTransactionsTable;
  postal_codes: PostalCodesTable;
  product_classes: ProductClassesTable;
  products: ProductsTable;
  purchase_items: PurchaseItemsTable;
  purchase_lines: PurchaseLinesTable;
  purchases: PurchasesTable;
  receipt_lines: ReceiptLinesTable;
  receipts: ReceiptsTable;
  refurbishments: RefurbishmentsTable;
  reservations: ReservationsTable;
  return_lines: ReturnLinesTable;
  returns: ReturnsTable;
  role_permissions: RolePermissionsTable;
  roles: RolesTable;
  royalty_calculation_lines: RoyaltyCalculationLinesTable;
  royalty_calculations: RoyaltyCalculationsTable;
  royalty_rules: RoyaltyRulesTable;
  sales_categories: SalesCategoriesTable;
  sales_order_lines: SalesOrderLinesTable;
  sales_orders: SalesOrdersTable;
  sales_schedules: SalesSchedulesTable;
  sales_staff: SalesStaffTable;
  saved_queries: SavedQueriesTable;
  set_components: SetComponentsTable;
  set_headers: SetHeadersTable;
  shipment_documents: ShipmentDocumentsTable;
  shipment_lines: ShipmentLinesTable;
  shipments: ShipmentsTable;
  sizes: SizesTable;
  skus: SkusTable;
  stock_adjustment_lines: StockAdjustmentLinesTable;
  stock_adjustments: StockAdjustmentsTable;
  stock_movements: StockMovementsTable;
  stocks: StocksTable;
  system_settings: SystemSettingsTable;
  user_roles: UserRolesTable;
  users: UsersTable;
  warehouses: WarehousesTable;
  work_instructions: WorkInstructionsTable;
}

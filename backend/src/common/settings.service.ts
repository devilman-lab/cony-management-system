import { Inject, Injectable } from '@nestjs/common';

import { KYSELY, type ConyDatabase } from '../db/database.module';

const CACHE_MS = 30_000;

/** 引当のタイミング（システム設定 ALLOCATION_TIMING の値）。 */
export type AllocationTiming = 'manual' | 'order_entry' | 'shipping_instruction';

/**
 * system_settings の読み出し。
 *
 * 端数処理・送料の閾値・引当のタイミングなど、貴社に「設定で変えられる」と
 * ご説明した項目はすべてここを通す。プログラムに固定値を持たせない。
 */
@Injectable()
export class SettingsService {
  private cache: { at: number; values: Map<string, string | null> } | null = null;

  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  private async all(): Promise<Map<string, string | null>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    const rows = await this.db.selectFrom('system_settings').select(['setting_key', 'value_text']).execute();
    const values = new Map(rows.map((r) => [r.setting_key, r.value_text]));
    this.cache = { at: Date.now(), values };
    return values;
  }

  invalidate(): void {
    this.cache = null;
  }

  async text(key: string, fallback = ''): Promise<string> {
    return (await this.all()).get(key) ?? fallback;
  }

  async number(key: string, fallback = 0): Promise<number> {
    const v = (await this.all()).get(key);
    return v === null || v === undefined || v === '' ? fallback : Number(v);
  }

  async bool(key: string, fallback = false): Promise<boolean> {
    const v = (await this.all()).get(key);
    return v === null || v === undefined ? fallback : v === 'true';
  }

  /**
   * 引当のタイミング。
   *   manual               … 受注は登録だけ。受注一覧で選んで「引当」を押したときに引き当てる（2026-10-13 受注処理編 O-06・O-19。既定）
   *   order_entry          … 受注登録時に引き当て、足りない分は引当待ちにする（9/15 ご確認）
   *   shipping_instruction … 出荷指示ボタンを押したときに引き当てる（確認事項⑧の3段階）
   * 設定が無い・知らない値のときは manual（登録で在庫を動かさない側に倒す）。
   */
  async allocationTiming(): Promise<AllocationTiming> {
    const v = await this.text('ALLOCATION_TIMING', 'manual');
    return v === 'order_entry' || v === 'shipping_instruction' ? v : 'manual';
  }

  /** 出荷指示番号の採り方。確認事項⑪により既定は受注番号をそのまま使う。 */
  shipmentNoSource(): Promise<string> {
    return this.text('SHIPMENT_NO_SOURCE', 'sales_order');
  }

  /**
   * 海外の取引先の消費税の扱い（exempt＝免税（税抜扱い）／non_taxable＝課税対象外）。
   * 取引先の「消費税免税区分」（partners.overseas_tax_treatment）があればそれ、
   * 無ければシステム設定 OVERSEAS_TAX_TREATMENT（2026-10-16 マスター編_3 M3-07 で取引先ごとに）。
   */
  async overseasTaxTreatment(partnerTreatment?: string | null): Promise<'exempt' | 'non_taxable'> {
    const v = partnerTreatment || (await this.text('OVERSEAS_TAX_TREATMENT', 'exempt'));
    return v === 'non_taxable' ? 'non_taxable' : 'exempt';
  }

  /**
   * 海外の取引先の消費税の表記。税額はどちらも 0。
   * 請求書・納品書・受注の画面で同じ言い方にそろえる（2026-10-12 受入テスト M-02）。
   * 取引先の消費税免税区分を渡すとそれに従い、渡さない（空）ときはシステム設定に従う。
   */
  async overseasTaxLabel(partnerTreatment?: string | null): Promise<'免税（税抜扱い）' | '課税対象外'> {
    return OVERSEAS_TAX_LABEL[await this.overseasTaxTreatment(partnerTreatment)];
  }
}

/** 消費税免税区分の呼び名（取引先の画面・一覧・CSV・帳票で同じ言い方にする） */
export const OVERSEAS_TAX_LABEL = {
  exempt: '免税（税抜扱い）',
  non_taxable: '課税対象外',
} as const;

/** 消費税免税区分の値。空（null）は「なし」（国内の取引先） */
export const OVERSEAS_TAX_TREATMENTS = ['exempt', 'non_taxable'] as const;

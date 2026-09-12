import { Inject, Injectable } from '@nestjs/common';

import { KYSELY, type ConyDatabase } from '../db/database.module';

const CACHE_MS = 30_000;

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

  /** 引当のタイミング。確認事項⑧により既定は出荷指示時。 */
  allocationTiming(): Promise<string> {
    return this.text('ALLOCATION_TIMING', 'shipping_instruction');
  }

  /** 出荷指示番号の採り方。確認事項⑪により既定は受注番号をそのまま使う。 */
  shipmentNoSource(): Promise<string> {
    return this.text('SHIPMENT_NO_SOURCE', 'sales_order');
  }
}

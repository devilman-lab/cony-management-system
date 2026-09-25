import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/**
 * データベースが弾いた内容を、意味の分かる応答に変える。
 *
 * 制約は「壊れないための最後の砦」で、そこに引っかかること自体は正しい。
 * ただ、そのまま返すと利用者には「Internal server error」としか見えない。
 * どの決まりに触れたのかを日本語で返す。
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  ck_reservations_period: '期間の開始日が終了日より後になっています',
  ck_stocks_available: '有効在庫を超えて引き当てることはできません',
  ck_stocks_on_hand: '実在庫をマイナスにはできません',
  ck_stocks_allocated: '引当済をマイナスにはできません',
  ck_so_dest: '卸の受注では納品先を選んでください',
  ck_so_sample: 'サンプル出荷は売上に計上できません',
  ck_so_type: '受注区分は 卸／直送／通販／サンプル のいずれかです',
  ck_so_trade: '取引条件は 委託／買取 のいずれかです',
  ck_sol_type: '明細の種別が定義されていない値です',
  ck_sol_sku: 'この種別の明細には商品の指定が必要です',
  ck_partners_role: '得意先か仕入先のどちらかには該当させてください',
  ck_partners_trade: '取引条件は 委託／買取 のいずれかです',
  ck_partners_shipfee: '送料と閾値にマイナスは入れられません',
  ck_cash_div: '入出金の区分は 入金／出金 のいずれかです',
  ck_stkadjline_qty: '増減が 0 の調整明細は登録できません',
  ck_postal_code: '郵便番号はハイフンなしの7桁で入力してください',
  ck_royalty_excl: '対象外のロイヤリティ規定に料率は入れられません',
  ck_royalty_amount: 'ロイヤリティは料率か定額のどちらかが必要です',
  ck_royalty_period: '適用開始日が終了日より後になっています',
  ck_invoices_period: '締め期間の開始日が終了日より後になっています',
  ck_set_components_qty: 'セット構成の数量は1以上にしてください',
  ck_imptpl_orderno: '受注番号の採り方は csv／auto のいずれかです',
  ck_imptplcol_field: '取込先の項目が定義されていない値です',
  ck_setting_number: '数値の設定に数値以外は入れられません',
  ck_saved_scope: '共有範囲は private（本人のみ）／shared（全体）のいずれかです',
  ck_ext_status: '取込の状態は 取込済／変換済／エラー／取消 のいずれかです',
};

const UNIQUE_MESSAGES: Record<string, string> = {
  external_orders_channel_external_order_no_key: 'この受注は取込済みです（同じ受注番号があります）',
  invoices_partner_id_period_to_key: 'この取引先・締め期間の請求はすでに作られています',
  ux_partner_products_code: 'この取引先で同じ専用コードがすでに使われています',
  ux_royalty_rules_scope: '同じ範囲・同じ適用開始日のロイヤリティ規定がすでにあります',
  royalty_calculations_target_month_payee_partner_id_key:
    'この支払先・対象月のロイヤリティ計算はすでにあります',
  postal_codes_postal_code_town_key: 'この郵便番号と町域の組み合わせはすでに登録されています',
  ux_reservations_scope:
    'この取引先・販売カテゴリー・商品・期間の確保数はすでに登録されています',
  ux_skus_jan: 'この JAN コードは別の SKU で使われています。JAN は1つの商品にだけ登録してください',
  skus_sku_code_key: 'この SKU コードはすでに登録されています',
  partners_partner_code_key: 'この取引先コードはすでに登録されています',
  products_product_code_key: 'この品番はすでに登録されています',
  warehouses_warehouse_code_key: 'この倉庫コードはすでに登録されています',
  purchase_items_purchase_code_key: 'この仕入コードはすでに登録されています',
  users_login_id_key: 'このログインIDはすでに使われています',
  delivery_destinations_delivery_code_key:
    'この納品先コードはすでに使われています（納品先コードは全社で1つに限ります）',
  set_headers_sku_id_key: 'この SKU のセットはすでに登録されています',
};

@Catch()
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DatabaseExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // Nest が投げた例外はそのまま通す
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
      return;
    }

    // body-parser などが投げる、HTTP の状態を持った例外
    const withStatus = exception as { status?: number; statusCode?: number; type?: string };
    const rawStatus = withStatus.status ?? withStatus.statusCode;
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600) {
      const message =
        rawStatus === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'ファイルが大きすぎます。担当者に上限（MAX_UPLOAD_MB）の引き上げをご相談ください'
          : exception instanceof Error
            ? exception.message
            : '要求を処理できませんでした';
      this.logger.warn(`${rawStatus} ${withStatus.type ?? ''} ${message}`.trim());
      res.status(rawStatus).json({ statusCode: rawStatus, message });
      return;
    }

    const pg = exception as PgError;
    const constraint = pg.constraint ?? '';

    if (pg.code === '23514' || pg.code === '23505' || pg.code === '23503' || pg.code === '23502') {
      const { status, message } = this.describe(pg, constraint);
      this.logger.warn(`${pg.code} ${constraint} -> ${message}`);
      res.status(status).json({ statusCode: status, message, constraint: constraint || undefined });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: '処理中に問題が起きました。時間をおいて試すか、担当者にお知らせください',
    });
  }

  private describe(pg: PgError, constraint: string): { status: number; message: string } {
    switch (pg.code) {
      case '23514':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: CONSTRAINT_MESSAGES[constraint] ?? `入力内容が決まりに合いません（${constraint}）`,
        };
      case '23505':
        return {
          status: HttpStatus.CONFLICT,
          message: UNIQUE_MESSAGES[constraint] ?? 'すでに同じ内容が登録されています',
        };
      case '23503':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: '指定された取引先・商品などが見つかりません。選び直してください',
        };
      case '23502':
        return { status: HttpStatus.BAD_REQUEST, message: '必須の項目が入力されていません' };
      default:
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: '処理中に問題が起きました' };
    }
  }
}

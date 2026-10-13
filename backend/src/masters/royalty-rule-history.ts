import { BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';

import type { ConyDatabase } from '../db/database.module';

/**
 * ロイヤリティ規定の「編集前の版」（2026-10-12 T3 No.37 D3）。
 *
 * 計算に使った規定を、販売先の指定を変えるように直すと（例：媒体全体 → 対象 2社）、
 * 外れた行は月次計算の明細（royalty_calculation_lines）が ID で指しているので消せない。
 * 以前はこの行を「無効」の別の規定として一覧に残していたため、利用者の作っていない規定が増え、
 * 「有効に戻す」で元の料率が復活してしまった。
 *
 * いまは、外れた行を元のまとまりの代表行にぶら下げたまま（rule_group_id）「使わない」にし、
 * superseded_at（編集前の版になった日時）を入れて「編集前の版」として持つ。備考は利用者のものなので触らない。
 *   ・一覧ではまとまりの1件の中に数えず、別の規定としても出さない（件数だけ history_count で返す）
 *   ・「使わない」「有効に戻す」はこの行に効かない（計算に使われることもない）
 *   ・同じ範囲の規定をあとで作り直すときは、この行を使い直す（ux_royalty_rules_scope のため。そのとき superseded_at を空に戻す）
 */

/** 行が「編集前の版」か。別名 r の royalty_rules に対して使う。 */
export const IS_ROYALTY_HISTORY = sql<boolean>`(r.superseded_at is not null)`;

/**
 * 選んだ販売先が、規定の媒体の販売先か（2026-10-12 T3 No.37 D2）。
 * 媒体の違う販売先（媒体が未設定の販売先も）を入れると、計算では媒体が合わずに黙って 0 円になるため、
 * 登録のときに断る。
 */
export async function assertCustomersInMedia(db: ConyDatabase, mediaId: number | null, customerIds: number[]) {
  if (mediaId === null || customerIds.length === 0) return;
  const media = await db.selectFrom('media').select('name').where('id', '=', mediaId).executeTakeFirst();
  const mediaName = media?.name ?? String(mediaId);
  const rows = await db
    .selectFrom('partners')
    .select(['id', 'name1', 'media_id'])
    .where('id', 'in', customerIds)
    .execute();
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of customerIds) {
    const p = byId.get(id);
    if (!p) throw new BadRequestException(`販売先が見つかりません（ID: ${id}）`);
    if (p.media_id === null || Number(p.media_id) !== Number(mediaId)) {
      throw new BadRequestException(
        `${p.name1} は媒体『${mediaName}』の販売先ではありません。取引先マスタで媒体を直すか、その媒体の規定を作ってください`,
      );
    }
  }
}

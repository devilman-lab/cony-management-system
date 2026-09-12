import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { KYSELY, type ConyDatabase } from '../db/database.module';

export interface AuthenticatedUser {
  id: number;
  login_id: string;
  name: string;
}

export interface LoginResult {
  access_token: string;
  user: AuthenticatedUser & { roles: string[]; permissions: string[] };
}

/** 権限は「機能ID:操作」の形で持つ（例 M-01:view）。 */
const permissionKey = (functionId: string, action: string): string => `${functionId}:${action}`;

const PERMISSION_CACHE_MS = 60_000;

@Injectable()
export class AuthService {
  private readonly permissionCache = new Map<number, { at: number; keys: Set<string> }>();

  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly jwt: JwtService,
  ) {}

  async login(loginId: string, password: string): Promise<LoginResult> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'login_id', 'name', 'password_hash'])
      .where('login_id', '=', loginId)
      .where('is_active', '=', true)
      .executeTakeFirst();

    // 利用者が存在しない場合も、パスワード相違と同じ応答にする。
    // 「そのIDは存在する」と分かること自体が手がかりになるため。
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !ok) {
      throw new UnauthorizedException('ログインIDまたはパスワードが違います');
    }

    const [roles, permissions] = await Promise.all([
      this.rolesOf(user.id),
      this.permissionsOf(user.id),
    ]);

    const payload = { sub: user.id, login_id: user.login_id, name: user.name };

    return {
      access_token: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        login_id: user.login_id,
        name: user.name,
        roles,
        permissions: [...permissions].sort(),
      },
    };
  }

  async rolesOf(userId: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select('r.code as code')
      .where('ur.user_id', '=', userId)
      .where('r.is_active', '=', true)
      .execute();
    return rows.map((r) => r.code);
  }

  /**
   * その利用者が持つ権限。1リクエストごとに引くと重いので短時間だけ覚えておく。
   * 権限を変更した直後は最大1分反映が遅れる。即時に反映したい場合は
   * invalidate() を呼ぶ（権限編集画面から呼ぶ想定）。
   */
  async permissionsOf(userId: number): Promise<Set<string>> {
    const cached = this.permissionCache.get(userId);
    if (cached && Date.now() - cached.at < PERMISSION_CACHE_MS) return cached.keys;

    const rows = await this.db
      .selectFrom('user_roles as ur')
      .innerJoin('role_permissions as rp', 'rp.role_id', 'ur.role_id')
      .innerJoin('permissions as p', 'p.id', 'rp.permission_id')
      .select(['p.function_id as function_id', 'p.action as action'])
      .where('ur.user_id', '=', userId)
      .execute();

    const keys = new Set(rows.map((r) => permissionKey(r.function_id, r.action)));
    this.permissionCache.set(userId, { at: Date.now(), keys });
    return keys;
  }

  invalidate(userId?: number): void {
    if (userId === undefined) this.permissionCache.clear();
    else this.permissionCache.delete(userId);
  }

  async can(userId: number, functionId: string, action: string): Promise<boolean> {
    const keys = await this.permissionsOf(userId);
    return keys.has(permissionKey(functionId, action));
  }

  /**
   * 原価・仕入単価・ロイヤリティを見てよいか。
   *
   * 要件定義書の「原価・仕入単価・ロイヤリティは、閲覧のみの方には表示されません」は
   * 画面ではなく項目を指している。そこで商品マスタ自体は閲覧者にも開き、
   * この権限がない利用者には金額の欄を返さない、という作りにしている。
   */
  canSeeSensitive(userId: number): Promise<boolean> {
    return this.can(userId, 'SENSITIVE', 'view');
  }
}

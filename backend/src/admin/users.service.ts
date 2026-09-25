import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { sql } from 'kysely';

import { AuthService } from '../auth/auth.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';

export interface UserRow {
  id: number;
  login_id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  roles: { id: number; code: string; name: string }[];
}

export interface PermissionRow {
  id: number;
  function_id: string;
  action: string;
  name: string;
  is_sensitive: boolean;
}

/** 権限マトリクス。機能 × 操作の升目に、どのロールが持っているかを入れて返す。 */
export interface PermissionMatrix {
  roles: { id: number; code: string; name: string }[];
  permissions: PermissionRow[];
  /** permission_id → その権限を持つ role_id の一覧。 */
  granted: Record<string, number[]>;
}

const ADMIN_ROLE = 'ADMIN';
const MIN_PASSWORD_LENGTH = 10;

/**
 * 機能ID M-17 ユーザー・権限。
 *
 * **最後の管理者を消せないようにしてある。**管理者が1人もいなくなると、
 * 誰もこの画面に入れなくなり、データベースを直接触るしか戻す手段がなくなるため。
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly auth: AuthService,
  ) {}

  // --------------------------------------------------------------------------
  // 利用者
  // --------------------------------------------------------------------------

  async list(opts: { q?: string; include_inactive: boolean }): Promise<UserRow[]> {
    let query = this.db
      .selectFrom('users as u')
      .select(['u.id', 'u.login_id', 'u.name', 'u.email', 'u.is_active']);

    if (!opts.include_inactive) query = query.where('u.is_active', '=', true);
    if (opts.q) {
      const like = `%${opts.q}%`;
      query = query.where(sql<boolean>`(u.login_id ilike ${like} or u.name ilike ${like})`);
    }

    const users = await query.orderBy('u.login_id').execute();
    const roles = await this.rolesByUser(users.map((u) => u.id));

    return users.map((u) => ({ ...u, roles: roles.get(u.id) ?? [] }));
  }

  async findOne(id: number): Promise<UserRow> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'login_id', 'name', 'email', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!user) throw new NotFoundException(`利用者が見つかりません（ID: ${id}）`);

    const roles = await this.rolesByUser([id]);
    return { ...user, roles: roles.get(id) ?? [] };
  }

  async create(
    input: {
      login_id: string;
      name: string;
      email?: string | null;
      password: string;
      role_ids: number[];
    },
    actorId: number,
  ): Promise<UserRow> {
    this.assertPassword(input.password);
    const hash = await bcrypt.hash(input.password, 12);

    const id = await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          login_id: input.login_id,
          name: input.name,
          email: input.email ?? null,
          password_hash: hash,
          created_by: actorId,
          updated_by: actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (input.role_ids.length > 0) {
        await trx
          .insertInto('user_roles')
          .values(
            input.role_ids.map((roleId) => ({
              user_id: user.id,
              role_id: roleId,
              created_by: actorId,
            })),
          )
          .execute();
      }
      return user.id;
    });

    return this.findOne(id);
  }

  async update(
    id: number,
    values: { name?: string; email?: string | null; is_active?: boolean },
    actorId: number,
  ): Promise<UserRow> {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('更新する項目がありません');
    }

    if (clean.is_active === false) await this.assertNotLastAdmin(id, '無効にできません');

    const row = await this.db
      .updateTable('users')
      .set({ ...clean, updated_by: actorId, updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`利用者が見つかりません（ID: ${id}）`);

    // 停止・再開・パスワード変更をすぐ効かせる
    this.auth.invalidate(id);
    return this.findOne(id);
  }

  /** 退職などで使わなくなった利用者。**行は消さない。**伝票の登録者として残るため。 */
  async setActive(id: number, isActive: boolean, actorId: number): Promise<UserRow> {
    return this.update(id, { is_active: isActive }, actorId);
  }

  async setPassword(id: number, password: string, actorId: number): Promise<{ id: number }> {
    this.assertPassword(password);
    const hash = await bcrypt.hash(password, 12);

    const row = await this.db
      .updateTable('users')
      .set({ password_hash: hash, updated_by: actorId, updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`利用者が見つかりません（ID: ${id}）`);

    // 停止・再開・パスワード変更をすぐ効かせる
    this.auth.invalidate(id);
    return { id: row.id };
  }

  /** その利用者のロールを入れ替える。渡した一覧がそのまま結果になる。 */
  async setRoles(id: number, roleIds: number[], actorId: number): Promise<UserRow> {
    const user = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFoundException(`利用者が見つかりません（ID: ${id}）`);

    const adminRole = await this.db
      .selectFrom('roles')
      .select('id')
      .where('code', '=', ADMIN_ROLE)
      .executeTakeFirst();

    if (adminRole && !roleIds.includes(adminRole.id)) {
      await this.assertNotLastAdmin(id, '管理者ロールを外せません');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('user_roles').where('user_id', '=', id).execute();
      if (roleIds.length > 0) {
        await trx
          .insertInto('user_roles')
          .values(roleIds.map((roleId) => ({ user_id: id, role_id: roleId, created_by: actorId })))
          .execute();
      }
    });

    // 権限は短時間覚えているので、変更したこの場で捨てて即座に効かせる。
    this.auth.invalidate(id);
    return this.findOne(id);
  }

  // --------------------------------------------------------------------------
  // ロールと権限マトリクス
  // --------------------------------------------------------------------------

  async listRoles(): Promise<{ id: number; code: string; name: string; is_active: boolean }[]> {
    return this.db
      .selectFrom('roles')
      .select(['id', 'code', 'name', 'is_active'])
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
  }

  async listPermissions(): Promise<PermissionRow[]> {
    return this.db
      .selectFrom('permissions')
      .select(['id', 'function_id', 'action', 'name', 'is_sensitive'])
      .orderBy('function_id')
      .orderBy('id')
      .execute();
  }

  async matrix(): Promise<PermissionMatrix> {
    const [roles, permissions, links] = await Promise.all([
      this.db
        .selectFrom('roles')
        .select(['id', 'code', 'name'])
        .where('is_active', '=', true)
        .orderBy('sort_order')
        .orderBy('id')
        .execute(),
      this.listPermissions(),
      this.db.selectFrom('role_permissions').select(['role_id', 'permission_id']).execute(),
    ]);

    const granted: Record<string, number[]> = {};
    for (const p of permissions) granted[String(p.id)] = [];
    for (const l of links) granted[String(l.permission_id)]?.push(l.role_id);

    return { roles, permissions, granted };
  }

  /** ロールが持つ権限を入れ替える。権限マトリクスの1列を保存する操作にあたる。 */
  async setRolePermissions(
    roleId: number,
    permissionIds: number[],
  ): Promise<{ role_id: number; permission_count: number }> {
    const role = await this.db
      .selectFrom('roles')
      .select(['id', 'code'])
      .where('id', '=', roleId)
      .executeTakeFirst();
    if (!role) throw new NotFoundException(`ロールが見つかりません（ID: ${roleId}）`);

    // 管理者から M-17 を外すと、権限画面そのものに入れなくなる。
    if (role.code === ADMIN_ROLE) {
      const m17 = await this.db
        .selectFrom('permissions')
        .select('id')
        .where('function_id', '=', 'M-17')
        .execute();
      const missing = m17.filter((p) => !permissionIds.includes(p.id));
      if (missing.length > 0) {
        throw new BadRequestException(
          '管理者ロールからユーザー・権限（M-17）を外すことはできません。外すと誰も権限を変更できなくなります。',
        );
      }
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
      if (permissionIds.length > 0) {
        await trx
          .insertInto('role_permissions')
          .values(permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId })))
          .execute();
      }
    });

    // どの利用者に効くか分からないため、覚えている分をすべて捨てる。
    this.auth.invalidate();
    return { role_id: roleId, permission_count: permissionIds.length };
  }

  // --------------------------------------------------------------------------
  // 監査ログ
  // --------------------------------------------------------------------------

  async auditLogs(opts: {
    ref_table?: string;
    ref_id?: number;
    user_id?: number;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: unknown[]; total: number; limit: number; offset: number }> {
    let base = this.db.selectFrom('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id');

    if (opts.ref_table) base = base.where('a.ref_table', '=', opts.ref_table);
    if (opts.ref_id !== undefined) base = base.where('a.ref_id', '=', opts.ref_id);
    if (opts.user_id !== undefined) base = base.where('a.user_id', '=', opts.user_id);
    if (opts.from) base = base.where(sql<boolean>`a.acted_at >= ${opts.from}::date`);
    if (opts.to) base = base.where(sql<boolean>`a.acted_at < (${opts.to}::date + 1)`);

    const [items, total] = await Promise.all([
      base
        .select([
          'a.id',
          'a.acted_at',
          'a.ref_table',
          'a.ref_id',
          'a.action',
          'a.user_id',
          'u.name as user_name',
          'a.before_data',
          'a.after_data',
        ])
        .orderBy('a.acted_at', 'desc')
        .orderBy('a.id', 'desc')
        .limit(opts.limit)
        .offset(opts.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: opts.limit, offset: opts.offset };
  }

  // --------------------------------------------------------------------------

  private async rolesByUser(
    userIds: number[],
  ): Promise<Map<number, { id: number; code: string; name: string }[]>> {
    const map = new Map<number, { id: number; code: string; name: string }[]>();
    if (userIds.length === 0) return map;

    const rows = await this.db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select(['ur.user_id', 'r.id', 'r.code', 'r.name'])
      .where('ur.user_id', 'in', userIds)
      .orderBy('r.sort_order')
      .execute();

    for (const r of rows) {
      const list = map.get(r.user_id) ?? [];
      list.push({ id: r.id, code: r.code, name: r.name });
      map.set(r.user_id, list);
    }
    return map;
  }

  private assertPassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`);
    }
  }

  /** この利用者を外すと有効な管理者がいなくなる場合に断る。 */
  private async assertNotLastAdmin(userId: number, what: string): Promise<void> {
    const others = await this.db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .innerJoin('users as u', 'u.id', 'ur.user_id')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('r.code', '=', ADMIN_ROLE)
      .where('u.is_active', '=', true)
      .where('ur.user_id', '<>', userId)
      .executeTakeFirstOrThrow();

    if (Number(others.n) === 0) {
      throw new BadRequestException(`最後の管理者のため、${what}`);
    }
  }
}

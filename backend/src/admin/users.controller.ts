import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { type AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser, RequirePermission } from '../auth/guards';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で入力してください');
const idList = z.array(z.number().int().positive()).default([]);

const ListUsersSchema = z.object({
  q: z.string().trim().min(1).optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
type ListUsersQuery = z.infer<typeof ListUsersSchema>;

const CreateUserSchema = z.object({
  login_id: z.string().trim().min(1, 'ログインIDを入力してください').max(60),
  name: z.string().trim().min(1, '氏名を入力してください').max(120),
  email: z.string().trim().email('メールアドレスの形式が正しくありません').max(255).nullish(),
  password: z.string().min(10, 'パスワードは10文字以上にしてください'),
  role_ids: idList,
});
type CreateUserBody = z.infer<typeof CreateUserSchema>;

const UpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email('メールアドレスの形式が正しくありません').max(255).nullish(),
  is_active: z.boolean().optional(),
});
type UpdateUserBody = z.infer<typeof UpdateUserSchema>;

const PasswordSchema = z.object({
  password: z.string().min(10, 'パスワードは10文字以上にしてください'),
});
type PasswordBody = z.infer<typeof PasswordSchema>;

const RolesSchema = z.object({ role_ids: idList });
type RolesBody = z.infer<typeof RolesSchema>;

const RolePermissionsSchema = z.object({ permission_ids: idList });
type RolePermissionsBody = z.infer<typeof RolePermissionsSchema>;

const AuditQuerySchema = z.object({
  ref_table: z.string().trim().max(40).optional(),
  ref_id: z.coerce.number().int().positive().optional(),
  user_id: z.coerce.number().int().positive().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** 機能ID M-17 ユーザー・権限。管理者だけが入れる。 */
@Controller('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // --- 利用者 --------------------------------------------------------------

  @Get('users')
  @RequirePermission('M-17', 'view')
  list(@Query(new ZodValidationPipe(ListUsersSchema)) query: ListUsersQuery) {
    return this.users.list({ q: query.q, include_inactive: query.include_inactive });
  }

  @Get('users/:id')
  @RequirePermission('M-17', 'view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id);
  }

  @Post('users')
  @RequirePermission('M-17', 'create')
  create(
    @Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.create(body, user.id);
  }

  @Patch('users/:id')
  @RequirePermission('M-17', 'update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateUserSchema)) body: UpdateUserBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.update(id, body, user.id);
  }

  /** パスワードの再設定。管理者が行う想定で、現在のパスワードは尋ねない。 */
  @Post('users/:id/password')
  @HttpCode(200)
  @RequirePermission('M-17', 'update')
  setPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PasswordSchema)) body: PasswordBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.setPassword(id, body.password, user.id);
  }

  @Put('users/:id/roles')
  @RequirePermission('M-17', 'update')
  setRoles(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(RolesSchema)) body: RolesBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.setRoles(id, body.role_ids, user.id);
  }

  /** 利用者は消さずに無効にする。伝票に登録者として残っているため。 */
  @Post('users/:id/deactivate')
  @HttpCode(200)
  @RequirePermission('M-17', 'delete')
  deactivate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) {
    return this.users.setActive(id, false, user.id);
  }

  // --- ロールと権限マトリクス ----------------------------------------------

  @Get('roles')
  @RequirePermission('M-17', 'view')
  roles() {
    return this.users.listRoles();
  }

  @Get('permissions')
  @RequirePermission('M-17', 'view')
  permissions() {
    return this.users.listPermissions();
  }

  @Get('permission-matrix')
  @RequirePermission('M-17', 'view')
  matrix() {
    return this.users.matrix();
  }

  @Put('roles/:id/permissions')
  @RequirePermission('M-17', 'update')
  setRolePermissions(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(RolePermissionsSchema)) body: RolePermissionsBody,
  ) {
    return this.users.setRolePermissions(id, body.permission_ids);
  }

  // --- 監査ログ ------------------------------------------------------------

  @Get('audit-logs')
  @RequirePermission('M-17', 'view')
  auditLogs(@Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery) {
    return this.users.auditLogs(query);
  }
}

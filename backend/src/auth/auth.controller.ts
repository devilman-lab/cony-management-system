import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService, type AuthenticatedUser, type LoginResult } from './auth.service';
import { CurrentUser, Public } from './guards';

const LoginSchema = z.object({
  login_id: z.string().min(1, 'ログインIDを入力してください'),
  password: z.string().min(1, 'パスワードを入力してください'),
});
type LoginBody = z.infer<typeof LoginSchema>;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginBody): Promise<LoginResult> {
    return this.auth.login(body.login_id, body.password);
  }

  /** 画面側が「今このログインは有効か」「何が見せられるか」を確かめるための入口。 */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<{
    user: AuthenticatedUser;
    roles: string[];
    permissions: string[];
  }> {
    const [roles, permissions] = await Promise.all([
      this.auth.rolesOf(user.id),
      this.auth.permissionsOf(user.id),
    ]);
    return { user, roles, permissions: [...permissions].sort() };
  }
}

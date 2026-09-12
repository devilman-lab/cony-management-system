import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { AuthService, type AuthenticatedUser } from './auth.service';

const PUBLIC_KEY = 'cony:public';
const PERMISSION_KEY = 'cony:permission';

/** ログインなしで通す（ログイン画面とヘルスチェックだけ）。 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** この操作に必要な権限。例 @RequirePermission('M-01', 'view') */
export const RequirePermission = (
  functionId: string,
  action: 'view' | 'create' | 'update' | 'delete' | 'print',
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_KEY, { functionId, action });

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

/** 認証済みの利用者を引数で受け取る。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) throw new UnauthorizedException();
    return req.user;
  },
);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('ログインしてください');
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: number;
        login_id: string;
        name: string;
      }>(token);
      req.user = { id: payload.sub, login_id: payload.login_id, name: payload.name };
      return true;
    } catch {
      throw new UnauthorizedException('ログインの有効期限が切れています');
    }
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<{ functionId: string; action: string }>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) throw new UnauthorizedException('ログインしてください');

    const allowed = await this.auth.can(req.user.id, required.functionId, required.action);
    if (!allowed) {
      throw new ForbiddenException('この操作を行う権限がありません');
    }
    return true;
  }
}

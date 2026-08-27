import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

export function getRequestUser(context: ExecutionContext): { id: string; email: string } {
  const request = context.switchToHttp().getRequest();
  return request.user;
}

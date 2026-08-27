import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email: string;
}

export const JWT_COOKIE_NAME = 'rag_token';

/** Read the httpOnly JWT cookie without requiring the cookie-parser middleware. */
export function extractJwtFromCookie(req: Request): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === JWT_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Extract JWT from query string ?token=... (used by EventSource/SSE which can't set headers). */
export function extractJwtFromQuery(req: Request): string | null {
  return (req.query?.token as string) || null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractJwtFromCookie,
        extractJwtFromQuery,
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'change-me-in-production',
    });
  }

  async validate(payload: JwtPayload): Promise<{ id: string; email: string }> {
    if (!payload?.sub) throw new UnauthorizedException();
    return { id: payload.sub, email: payload.email };
  }
}

import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JWT_COOKIE_NAME } from './jwt.strategy';

const COOKIE_MAX_AGE_MS = Number(process.env.JWT_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

function setAuthCookie(res: Response, token: string): void {
  res.cookie(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(dto);
    setAuthCookie(res, result.accessToken);
    return result;
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto);
    setAuthCookie(res, result.accessToken);
    return result;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(JWT_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return { status: 'ok' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('me')
  me(@CurrentUser() user: { id: string; email: string }) {
    return { user };
  }
}

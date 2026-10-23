import { BadRequestException, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginSchema } from '@todo/contracts';
import { sessionCookie } from '../config';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
};
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login')
  @UseGuards(LoginRateLimitGuard)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = loginSchema.safeParse(req.body);
    if (!input.success) throw new BadRequestException('Проверьте email и пароль');
    const result = await this.auth.login(input.data.email, input.data.password);
    res.cookie(sessionCookie, result.token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
    return result.user;
  }
  @Get('me')
  async me(@Req() req: Request) {
    return (await this.auth.verify(this.auth.token(req.headers.cookie))).user;
  }
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(sessionCookie, cookieOptions);
    return { ok: true };
  }
}

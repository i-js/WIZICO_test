import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { parse } from 'cookie';
import { z } from 'zod';
import type { User } from '@todo/contracts';
import { PrismaService } from '../database/prisma.service';
import { sessionCookie } from '../config';
import { verifyPassword } from './password';

const claimsSchema = z.object({ sub: z.uuid(), exp: z.number() });
export const publicUserSelect = { id: true, email: true, name: true } as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async login(email: string, password: string): Promise<{ user: User; token: string }> {
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await verifyPassword(password, user.passwordHash)))
      throw new UnauthorizedException('Неверный email или пароль');
    return {
      user: { id: user.id, email: user.email, name: user.name },
      token: await this.jwt.signAsync({ sub: user.id }),
    };
  }
  token(cookieHeader?: string): string {
    const token = parse(cookieHeader ?? '')[sessionCookie];
    if (!token) throw new UnauthorizedException('Войдите в аккаунт');
    return token;
  }
  async verify(token: string): Promise<{ user: User; expiresAt: number }> {
    let claims: z.infer<typeof claimsSchema>;
    try {
      claims = claimsSchema.parse(await this.jwt.verifyAsync<unknown & object>(token));
    } catch {
      throw new UnauthorizedException('Сессия истекла. Войдите снова');
    }
    let user: User | null;
    try {
      user = await this.db.user.findUnique({
        where: { id: claims.sub },
        select: publicUserSelect,
      });
    } catch {
      throw new ServiceUnavailableException('Сервер временно недоступен. Повторите попытку');
    }
    if (!user) throw new UnauthorizedException('Войдите в аккаунт повторно');
    return { user, expiresAt: claims.exp * 1000 };
  }
}

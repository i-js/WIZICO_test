import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

type Bucket = { attempts: number; expiresAt: number };

// One API process: bounded memory and a fixed cooldown, applied before password hashing.
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private nextCleanupAt = 0;

  consume(ip: string, email?: string, now = Date.now()): number {
    if (now >= this.nextCleanupAt) {
      for (const [key, bucket] of this.buckets)
        if (bucket.expiresAt <= now) this.buckets.delete(key);
      this.nextCleanupAt = now + 60_000;
    }
    const limits = [{ key: `ip:${ip}`, max: 30, window: 60_000 }];
    if (email)
      limits.push({ key: `email:${email.trim().toLowerCase()}`, max: 10, window: 300_000 });
    let retryAfter = 0;
    for (const { key, max } of limits) {
      const bucket = this.buckets.get(key);
      if (bucket && bucket.expiresAt > now && bucket.attempts >= max)
        retryAfter = Math.max(retryAfter, bucket.expiresAt - now);
    }
    if (retryAfter) return Math.ceil(retryAfter / 1000);
    const newKeys = limits.filter(({ key }) => !this.buckets.has(key)).length;
    if (this.buckets.size + newKeys > 10_000) return 60;
    for (const { key, window } of limits) {
      const bucket = this.buckets.get(key);
      if (!bucket || bucket.expiresAt <= now)
        this.buckets.set(key, { attempts: 1, expiresAt: now + window });
      else bucket.attempts++;
    }
    return 0;
  }
}

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly limiter = new LoginRateLimiter();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const email: unknown = request.body?.email;
    const retryAfter = this.limiter.consume(
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
      typeof email === 'string' && email.length <= 254 ? email : undefined,
    );
    if (retryAfter) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Слишком много попыток входа. Попробуйте позже', 429);
    }
    return true;
  }
}

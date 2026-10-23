import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { LoginRateLimiter } from '../src/auth/login-rate-limit';
import type { PrismaService } from '../src/database/prisma.service';

describe('session verification', () => {
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-characters' });
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'test@example.com',
    name: 'Test',
  };
  const token = jwt.sign({ sub: user.id }, { expiresIn: '1h' });
  const service = (lookup: () => Promise<unknown>) =>
    new AuthService({ user: { findUnique: lookup } } as unknown as PrismaService, jwt);

  it('returns the user for a valid session', async () => {
    assert.deepEqual((await service(async () => user).verify(token)).user, user);
  });
  it('rejects invalid and expired JWTs before accessing the database', async () => {
    const auth = service(async () => {
      assert.fail('Unexpected database lookup');
    });
    for (const input of ['invalid-token', jwt.sign({ sub: user.id }, { expiresIn: -1 })])
      await assert.rejects(auth.verify(input), UnauthorizedException);
  });
  it('treats a missing user as unauthorized', async () => {
    await assert.rejects(service(async () => null).verify(token), UnauthorizedException);
  });
  it('keeps database failures distinct from an expired session', async () => {
    await assert.rejects(
      service(async () => {
        throw new Error('Database unavailable');
      }).verify(token),
      ServiceUnavailableException,
    );
  });
});

describe('login rate limits', () => {
  it('limits an account across IPs, normalizes email and allows retry after cooldown', () => {
    const limiter = new LoginRateLimiter();
    for (let index = 0; index < 10; index++)
      assert.equal(limiter.consume(`ip-${index}`, 'Alice@example.com', 1000), 0);
    assert.equal(limiter.consume('other-ip', 'alice@example.com', 1001), 300);
    assert.equal(limiter.consume('other-ip', 'alice@example.com', 301_000), 0);
  });
  it('limits an IP even if every request targets a different account', () => {
    const limiter = new LoginRateLimiter();
    for (let index = 0; index < 30; index++)
      assert.equal(limiter.consume('same-ip', `${index}@example.com`, 1000), 0);
    assert.equal(limiter.consume('same-ip', 'new@example.com', 1001), 60);
    assert.equal(limiter.consume('different-ip', 'new@example.com', 1001), 0);
    assert.equal(limiter.consume('same-ip', 'new@example.com', 61_000), 0);
  });
});

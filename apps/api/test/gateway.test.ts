import 'reflect-metadata';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { AuthService } from '../src/auth/auth.service';
import type { TasksService } from '../src/tasks/tasks.service';
import { SyncGateway } from '../src/sync/sync.gateway';

it('keeps the socket session when authentication lookup is temporarily unavailable', async () => {
  const logged = mock.method(Logger.prototype, 'error', () => {});
  try {
    const events: string[] = [];
    const gateway = new SyncGateway(
      {
        verify: async () => {
          throw new ServiceUnavailableException();
        },
      } as unknown as AuthService,
      {} as TasksService,
    );
    const socket = {
      data: { token: 'valid' },
      emit: (event: string) => events.push(event),
    } as unknown as Parameters<SyncGateway['readLists']>[0];
    const reply = await gateway.readLists(socket);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.code, 'INTERNAL');
    assert.deepEqual(events, []);
  } finally {
    logged.mock.restore();
  }
});

it('expires the socket session for an invalid token', async () => {
  const events: string[] = [];
  const gateway = new SyncGateway(
    {
      verify: async () => {
        throw new UnauthorizedException();
      },
    } as unknown as AuthService,
    {} as TasksService,
  );
  const socket = {
    data: { token: 'invalid' },
    emit: (event: string) => events.push(event),
  } as unknown as Parameters<SyncGateway['readLists']>[0];
  const reply = await gateway.readLists(socket);
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.code, 'UNAUTHORIZED');
  assert.deepEqual(events, ['session:expired']);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { commandSchema, type Snapshot, type Task } from '@todo/contracts';
import { PrismaService } from '../src/database/prisma.service';
import { TasksService } from '../src/tasks/tasks.service';
import { DomainError } from '../src/tasks/errors';

describe(
  'PostgreSQL: authorization, concurrency and durable command receipts',
  { skip: !process.env.DATABASE_URL },
  () => {
    const db = new PrismaService();
    const service = new TasksService(db);
    const owner = randomUUID();
    const member = randomUUID();
    const outsider = randomUUID();
    const users = [owner, member, outsider];
    const run = (userId: string, listId: string, input: Record<string, unknown>) =>
      service.execute(userId, commandSchema.parse({ commandId: randomUUID(), listId, ...input }));
    const rejects = (promise: Promise<unknown>, code: string) =>
      assert.rejects(promise, (error) => error instanceof DomainError && error.code === code);
    async function list(shared = true) {
      const id = randomUUID();
      await run(owner, id, { type: 'list.create', title: 'Integration test' });
      if (shared) {
        const { token } = await service.createInvitation(owner, id);
        await service.acceptInvitation(member, token);
      }
      return id;
    }
    async function task(listId: string, userId = owner, text = 'Initial text') {
      const id = randomUUID();
      const result = await run(userId, listId, { type: 'task.create', taskId: id, text });
      const task = result.snapshot?.tasks.find((task) => task.id === id);
      assert.ok(task);
      return task;
    }
    before(async () => {
      await db.$connect();
      for (const [index, id] of users.entries())
        await db.user.create({
          data: {
            id,
            email: `${id}@integration.test`,
            name: `Test ${index}`,
            passwordHash: 'not-a-login-account',
          },
        });
    });
    after(async () => {
      await db.todoList.deleteMany({ where: { ownerId: { in: users } } });
      await db.processedCommand.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    });

    it('does not disclose lists or accept commands from a non-member', async () => {
      const id = await list();
      await rejects(service.snapshot(outsider, id), 'FORBIDDEN');
      await rejects(
        run(outsider, id, { type: 'task.create', taskId: randomUUID(), text: 'Intrusion' }),
        'FORBIDDEN',
      );
      await rejects(service.createInvitation(member, id), 'FORBIDDEN');
      assert.equal(
        (await service.lists(outsider)).some((item) => item.id === id),
        false,
      );
    });

    it('accepts only one of two simultaneous edits based on the same text version', async () => {
      const id = await list();
      const initial = await task(id);
      const results = await Promise.allSettled([
        run(owner, id, {
          type: 'task.update',
          taskId: initial.id,
          text: 'Owner edit',
          expectedTextVersion: 1,
        }),
        run(member, id, {
          type: 'task.update',
          taskId: initial.id,
          text: 'Member edit',
          expectedTextVersion: 1,
        }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof DomainError);
      assert.equal(rejected.reason.code, 'CONFLICT');
      assert.equal(rejected.reason.snapshot?.tasks[0]?.textVersion, 2);
    });

    it('does not create a text conflict when another user only changes completion', async () => {
      const id = await list();
      const initial = await task(id);
      await Promise.all([
        run(member, id, { type: 'task.complete', taskId: initial.id, completed: true }),
        run(owner, id, {
          type: 'task.update',
          taskId: initial.id,
          text: 'New text',
          expectedTextVersion: 1,
        }),
      ]);
      const current = (await service.snapshot(owner, id)).tasks[0];
      assert.equal(current?.text, 'New text');
      assert.equal(current?.completed, true);
    });

    it('enforces ownership, completion and admin confirmation on deletion', async () => {
      const id = await list();
      const foreign = await task(id);
      const own = await task(id, member);
      await rejects(
        run(member, id, { type: 'task.delete', taskId: foreign.id, expectedVersion: 1 }),
        'FORBIDDEN',
      );
      await run(member, id, { type: 'task.complete', taskId: own.id, completed: true });
      await rejects(
        run(member, id, {
          type: 'task.delete',
          taskId: own.id,
          expectedVersion: 2,
          confirmCompleted: true,
        }),
        'COMPLETED_TASK',
      );
      await rejects(
        run(owner, id, { type: 'task.delete', taskId: own.id, expectedVersion: 2 }),
        'CONFIRMATION_REQUIRED',
      );
      await run(owner, id, {
        type: 'task.delete',
        taskId: own.id,
        expectedVersion: 2,
        confirmCompleted: true,
      });
      assert.equal(
        (await service.snapshot(owner, id)).tasks.some((task) => task.id === own.id),
        false,
      );
    });

    it('requires a warning acknowledgement if the other user is editing', async () => {
      const id = await list();
      const initial = await task(id);
      const command = commandSchema.parse({
        type: 'task.delete',
        listId: id,
        commandId: randomUUID(),
        taskId: initial.id,
        expectedVersion: 1,
      });
      await rejects(
        service.execute(owner, command, () => true),
        'CONFIRMATION_REQUIRED',
      );
      assert.equal(await db.processedCommand.count({ where: { commandId: command.commandId } }), 0);
      await service.execute(
        owner,
        {
          ...command,
          type: 'task.delete',
          taskId: initial.id,
          expectedVersion: 1,
          confirmCompleted: false,
          confirmEditing: true,
        },
        () => true,
      );
    });

    it('preserves a complete, unique and contiguous order under simultaneous moves', async () => {
      const id = await list();
      const tasks: Task[] = [];
      for (const text of ['A', 'B', 'C', 'D']) tasks.push(await task(id, owner, text));
      await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          run(index % 2 ? member : owner, id, {
            type: 'task.move',
            taskId: tasks[index % 4]!.id,
            beforeTaskId: index % 3 ? tasks[(index + 1) % 4]!.id : null,
          }),
        ),
      );
      const snapshot = await service.snapshot(owner, id);
      assert.deepEqual(
        new Set(snapshot.tasks.map((task) => task.id)),
        new Set(tasks.map((task) => task.id)),
      );
      assert.deepEqual(
        snapshot.tasks.map((task) => task.position),
        [0, 1, 2, 3],
      );
      await rejects(
        run(owner, id, { type: 'task.move', taskId: tasks[0]!.id, beforeTaskId: randomUUID() }),
        'POSITION_CONFLICT',
      );
    });

    it('applies concurrent retries once and rejects reusing an ID with a different payload', async () => {
      const id = await list();
      const taskId = randomUUID();
      const command = commandSchema.parse({
        type: 'task.create',
        listId: id,
        commandId: randomUUID(),
        taskId,
        text: 'One task',
      });
      await Promise.all(Array.from({ length: 5 }, () => service.execute(owner, command)));
      const snapshot = await service.snapshot(owner, id);
      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.revision, 2);
      await rejects(
        service.execute(owner, {
          ...command,
          type: 'task.create',
          taskId,
          text: 'Different payload',
        }),
        'ID_REUSED',
      );
    });

    it('only rewrites changed positions and keeps deletion positions contiguous', async () => {
      const id = await list();
      const tasks = [];
      for (const text of ['A', 'B', 'C', 'D']) tasks.push(await task(id, owner, text));
      const rowVersions = () => db.$queryRaw<{ id: string; stamp: string }[]>`
        SELECT id, xmin::text AS stamp FROM "Task" WHERE "listId" = ${id}::uuid
      `;
      const before = new Map((await rowVersions()).map((row) => [row.id, row.stamp]));
      await run(owner, id, { type: 'task.move', taskId: tasks[1]!.id, beforeTaskId: tasks[0]!.id });
      const changed = (await rowVersions()).filter((row) => before.get(row.id) !== row.stamp);
      assert.deepEqual(
        new Set(changed.map((row) => row.id)),
        new Set([tasks[0]!.id, tasks[1]!.id]),
      );
      await run(owner, id, { type: 'task.delete', taskId: tasks[0]!.id, expectedVersion: 1 });
      assert.deepEqual(
        (await service.snapshot(owner, id)).tasks.map((item) => item.position),
        [0, 1, 2],
      );
    });

    it('reorders a list spanning multiple position-update batches', async () => {
      const id = await list(false);
      const tasks = Array.from({ length: 1002 }, (_, position) => ({
        id: randomUUID(),
        listId: id,
        authorId: owner,
        text: `Task ${position}`,
        position,
      }));
      await db.task.createMany({ data: tasks });
      const moved = await run(owner, id, {
        type: 'task.move',
        taskId: tasks.at(-1)!.id,
        beforeTaskId: tasks[0]!.id,
      });
      assert.equal(moved.snapshot?.tasks[0]?.id, tasks.at(-1)!.id);
      assert.deepEqual(
        moved.snapshot?.tasks.map((item) => item.position),
        tasks.map((item) => item.position),
      );
    });

    it('does not resurrect a deleted list when an old creation is retried', async () => {
      const id = randomUUID();
      const command = commandSchema.parse({
        type: 'list.create',
        listId: id,
        commandId: randomUUID(),
        title: 'Temporary',
      });
      await service.execute(owner, command);
      await run(owner, id, { type: 'list.delete', expectedRevision: 0 });
      const replay = await service.execute(owner, command);
      assert.equal(replay.snapshot, null);
      assert.equal(replay.deletedListId, id);
      assert.equal(await db.todoList.count({ where: { id } }), 0);
    });

    it('rejects editing a deleted task and stale deletion of a list', async () => {
      const id = await list();
      const initial = await task(id);
      await run(owner, id, { type: 'task.delete', taskId: initial.id, expectedVersion: 1 });
      await rejects(
        run(member, id, {
          type: 'task.update',
          taskId: initial.id,
          expectedTextVersion: 1,
          text: 'Late edit',
        }),
        'TASK_DELETED',
      );
      await rejects(run(owner, id, { type: 'list.delete', expectedRevision: 1 }), 'CONFLICT');
    });

    it('keeps the two-user limit when two invitations are accepted concurrently', async () => {
      const id = await list(false);
      const [a, b] = await Promise.all([
        service.createInvitation(owner, id),
        service.createInvitation(owner, id),
      ]);
      const results = await Promise.allSettled([
        service.acceptInvitation(member, a.token),
        service.acceptInvitation(outsider, b.token),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal((await service.snapshot(owner, id)).members.length, 2);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof DomainError);
      assert.equal(rejected.reason.code, 'LIST_FULL');
    });

    it('replays a dependent offline sequence in order', async () => {
      const id = await list();
      const taskId = randomUUID();
      await run(member, id, { type: 'task.create', taskId, text: 'Offline first' });
      await run(member, id, {
        type: 'task.update',
        taskId,
        text: 'Offline second',
        expectedTextVersion: 1,
      });
      await run(member, id, { type: 'task.complete', taskId, completed: true });
      const snapshot: Snapshot = await service.snapshot(owner, id);
      assert.equal(snapshot.tasks[0]?.text, 'Offline second');
      assert.equal(snapshot.tasks[0]?.textVersion, 2);
      assert.equal(snapshot.tasks[0]?.completed, true);
    });
  },
);

import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Command, CommandResult, ListSummary, Snapshot } from '@todo/contracts';
import { PrismaService } from '../database/prisma.service';
import { publicUserSelect } from '../auth/auth.service';
import { DomainError } from './errors';

type Tx = Prisma.TransactionClient;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class TasksService {
  constructor(private readonly db: PrismaService) {}

  async lists(userId: string): Promise<ListSummary[]> {
    return this.db.todoList.findMany({
      where: { members: { some: { userId } } },
      select: { id: true, title: true, ownerId: true, revision: true },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
  }

  async authorize(userId: string, listId: string): Promise<void> {
    const membership = await this.db.membership.findUnique({
      where: { listId_userId: { listId, userId } },
      select: { listId: true },
    });
    if (!membership) throw new DomainError('FORBIDDEN', 'Нет доступа к списку');
  }

  async validateFocus(userId: string, listId: string, taskId: string | null): Promise<void> {
    await this.authorize(userId, listId);
    if (
      taskId &&
      !(await this.db.task.findFirst({ where: { id: taskId, listId }, select: { id: true } }))
    )
      throw new DomainError('TASK_DELETED', 'Задача удалена');
  }

  async snapshot(userId: string, listId: string, tx?: Tx): Promise<Snapshot> {
    if (!tx)
      return this.db.$transaction((transaction) => this.snapshot(userId, listId, transaction), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    const list = await tx.todoList.findUnique({
      where: { id: listId },
      include: {
        members: { include: { user: { select: publicUserSelect } }, orderBy: { userId: 'asc' } },
        tasks: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!list) throw new DomainError('LIST_DELETED', 'Список удалён или не существует');
    if (!list.members.some((member) => member.userId === userId))
      throw new DomainError('FORBIDDEN', 'Нет доступа к списку');
    return {
      id: list.id,
      title: list.title,
      ownerId: list.ownerId,
      revision: list.revision,
      members: list.members.map((member) => member.user),
      tasks: list.tasks,
    };
  }

  private async lockList(tx: Tx, listId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "TodoList" WHERE id = ${listId}::uuid FOR UPDATE`;
  }

  async execute(
    userId: string,
    command: Command,
    isEditing: (taskId: string) => boolean = () => false,
  ): Promise<CommandResult> {
    const payloadHash = sha256(JSON.stringify(command));
    const key = { userId, commandId: command.commandId };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            // The unique key serializes duplicate requests. A rollback also removes this receipt.
            await tx.processedCommand.create({
              data: { ...key, payloadHash, result: { listId: command.listId } },
            });
            if (command.type === 'list.create') {
              await tx.todoList.create({
                data: {
                  id: command.listId,
                  title: command.title,
                  ownerId: userId,
                  members: { create: { userId } },
                },
              });
              return {
                commandId: command.commandId,
                snapshot: await this.snapshot(userId, command.listId, tx),
              };
            }

            await this.lockList(tx, command.listId);
            const snapshot = await this.snapshot(userId, command.listId, tx);
            const admin = snapshot.ownerId === userId;
            if (command.type === 'list.delete') {
              if (!admin)
                throw new DomainError('FORBIDDEN', 'Удалить список может только владелец');
              if (snapshot.revision !== command.expectedRevision)
                throw new DomainError(
                  'CONFLICT',
                  'Список изменился. Проверьте его перед удалением',
                  snapshot,
                );
              await tx.todoList.delete({ where: { id: command.listId } });
              return {
                commandId: command.commandId,
                snapshot: null,
                deletedListId: command.listId,
              };
            }

            if (command.type === 'task.create') {
              await tx.task.create({
                data: {
                  id: command.taskId,
                  listId: command.listId,
                  authorId: userId,
                  text: command.text,
                  position: snapshot.tasks.length,
                },
              });
            } else {
              const task = snapshot.tasks.find((task) => task.id === command.taskId);
              if (!task)
                throw new DomainError('TASK_DELETED', 'Задача удалена другим участником', snapshot);
              switch (command.type) {
                case 'task.update': {
                  if (task.textVersion !== command.expectedTextVersion)
                    throw new DomainError(
                      'CONFLICT',
                      'Текст изменён другим участником. Ваш черновик сохранён',
                      snapshot,
                    );
                  await tx.task.update({
                    where: { id: task.id },
                    data: {
                      text: command.text,
                      textVersion: { increment: 1 },
                      version: { increment: 1 },
                    },
                  });
                  break;
                }
                case 'task.complete': {
                  await tx.task.update({
                    where: { id: task.id },
                    data: { completed: command.completed, version: { increment: 1 } },
                  });
                  break;
                }
                case 'task.delete': {
                  if (!admin && task.authorId !== userId)
                    throw new DomainError(
                      'FORBIDDEN',
                      'Участник может удалить только свою задачу',
                      snapshot,
                    );
                  if (task.version !== command.expectedVersion)
                    throw new DomainError(
                      'CONFLICT',
                      'Задача изменилась. Проверьте её перед удалением',
                      snapshot,
                    );
                  if (task.completed && !admin)
                    throw new DomainError(
                      'COMPLETED_TASK',
                      'Сначала снимите отметку выполнения',
                      snapshot,
                    );
                  const editing = isEditing(task.id);
                  if (
                    (task.completed && !command.confirmCompleted) ||
                    (editing && !command.confirmEditing)
                  ) {
                    throw new DomainError(
                      'CONFIRMATION_REQUIRED',
                      'Подтвердите удаление задачи',
                      snapshot,
                      { completed: task.completed, editing },
                    );
                  }
                  await tx.task.delete({ where: { id: task.id } });
                  await this.reindex(
                    tx,
                    snapshot.tasks,
                    snapshot.tasks.filter((item) => item.id !== task.id).map((item) => item.id),
                  );
                  break;
                }
                case 'task.move': {
                  if (command.beforeTaskId === task.id) break;
                  const ids = snapshot.tasks
                    .filter((item) => item.id !== task.id)
                    .map((item) => item.id);
                  const index =
                    command.beforeTaskId === null ? ids.length : ids.indexOf(command.beforeTaskId);
                  if (index < 0)
                    throw new DomainError(
                      'POSITION_CONFLICT',
                      'Задача-ориентир удалена. Повторите перемещение',
                      snapshot,
                    );
                  ids.splice(index, 0, task.id);
                  await this.reindex(tx, snapshot.tasks, ids);
                  break;
                }
              }
            }
            await tx.todoList.update({
              where: { id: command.listId },
              data: { revision: { increment: 1 } },
            });
            return {
              commandId: command.commandId,
              snapshot: await this.snapshot(userId, command.listId, tx),
            };
          },
          { maxWait: 10_000, timeout: 15_000 },
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const receipt = await this.db.processedCommand.findUnique({
            where: { userId_commandId: key },
          });
          if (!receipt || receipt.payloadHash !== payloadHash)
            throw new DomainError(
              'ID_REUSED',
              'Идентификатор уже использован для другого действия',
            );
          // Return the current state, not the historical snapshot: the list may have been deleted since.
          try {
            return {
              commandId: command.commandId,
              snapshot: await this.snapshot(userId, command.listId),
            };
          } catch (lookupError) {
            if (lookupError instanceof DomainError && lookupError.code === 'LIST_DELETED')
              return {
                commandId: command.commandId,
                snapshot: null,
                deletedListId: command.listId,
              };
            throw lookupError;
          }
        }
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
  }

  private async reindex(
    tx: Tx,
    previous: { id: string; position: number }[],
    ids: string[],
  ): Promise<void> {
    const positions = new Map(previous.map((task) => [task.id, task.position]));
    const changed = ids
      .map((id, position) => ({ id, position }))
      .filter(({ id, position }) => positions.get(id) !== position);
    // Bound parameter count for large lists; only the affected range is written.
    for (let offset = 0; offset < changed.length; offset += 1000) {
      const rows = changed
        .slice(offset, offset + 1000)
        .map(({ id, position }) => Prisma.sql`(${id}::uuid, ${position}::int)`);
      await tx.$executeRaw`
        UPDATE "Task" AS task SET position = changes.position
        FROM (VALUES ${Prisma.join(rows)}) AS changes(id, position)
        WHERE task.id = changes.id
      `;
    }
  }

  async createInvitation(userId: string, listId: string): Promise<{ token: string }> {
    const token = randomBytes(32).toString('base64url');
    await this.db.$transaction(async (tx) => {
      await this.lockList(tx, listId);
      const list = await this.snapshot(userId, listId, tx);
      if (list.ownerId !== userId)
        throw new DomainError('FORBIDDEN', 'Приглашать может только владелец');
      if (list.members.length >= 2)
        throw new DomainError('LIST_FULL', 'В списке уже два участника');
      await tx.invitation.create({
        data: {
          listId,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    });
    return { token };
  }

  async acceptInvitation(userId: string, token: string): Promise<Snapshot> {
    return this.db.$transaction(async (tx) => {
      const found = await tx.invitation.findUnique({ where: { tokenHash: sha256(token) } });
      if (!found) throw new DomainError('INVITATION_INVALID', 'Приглашение недействительно');
      await this.lockList(tx, found.listId);
      const invite = await tx.invitation.findUnique({ where: { id: found.id } });
      if (!invite || invite.expiresAt.getTime() < Date.now())
        throw new DomainError('INVITATION_INVALID', 'Срок приглашения истёк');
      if (invite.acceptedBy && invite.acceptedBy !== userId)
        throw new DomainError('INVITATION_INVALID', 'Приглашение уже использовано');
      const list = await tx.todoList.findUnique({
        where: { id: found.listId },
        include: { members: true },
      });
      if (!list) throw new DomainError('LIST_DELETED', 'Список удалён');
      if (list.ownerId === userId)
        throw new DomainError('FORBIDDEN', 'Откройте приглашение под аккаунтом второго участника');
      if (!list.members.some((member) => member.userId === userId)) {
        if (list.members.length >= 2)
          throw new DomainError('LIST_FULL', 'В списке уже два участника');
        await tx.membership.create({ data: { listId: list.id, userId } });
        await tx.todoList.update({ where: { id: list.id }, data: { revision: { increment: 1 } } });
      }
      await tx.invitation.update({ where: { id: invite.id }, data: { acceptedBy: userId } });
      return this.snapshot(userId, list.id, tx);
    });
  }
}

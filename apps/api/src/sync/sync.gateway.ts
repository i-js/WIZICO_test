import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ZodError } from 'zod';
import {
  commandSchema,
  focusSchema,
  inviteAcceptSchema,
  joinSchema,
  type ClientEvents,
  type CommandResult,
  type Presence,
  type Reply,
  type ServerEvents,
  type Snapshot,
  type User,
} from '@todo/contracts';
import { AuthService } from '../auth/auth.service';
import { webOrigins } from '../config';
import { TasksService } from '../tasks/tasks.service';
import { DomainError } from '../tasks/errors';

type SessionData = {
  user: User;
  token: string;
  expiresAt: number;
  expiry?: NodeJS.Timeout;
  listId?: string;
};
type Client = Socket<ClientEvents, ServerEvents, Record<string, never>, SessionData>;
type SocketServer = Server<ClientEvents, ServerEvents, Record<string, never>, SessionData>;
type Online = { user: User; listId: string; taskId: string | null; focusAt: number };
const room = (listId: string) => `list:${listId}`;

@WebSocketGateway({
  transports: ['websocket'],
  cors: { origin: webOrigins, credentials: true },
  maxHttpBufferSize: 20_000,
  allowRequest: (req, callback) =>
    callback(
      null,
      typeof req.headers.origin === 'string' && webOrigins.includes(req.headers.origin),
    ),
})
export class SyncGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: SocketServer;
  private readonly logger = new Logger(SyncGateway.name);
  private readonly online = new Map<string, Online>();

  constructor(
    private readonly auth: AuthService,
    private readonly tasks: TasksService,
  ) {}

  afterInit(server: SocketServer) {
    server.use(async (socket, next) => {
      try {
        const token = this.auth.token(socket.handshake.headers.cookie);
        const { user, expiresAt } = await this.auth.verify(token);
        socket.data = { user, token, expiresAt };
        next();
      } catch (error) {
        next(new Error(error instanceof UnauthorizedException ? 'UNAUTHORIZED' : 'INTERNAL'));
      }
    });
  }
  async handleConnection(socket: Client) {
    try {
      await socket.join(`user:${socket.data.user.id}`);
      socket.data.expiry = setTimeout(
        () => {
          socket.emit('session:expired');
          socket.disconnect(true);
        },
        Math.max(0, socket.data.expiresAt - Date.now()),
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) socket.emit('session:expired');
      socket.disconnect(true);
    }
  }
  handleDisconnect(socket: Client) {
    clearTimeout(socket.data.expiry);
    const previous = this.online.get(socket.id);
    this.online.delete(socket.id);
    if (previous) this.emitPresence(previous.listId);
  }

  private async reply<T>(
    socket: Client,
    action: (userId: string) => Promise<T>,
  ): Promise<Reply<T>> {
    try {
      const { user } = await this.auth.verify(socket.data.token);
      return { ok: true, data: await action(user.id) };
    } catch (error) {
      if (error instanceof DomainError)
        return {
          ok: false,
          code: error.code,
          message: error.message,
          snapshot: error.snapshot,
          details: error.details,
        };
      if (error instanceof ZodError)
        return { ok: false, code: 'VALIDATION', message: 'Некорректные данные команды' };
      if (error instanceof UnauthorizedException) {
        socket.emit('session:expired');
        return { ok: false, code: 'UNAUTHORIZED', message: 'Войдите в аккаунт повторно' };
      }
      this.logger.error(error);
      return {
        ok: false,
        code: 'INTERNAL',
        message: 'Сервер временно недоступен. Действие сохранено для повтора',
      };
    }
  }

  @SubscribeMessage('lists:read')
  readLists(@ConnectedSocket() socket: Client) {
    return this.reply(socket, (userId) => this.tasks.lists(userId));
  }

  @SubscribeMessage('list:join')
  join(@ConnectedSocket() socket: Client, @MessageBody() input: unknown) {
    return this.reply(socket, async (userId) => {
      const { listId } = joinSchema.parse(input);
      await this.tasks.authorize(userId, listId);
      const previous = socket.data.listId;
      if (previous && previous !== listId) await socket.leave(room(previous));
      socket.data.listId = listId;
      const existing = this.online.get(socket.id);
      this.online.set(
        socket.id,
        previous === listId && existing
          ? existing
          : { user: socket.data.user, listId, taskId: null, focusAt: Date.now() },
      );
      await socket.join(room(listId));
      if (previous && previous !== listId) this.emitPresence(previous);
      this.emitPresence(listId);
      // Join before the final read so an intervening update cannot be missed.
      return this.tasks.snapshot(userId, listId);
    });
  }

  @SubscribeMessage('command')
  command(@ConnectedSocket() socket: Client, @MessageBody() input: unknown) {
    return this.reply(socket, async (userId) => {
      const command = commandSchema.parse(input);
      const result = await this.tasks.execute(userId, command, (taskId) =>
        this.presence(command.listId).some(
          (person) => person.userId !== userId && person.taskId === taskId,
        ),
      );
      this.broadcast(result, userId, command.type === 'list.create');
      return result;
    });
  }

  broadcast(result: CommandResult, actorId?: string, listsChanged = false) {
    if (result.snapshot) {
      const snapshot = result.snapshot;
      this.server
        .to(room(snapshot.id))
        .emit('list:snapshot', { snapshot, commandId: result.commandId || undefined, actorId });
      if (listsChanged)
        for (const member of snapshot.members)
          this.server.to(`user:${member.id}`).emit('lists:changed');
      for (const entry of this.online.values()) {
        if (
          entry.listId === snapshot.id &&
          entry.taskId &&
          !snapshot.tasks.some((task) => task.id === entry.taskId)
        )
          entry.taskId = null;
      }
      this.emitPresence(snapshot.id);
    }
    if (result.deletedListId) {
      this.server.to(room(result.deletedListId)).emit('list:deleted', {
        listId: result.deletedListId,
        commandId: result.commandId || undefined,
        actorId,
      });
      this.server.to(room(result.deletedListId)).emit('lists:changed');
      for (const [socketId, entry] of this.online)
        if (entry.listId === result.deletedListId) this.online.delete(socketId);
    }
  }

  private presence(listId: string): Presence[] {
    const unique = new Map<string, Presence>();
    for (const entry of this.online.values()) {
      if (entry.listId !== listId) continue;
      const taskId = Date.now() - entry.focusAt < 30_000 ? entry.taskId : null;
      unique.set(`${entry.user.id}:${taskId}`, {
        userId: entry.user.id,
        name: entry.user.name,
        taskId,
      });
    }
    return [...unique.values()];
  }
  private emitPresence(listId: string) {
    this.server.to(room(listId)).emit('presence:changed', { listId, users: this.presence(listId) });
  }

  @SubscribeMessage('presence:focus')
  focus(@ConnectedSocket() socket: Client, @MessageBody() input: unknown) {
    return this.reply(socket, async (userId) => {
      const { listId, taskId } = focusSchema.parse(input);
      if (socket.data.listId !== listId)
        throw new DomainError('FORBIDDEN', 'Сначала откройте список');
      await this.tasks.validateFocus(userId, listId, taskId);
      this.online.set(socket.id, { user: socket.data.user, listId, taskId, focusAt: Date.now() });
      this.emitPresence(listId);
      return null;
    });
  }

  @SubscribeMessage('invite:create')
  invite(@ConnectedSocket() socket: Client, @MessageBody() input: unknown) {
    return this.reply(socket, (userId) =>
      this.tasks.createInvitation(userId, joinSchema.parse(input).listId),
    );
  }
  @SubscribeMessage('invite:accept')
  accept(@ConnectedSocket() socket: Client, @MessageBody() input: unknown) {
    return this.reply(socket, async (userId) => {
      const snapshot = await this.tasks.acceptInvitation(
        userId,
        inviteAcceptSchema.parse(input).token,
      );
      this.broadcast({ commandId: '', snapshot }, undefined, true);
      return snapshot;
    });
  }
}

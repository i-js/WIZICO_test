import { z } from 'zod';

export const idSchema = z.uuid();
export const titleSchema = z.string().trim().min(1).max(100);
export const textSchema = z.string().trim().min(1).max(2000);
export const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
export const userSchema = z.object({ id: idSchema, email: z.email(), name: z.string() });
export type User = z.infer<typeof userSchema>;
export type Role = 'admin' | 'member';

export const taskSchema = z.object({
  id: idSchema,
  listId: idSchema,
  authorId: idSchema,
  text: textSchema,
  completed: z.boolean(),
  position: z.number().int().nonnegative(),
  textVersion: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type Task = z.infer<typeof taskSchema>;
export const snapshotSchema = z.object({
  id: idSchema,
  title: titleSchema,
  ownerId: idSchema,
  revision: z.number().int().nonnegative(),
  members: z.array(userSchema),
  tasks: z.array(taskSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ListSummary = Pick<Snapshot, 'id' | 'title' | 'ownerId' | 'revision'>;

const envelope = { commandId: idSchema, listId: idSchema };
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('list.create'), title: titleSchema }),
  z.object({
    ...envelope,
    type: z.literal('list.delete'),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({ ...envelope, type: z.literal('task.create'), taskId: idSchema, text: textSchema }),
  z.object({
    ...envelope,
    type: z.literal('task.update'),
    taskId: idSchema,
    text: textSchema,
    expectedTextVersion: z.number().int().positive(),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.complete'),
    taskId: idSchema,
    completed: z.boolean(),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.move'),
    taskId: idSchema,
    beforeTaskId: idSchema.nullable(),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.delete'),
    taskId: idSchema,
    expectedVersion: z.number().int().positive(),
    confirmCompleted: z.boolean().default(false),
    confirmEditing: z.boolean().default(false),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export const errorCodes = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'LIST_DELETED',
  'TASK_DELETED',
  'CONFLICT',
  'POSITION_CONFLICT',
  'CONFIRMATION_REQUIRED',
  'COMPLETED_TASK',
  'INVITATION_INVALID',
  'LIST_FULL',
  'ID_REUSED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export type Failure = {
  ok: false;
  code: ErrorCode;
  message: string;
  snapshot?: Snapshot;
  details?: { completed?: boolean; editing?: boolean };
};
export type Reply<T> = { ok: true; data: T } | Failure;
export type CommandResult = {
  commandId: string;
  snapshot: Snapshot | null;
  deletedListId?: string;
};
export type Presence = { userId: string; name: string; taskId: string | null };
export const joinSchema = z.object({ listId: idSchema });
export const focusSchema = z.object({ listId: idSchema, taskId: idSchema.nullable() });
export const inviteAcceptSchema = z.object({ token: z.string().min(32).max(200) });

export interface ClientEvents {
  'lists:read': (ack: (reply: Reply<ListSummary[]>) => void) => void;
  'list:join': (payload: { listId: string }, ack: (reply: Reply<Snapshot>) => void) => void;
  command: (payload: Command, ack: (reply: Reply<CommandResult>) => void) => void;
  'presence:focus': (
    payload: { listId: string; taskId: string | null },
    ack: (reply: Reply<null>) => void,
  ) => void;
  'invite:create': (
    payload: { listId: string },
    ack: (reply: Reply<{ token: string }>) => void,
  ) => void;
  'invite:accept': (payload: { token: string }, ack: (reply: Reply<Snapshot>) => void) => void;
}
export interface ServerEvents {
  'list:snapshot': (payload: { snapshot: Snapshot; commandId?: string; actorId?: string }) => void;
  'list:deleted': (payload: { listId: string; commandId?: string; actorId?: string }) => void;
  'lists:changed': () => void;
  'presence:changed': (payload: { listId: string; users: Presence[] }) => void;
  'session:expired': () => void;
}

import type { Command, Failure, Snapshot, Task, User } from '@todo/contracts';

export type QueueItem = { command: Command; status: 'pending' | 'blocked'; failure?: Failure };
export type Journal = {
  snapshots: Record<string, Snapshot>;
  queue: QueueItem[];
  deletedIds: string[];
};
export const emptyJournal = (): Journal => ({ snapshots: {}, queue: [], deletedIds: [] });

export function acceptSnapshot(journal: Journal, snapshot: Snapshot): void {
  if (journal.deletedIds.includes(snapshot.id)) return;
  const current = journal.snapshots[snapshot.id];
  if (!current || current.revision <= snapshot.revision) journal.snapshots[snapshot.id] = snapshot;
}

export function acceptDeletion(journal: Journal, listId: string, commandId?: string): void {
  delete journal.snapshots[listId];
  if (!journal.deletedIds.includes(listId)) journal.deletedIds.push(listId);
  journal.queue = journal.queue.filter((item) => item.command.commandId !== commandId);
  for (const item of journal.queue) {
    if (item.command.listId === listId) {
      item.status = 'blocked';
      item.failure = {
        ok: false,
        code: 'LIST_DELETED',
        message: 'Список удалён. Скопируйте нужный текст из очереди',
      };
    }
  }
}

export function nextPending(journal: Journal): QueueItem | undefined {
  const blockedLists = new Set<string>();
  for (const item of journal.queue) {
    if (item.status === 'blocked') blockedLists.add(item.command.listId);
    else if (!blockedLists.has(item.command.listId)) return item;
  }
}

export function project(journal: Journal, user: User): Record<string, Snapshot> {
  const snapshots = structuredClone(journal.snapshots);
  const blockedLists = new Set<string>();
  for (const item of journal.queue) {
    const command = item.command;
    if (item.status === 'blocked') blockedLists.add(command.listId);
    if (blockedLists.has(command.listId) || journal.deletedIds.includes(command.listId)) continue;
    if (command.type === 'list.create') {
      snapshots[command.listId] ??= {
        id: command.listId,
        title: command.title,
        ownerId: user.id,
        revision: 0,
        members: [user],
        tasks: [],
      };
      continue;
    }
    const snapshot = snapshots[command.listId];
    if (!snapshot) continue;
    if (command.type === 'list.delete') {
      delete snapshots[command.listId];
      continue;
    }
    if (command.type === 'task.create') {
      if (!snapshot.tasks.some((task) => task.id === command.taskId))
        snapshot.tasks.push({
          id: command.taskId,
          listId: command.listId,
          authorId: user.id,
          text: command.text,
          completed: false,
          position: snapshot.tasks.length,
          version: 1,
          textVersion: 1,
        });
    } else {
      const task = snapshot.tasks.find((task) => task.id === command.taskId);
      if (!task) continue;
      if (command.type === 'task.update') {
        task.text = command.text;
        task.textVersion = command.expectedTextVersion + 1;
        task.version++;
      }
      if (command.type === 'task.complete') {
        task.completed = command.completed;
        task.version++;
      }
      if (command.type === 'task.delete')
        snapshot.tasks = snapshot.tasks.filter((task) => task.id !== command.taskId);
      if (command.type === 'task.move') {
        if (command.beforeTaskId === command.taskId) continue;
        const tasks = snapshot.tasks.filter((task) => task.id !== command.taskId);
        const index =
          command.beforeTaskId === null
            ? tasks.length
            : tasks.findIndex((task) => task.id === command.beforeTaskId);
        if (index >= 0) {
          tasks.splice(index, 0, task);
          snapshot.tasks = tasks;
        }
      }
    }
    snapshot.tasks.forEach((task, position) => {
      task.position = position;
    });
    snapshot.revision++;
  }
  return snapshots;
}

export function sameEntity(a: Command, b: Command): boolean {
  if (a.listId !== b.listId) return false;
  if (a.type.startsWith('list.') || b.type.startsWith('list.')) return true;
  return 'taskId' in a && 'taskId' in b && a.taskId === b.taskId;
}

export function discardWithDependents(journal: Journal, commandId: string): void {
  const index = journal.queue.findIndex((item) => item.command.commandId === commandId);
  const original = journal.queue[index]?.command;
  if (!original) return;
  journal.queue = journal.queue.filter(
    (item, position) => position < index || !sameEntity(original, item.command),
  );
}

export function issueQueueVersion(journal: Journal, commandId: string): string {
  const index = journal.queue.findIndex((item) => item.command.commandId === commandId);
  const original = journal.queue[index]?.command;
  if (!original) return '';
  return JSON.stringify(
    journal.queue
      .slice(index)
      .filter((item) => sameEntity(original, item.command))
      .map(({ command, status }) => ({ command, status })),
  );
}

export function resolveQueuedIssue(
  journal: Journal,
  commandId: string,
  expectedQueueVersion: string,
  replacement?: Command,
): boolean {
  if (!expectedQueueVersion || issueQueueVersion(journal, commandId) !== expectedQueueVersion)
    return false;
  const index = journal.queue.findIndex((item) => item.command.commandId === commandId);
  if (replacement?.type === 'task.update') {
    // The merged text incorporates later text edits, while completion, moves and deletion remain.
    journal.queue = journal.queue.filter(
      (item, position) =>
        position <= index ||
        item.command.type !== 'task.update' ||
        item.command.listId !== replacement.listId ||
        item.command.taskId !== replacement.taskId,
    );
    journal.queue[index] = { command: replacement, status: 'pending' };
  } else {
    discardWithDependents(journal, commandId);
    if (replacement) journal.queue.splice(index, 0, { command: replacement, status: 'pending' });
  }
  return true;
}

export function latestQueuedText(journal: Journal, command: Command): string {
  if (command.type.startsWith('list.')) {
    const texts = new Map<string, string>();
    for (const item of journal.queue)
      if (item.command.listId === command.listId && 'text' in item.command)
        texts.set(item.command.taskId, item.command.text);
    return [...texts.values()].join('\n\n');
  }
  let text = 'text' in command ? command.text : '';
  for (const item of journal.queue)
    if (sameEntity(command, item.command) && 'text' in item.command) text = item.command.text;
  return text;
}

export function taskFor(journal: Journal, command: Command): Task | undefined {
  return 'taskId' in command
    ? journal.snapshots[command.listId]?.tasks.find((task) => task.id === command.taskId)
    : undefined;
}

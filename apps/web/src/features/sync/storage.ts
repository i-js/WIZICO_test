import { openDB, type DBSchema } from 'idb';
import { emptyJournal, type Journal } from './model';

export type Draft = {
  listId: string;
  taskId: string;
  text: string;
  baseTextVersion: number;
  originalText: string;
};
interface TodoDB extends DBSchema {
  journals: { key: string; value: Journal };
  drafts: { key: string; value: Draft };
}
const db = () =>
  openDB<TodoDB>('collaborative-todo-v1', 1, {
    upgrade(database) {
      database.createObjectStore('journals');
      database.createObjectStore('drafts');
    },
  });
let channel: BroadcastChannel | undefined;
const listeners = new Set<() => void>();
function changed() {
  for (const listener of listeners) listener();
}
export function subscribe(listener: () => void): () => void {
  if (!channel) {
    channel = new BroadcastChannel('todo-journal');
    channel.onmessage = changed;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function readJournal(userId: string): Promise<Journal> {
  const database = await db();
  try {
    return (await database.get('journals', userId)) ?? emptyJournal();
  } finally {
    database.close();
  }
}
export async function mutateJournal(
  userId: string,
  update: (journal: Journal) => void,
): Promise<void> {
  const database = await db();
  try {
    const tx = database.transaction('journals', 'readwrite');
    const journal = (await tx.store.get(userId)) ?? emptyJournal();
    update(journal);
    await tx.store.put(journal, userId);
    await tx.done;
    changed();
    channel?.postMessage('changed');
  } finally {
    database.close();
  }
}
export async function readDraft(key: string) {
  const database = await db();
  try {
    return await database.get('drafts', key);
  } finally {
    database.close();
  }
}
export async function writeDraft(key: string, value: Draft | null) {
  const database = await db();
  try {
    if (value) await database.put('drafts', value, key);
    else await database.delete('drafts', key);
  } finally {
    database.close();
  }
}

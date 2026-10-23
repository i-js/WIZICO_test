'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  commandSchema,
  snapshotSchema,
  type ClientEvents,
  type Command,
  type Failure,
  type ListSummary,
  type Presence,
  type Reply,
  type ServerEvents,
  type Snapshot,
  type User,
} from '@todo/contracts';
import {
  acceptDeletion,
  acceptSnapshot,
  emptyJournal,
  nextPending,
  project,
  type Journal,
} from './model';
import { mutateJournal, readJournal, subscribe } from './storage';

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3101';
export type Connection = 'connecting' | 'syncing' | 'online' | 'offline';
type ClientSocket = Socket<ServerEvents, ClientEvents>;

export function useCollaboration(user: User, onExpired: () => void) {
  const [journal, setJournal] = useState<Journal>(emptyJournal);
  const [status, setStatus] = useState<Connection>('connecting');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<ListSummary[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [notice, setNotice] = useState('');
  const [paused, setPaused] = useState(false);
  const socketRef = useRef<ClientSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const value = await readJournal(user.id);
        if (alive) setJournal(value);
      } catch {
        if (alive)
          setNotice('Не удалось открыть локальное хранилище. Проверьте настройки браузера');
      }
    };
    const unsubscribe = subscribe(() => {
      void load();
      void drainRef.current();
    });
    void load();
    const saved = sessionStorage.getItem(`todo-list:${user.id}`);
    if (saved) {
      selectedRef.current = saved;
      setSelectedId(saved);
    }
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [user.id]);

  useEffect(() => {
    const socket: ClientSocket = io(apiUrl, {
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false,
    });
    socketRef.current = socket;
    let alive = true;
    let draining = false;
    const persist = (update: (journal: Journal) => void) => mutateJournal(user.id, update);
    const applyFailure = async (command: Command, failure: Failure) => {
      if (failure.code === 'UNAUTHORIZED') {
        expiredRef.current();
        return;
      }
      await persist((journal) => {
        if (failure.snapshot) acceptSnapshot(journal, failure.snapshot);
        const item = journal.queue.find((item) => item.command.commandId === command.commandId);
        if (item) {
          item.status = 'blocked';
          item.failure = failure;
        }
      });
    };
    const drain = async () => {
      if (draining || !socket.connected || !alive) return;
      draining = true;
      try {
        await navigator.locks.request(
          `todo-queue:${user.id}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) return;
            while (alive && socket.connected) {
              const item = nextPending(await readJournal(user.id));
              if (!item) break;
              let reply: Reply<import('@todo/contracts').CommandResult>;
              try {
                reply = await socket.timeout(8000).emitWithAck('command', item.command);
              } catch {
                break;
              }
              if (!reply.ok) {
                if (reply.code === 'INTERNAL') {
                  setNotice(reply.message);
                  break;
                }
                await applyFailure(item.command, reply);
                if (reply.code === 'UNAUTHORIZED') break;
              } else {
                await persist((journal) => {
                  journal.queue = journal.queue.filter(
                    (entry) => entry.command.commandId !== item.command.commandId,
                  );
                  if (reply.data.snapshot) acceptSnapshot(journal, reply.data.snapshot);
                  if (reply.data.deletedListId)
                    acceptDeletion(journal, reply.data.deletedListId, item.command.commandId);
                });
              }
            }
          },
        );
      } catch {
        if (alive) setNotice('Ошибка локального хранилища: изменения пока не отправлены');
      } finally {
        draining = false;
      }
    };
    drainRef.current = drain;

    let joinedListId: string | null = null;
    let refreshing: Promise<void> | undefined;
    let refreshAgain = false;
    const refreshOnce = async () => {
      if (!socket.connected || !alive) return;
      try {
        const knownIds = Object.keys((await readJournal(user.id)).snapshots);
        const lists: Reply<ListSummary[]> = await socket.timeout(8000).emitWithAck('lists:read');
        if (!alive) return;
        if (!lists.ok) {
          if (lists.code === 'UNAUTHORIZED') expiredRef.current();
          return;
        }
        if (alive) setSummaries(lists.data);
        // Reconcile even missed list-deletion broadcasts. Pending offline creations are not cached snapshots.
        const ids = new Set(lists.data.map((list) => list.id));
        const removedIds = knownIds.filter((id) => !ids.has(id));
        if (removedIds.length)
          await persist((journal) => {
            for (const id of removedIds) acceptDeletion(journal, id);
          });
        const id = selectedRef.current;
        const summary = lists.data.find((list) => list.id === id);
        const cached = id ? (await readJournal(user.id)).snapshots[id] : undefined;
        if (
          id &&
          summary &&
          (joinedListId !== id || !cached || cached.revision < summary.revision)
        ) {
          const result: Reply<Snapshot> = await socket
            .timeout(8000)
            .emitWithAck('list:join', { listId: id });
          if (!alive) return;
          if (result.ok) {
            joinedListId = id;
            await persist((journal) => acceptSnapshot(journal, result.data));
            if (id === selectedRef.current)
              socket.emit('presence:focus', { listId: id, taskId: focusedRef.current }, () => {});
          } else if (alive) setNotice(result.message);
        }
      } catch {
        /* The queue remains durable; reconnect or the next reconciliation will retry. */
      }
    };
    const refresh = (): Promise<void> => {
      refreshAgain = true;
      refreshing ??= (async () => {
        do {
          refreshAgain = false;
          await refreshOnce();
        } while (refreshAgain && alive && socket.connected);
      })().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    };
    refreshRef.current = refresh;
    socket.on('connect', () => {
      setStatus('syncing');
      void drain()
        .then(refresh)
        .finally(() => {
          if (alive && socket.connected) setStatus('online');
        });
    });
    socket.on('disconnect', () => {
      joinedListId = null;
      if (alive) {
        setStatus('offline');
        setPresence([]);
      }
    });
    socket.on('connect_error', (error) => {
      if (alive) setStatus('offline');
      if (error.message === 'UNAUTHORIZED') expiredRef.current();
    });
    socket.on('session:expired', () => {
      socket.disconnect();
      expiredRef.current();
    });
    socket.on('list:snapshot', (payload) => {
      const parsed = snapshotSchema.safeParse(payload.snapshot);
      if (parsed.success)
        void persist((journal) => {
          if (payload.commandId && payload.actorId === user.id)
            journal.queue = journal.queue.filter(
              (item) => item.command.commandId !== payload.commandId,
            );
          acceptSnapshot(journal, parsed.data);
        });
    });
    socket.on('list:deleted', (payload) => {
      void persist((journal) =>
        acceptDeletion(
          journal,
          payload.listId,
          payload.actorId === user.id ? payload.commandId : undefined,
        ),
      );
    });
    socket.on('lists:changed', () => {
      void refresh();
    });
    socket.on('presence:changed', (payload) => {
      if (payload.listId === selectedRef.current) setPresence(payload.users);
    });
    if (!paused) socket.connect();
    else setStatus('offline');
    const timer = setInterval(() => {
      if (!paused && !socket.connected) socket.connect();
      void drain().then(refresh);
    }, 5000);
    const heartbeat = setInterval(() => {
      if (socket.connected && selectedRef.current)
        socket.emit(
          'presence:focus',
          { listId: selectedRef.current, taskId: focusedRef.current },
          () => {},
        );
    }, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(heartbeat);
      socket.disconnect();
      socketRef.current = null;
      drainRef.current = async () => {};
      refreshRef.current = async () => {};
    };
  }, [user.id, paused]);

  const select = useCallback(
    (id: string) => {
      selectedRef.current = id;
      focusedRef.current = null;
      setSelectedId(id);
      setPresence([]);
      sessionStorage.setItem(`todo-list:${user.id}`, id);
      void refreshRef.current();
    },
    [user.id],
  );
  const enqueue = useCallback(
    async (input: Command) => {
      const result = commandSchema.safeParse(input);
      if (!result.success) {
        setNotice('Проверьте текст: задача — от 1 до 2000 символов, название списка — до 100');
        throw new Error('Invalid command');
      }
      try {
        await mutateJournal(user.id, (journal) => {
          journal.queue.push({ command: result.data, status: 'pending' });
        });
        void drainRef.current();
      } catch {
        setNotice('Не удалось сохранить действие на устройстве. Повторите попытку');
        throw new Error('Storage unavailable');
      }
    },
    [user.id],
  );
  const focus = useCallback((taskId: string | null) => {
    focusedRef.current = taskId;
    const socket = socketRef.current;
    if (socket?.connected && selectedRef.current)
      socket.emit('presence:focus', { listId: selectedRef.current, taskId }, () => {});
  }, []);

  const createInvitation = async (listId: string): Promise<string | null> => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setNotice('Для создания приглашения нужно соединение');
      return null;
    }
    try {
      const reply: Reply<{ token: string }> = await socket
        .timeout(8000)
        .emitWithAck('invite:create', { listId });
      if (!reply.ok) {
        setNotice(reply.message);
        return null;
      }
      return `${window.location.origin}/?invite=${encodeURIComponent(reply.data.token)}`;
    } catch {
      setNotice('Не удалось создать приглашение. Повторите попытку');
      return null;
    }
  };
  const acceptInvitation = async (token: string): Promise<boolean> => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setNotice('Для принятия приглашения нужно соединение');
      return false;
    }
    try {
      const reply: Reply<Snapshot> = await socket
        .timeout(8000)
        .emitWithAck('invite:accept', { token });
      if (!reply.ok) {
        setNotice(reply.message);
        return false;
      }
      await mutateJournal(user.id, (journal) => acceptSnapshot(journal, reply.data));
      select(reply.data.id);
      await refreshRef.current();
      return true;
    } catch {
      setNotice('Не удалось принять приглашение. Повторите попытку');
      return false;
    }
  };
  const projected = useMemo(() => project(journal, user), [journal, user]);
  const lists = useMemo(() => {
    const map = new Map(summaries.map((list) => [list.id, list]));
    for (const list of Object.values(projected)) map.set(list.id, list);
    for (const id of journal.deletedIds) map.delete(id);
    for (const item of journal.queue)
      if (item.command.type === 'list.delete' && item.status === 'pending')
        map.delete(item.command.listId);
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [summaries, projected, journal]);
  return {
    journal,
    status,
    selectedId,
    select,
    lists,
    snapshot: selectedId ? projected[selectedId] : undefined,
    presence,
    enqueue,
    focus,
    notice,
    setNotice,
    paused,
    setPaused,
    createInvitation,
    acceptInvitation,
  };
}

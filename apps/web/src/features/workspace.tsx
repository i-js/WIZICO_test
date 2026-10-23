'use client';

import { useEffect, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Command, Task, User } from '@todo/contracts';
import { useCollaboration } from './sync/use-collaboration';
import { readDraft, writeDraft, type Draft } from './sync/storage';
import { TaskRow } from './task-row';
import { QueueIssues } from './queue-issues';

const connectionLabels = {
  connecting: 'Подключаемся',
  syncing: 'Синхронизируем',
  online: 'Соединение установлено',
  offline: 'Нет соединения',
};

export function Workspace({
  user,
  onExpired,
  onLogout,
}: {
  user: User;
  onExpired: () => void;
  onLogout: () => Promise<void>;
}) {
  const collaboration = useCollaboration(user, onExpired);
  const {
    journal,
    status,
    selectedId,
    select,
    lists,
    snapshot,
    presence,
    enqueue,
    focus,
    notice,
    setNotice,
  } = collaboration;
  const [listTitle, setListTitle] = useState('');
  const [newTask, setNewTask] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [editor, setEditor] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const writeChain = useRef(Promise.resolve());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const disabled = status === 'connecting' || status === 'syncing';
  const admin = snapshot?.ownerId === user.id;
  const complete = snapshot?.tasks.filter((task) => task.completed).length ?? 0;
  const onlineUsers = new Set(presence.map((person) => person.userId));

  useEffect(() => {
    const removed =
      selectedId &&
      (journal.deletedIds.includes(selectedId) ||
        journal.queue.some(
          (item) =>
            item.command.type === 'list.delete' &&
            item.command.listId === selectedId &&
            item.status === 'pending',
        ));
    if ((!selectedId || removed) && lists[0]) select(lists[0].id);
  }, [lists, selectedId, select, journal]);
  useEffect(() => {
    let tabId = sessionStorage.getItem('todo-tab');
    if (!tabId) {
      tabId = crypto.randomUUID();
      sessionStorage.setItem('todo-tab', tabId);
    }
    const key = `${user.id}:${tabId}`;
    setDraftKey(key);
    let alive = true;
    void readDraft(key)
      .then((value) => {
        if (alive && value) setEditor(value);
      })
      .catch(() => setNotice('Не удалось восстановить черновик'));
    setInviteToken(new URLSearchParams(window.location.search).get('invite') ?? '');
    return () => {
      alive = false;
    };
  }, [user.id, setNotice]);
  useEffect(() => {
    setInviteUrl('');
    setNewTask('');
  }, [selectedId]);
  useEffect(() => {
    focus(editor && editor.listId === selectedId ? editor.taskId : null);
  }, [editor?.taskId, editor?.listId, selectedId, focus]);

  const persistEditor = (value: Draft | null) => {
    setEditor(value);
    writeChain.current = writeChain.current
      .then(() => writeDraft(draftKey, value))
      .catch(() => {
        setNotice('Не удалось сохранить черновик на устройстве');
      });
  };
  const startEdit = (task: Task) => {
    if (
      editor &&
      (editor.taskId !== task.id || editor.listId !== task.listId) &&
      !window.confirm('Заменить текущий черновик? Сначала сохраните или скопируйте нужный текст.')
    )
      return;
    if (editor?.taskId === task.id && editor.listId === task.listId) return;
    persistEditor({
      taskId: task.id,
      listId: task.listId,
      text: task.text,
      originalText: task.text,
      baseTextVersion: task.textVersion,
    });
  };
  const send = async (command: Command) => {
    setBusy(true);
    try {
      await enqueue(command);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!snapshot || !event.over || event.active.id === event.over.id) return;
    const from = snapshot.tasks.findIndex((task) => task.id === event.active.id);
    const to = snapshot.tasks.findIndex((task) => task.id === event.over?.id);
    if (from < 0 || to < 0) return;
    const ordered = arrayMove(snapshot.tasks, from, to);
    void send({
      type: 'task.move',
      listId: snapshot.id,
      commandId: crypto.randomUUID(),
      taskId: String(event.active.id),
      beforeTaskId: ordered[to + 1]?.id ?? null,
    });
  };
  const currentEditingTask = editor
    ? journal.snapshots[editor.listId]?.tasks.find((task) => task.id === editor.taskId)
    : undefined;
  const editorTaskExists = editor
    ? Boolean(
        (snapshot?.id === editor.listId &&
          snapshot.tasks.some((task) => task.id === editor.taskId)) ||
        currentEditingTask,
      )
    : false;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">✓</span> Список дел
        </a>
        <div className="sidebar-heading">
          <span className="section-label">ВАШИ СПИСКИ</span>
          <span className="count">{lists.length}</span>
        </div>
        <nav aria-label="Списки задач">
          {lists.map((list) => (
            <button
              key={list.id}
              className={`list-link ${list.id === selectedId ? 'active' : ''}`}
              onClick={() => select(list.id)}
            >
              <span className="list-symbol">▤</span>
              <span>{list.title}</span>
              {list.ownerId === user.id && (
                <span className="owner-mark" title="Вы владелец">
                  ●
                </span>
              )}
            </button>
          ))}
        </nav>
        <form
          className="new-list"
          onSubmit={(event) => {
            event.preventDefault();
            if (!listTitle.trim() || busy) return;
            const listId = crypto.randomUUID();
            void send({
              type: 'list.create',
              listId,
              commandId: crypto.randomUUID(),
              title: listTitle.trim(),
            }).then((saved) => {
              if (saved) {
                setListTitle('');
                select(listId);
              }
            });
          }}
        >
          <label className="sr-only" htmlFor="list-title">
            Название нового списка
          </label>
          <input
            id="list-title"
            placeholder="Новый список"
            maxLength={100}
            value={listTitle}
            onChange={(event) => setListTitle(event.target.value)}
            required
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="Создать список"
            disabled={busy || disabled || !listTitle.trim()}
          >
            +
          </button>
        </form>
        <div className="sidebar-bottom">
          <div className="offline-note">
            <span>↻</span>
            <p>
              Работайте в своём ритме.
              <br />
              Отправим изменения, когда связь вернётся.
            </p>
          </div>
          <div className="account">
            <span className="avatar">{user.name[0]}</span>
            <div>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Выйти"
              title="Выйти"
              onClick={() => {
                if (
                  journal.queue.length &&
                  !window.confirm(
                    'Неотправленные действия останутся на устройстве и продолжат отправку после входа в этот аккаунт. Выйти?',
                  )
                )
                  return;
                void onLogout().catch((error) => setNotice(error.message));
              }}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span className="breadcrumb">
            Пространство <span>/</span> <strong>{snapshot?.title ?? 'Ваши списки'}</strong>
          </span>
          <div className="connection-wrap">
            <span role="status" className={`connection ${status}`}>
              <span className="status-dot" />
              {connectionLabels[status]}
            </span>
            <button
              className="text-button small"
              onClick={() => collaboration.setPaused(!collaboration.paused)}
            >
              {collaboration.paused ? 'Восстановить связь' : 'Проверить офлайн'}
            </button>
          </div>
        </header>
        <div className="page-content">
          {status === 'offline' && (
            <div className="offline-banner" role="status">
              <strong>Нет соединения. Можно продолжать работу.</strong>
              <span>Действия сохраняются на устройстве. В очереди: {journal.queue.length}.</span>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Закрыть уведомление"
                onClick={() => setNotice('')}
              >
                ×
              </button>
            </div>
          )}
          {inviteToken && (
            <section className="invite-banner">
              <div>
                <strong>Вас пригласили в общий список</strong>
                <p>Примите приглашение под аккаунтом второго участника.</p>
              </div>
              <button
                className="primary"
                disabled={status !== 'online' || busy}
                onClick={() => {
                  setBusy(true);
                  void collaboration
                    .acceptInvitation(inviteToken)
                    .then((accepted) => {
                      if (accepted) {
                        setInviteToken('');
                        window.history.replaceState({}, '', '/');
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Принять приглашение
              </button>
            </section>
          )}
          <QueueIssues userId={user.id} journal={journal} notify={setNotice} />
          {editor && (
            <section className="editor-panel" aria-label="Редактор задачи">
              <div className="editor-heading">
                <strong>
                  {editorTaskExists
                    ? 'Редактирование задачи'
                    : 'Задача удалена или ещё не синхронизирована'}
                </strong>
                <span className="small muted">Черновик сохраняется на устройстве</span>
              </div>
              {!editorTaskExists && (
                <p className="error">
                  Ваш текст сохранён. Его можно скопировать или создать новую задачу.
                </p>
              )}
              {currentEditingTask && currentEditingTask.textVersion !== editor.baseTextVersion && (
                <p className="info">
                  Текст на сервере изменился. При сохранении предложим согласовать версии.
                </p>
              )}
              <label>
                Текст задачи
                <textarea
                  autoFocus
                  rows={4}
                  maxLength={2000}
                  value={editor.text}
                  disabled={busy}
                  onChange={(event) => persistEditor({ ...editor, text: event.target.value })}
                />
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={busy || disabled || !editor.text.trim() || !editorTaskExists}
                  onClick={() => {
                    setBusy(true);
                    const draft = editor;
                    void enqueue({
                      type: 'task.update',
                      commandId: crypto.randomUUID(),
                      listId: draft.listId,
                      taskId: draft.taskId,
                      text: draft.text,
                      expectedTextVersion: draft.baseTextVersion,
                    })
                      .then(() => persistEditor(null))
                      .catch(() => {})
                      .finally(() => setBusy(false));
                  }}
                >
                  Сохранить изменения
                </button>
                {!editorTaskExists && lists.some((list) => list.id === editor.listId) && (
                  <button
                    className="primary"
                    disabled={busy || disabled || !editor.text.trim()}
                    onClick={() => {
                      const draft = editor;
                      setBusy(true);
                      void enqueue({
                        type: 'task.create',
                        commandId: crypto.randomUUID(),
                        listId: draft.listId,
                        taskId: crypto.randomUUID(),
                        text: draft.text,
                      })
                        .then(() => persistEditor(null))
                        .catch(() => {})
                        .finally(() => setBusy(false));
                    }}
                  >
                    Создать новую задачу
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(editor.text)
                      .then(() => setNotice('Черновик скопирован'))
                      .catch(() => setNotice('Выделите текст и скопируйте его вручную'));
                  }}
                >
                  Скопировать
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    if (window.confirm('Закрыть редактор и удалить этот черновик?'))
                      persistEditor(null);
                  }}
                >
                  Закрыть черновик
                </button>
              </div>
            </section>
          )}
          {snapshot ? (
            <>
              <section className="list-heading">
                <div>
                  <span className="eyebrow">МАЛЕНЬКИЕ ШАГИ, ОБЩИЕ ПЛАНЫ</span>
                  <h1>{snapshot.title}</h1>
                  <p className="muted">Всё важное — в одном месте.</p>
                </div>
                <div className="list-buttons">
                  {admin && (
                    <button
                      className="secondary"
                      disabled={status !== 'online' || busy || snapshot.members.length >= 2}
                      onClick={() => {
                        setBusy(true);
                        void collaboration
                          .createInvitation(snapshot.id)
                          .then((url) => {
                            if (url) setInviteUrl(url);
                          })
                          .finally(() => setBusy(false));
                      }}
                    >
                      + Пригласить участника
                    </button>
                  )}
                  {admin && (
                    <button
                      className="icon-button danger"
                      title="Удалить список"
                      aria-label="Удалить список"
                      disabled={busy || disabled}
                      onClick={() => {
                        if (window.confirm(`Удалить список «${snapshot.title}» и все его задачи?`))
                          void send({
                            type: 'list.delete',
                            commandId: crypto.randomUUID(),
                            listId: snapshot.id,
                            expectedRevision: snapshot.revision,
                          });
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </section>
              {inviteUrl && (
                <section className="share-link">
                  <label>
                    Одноразовая ссылка, действует 24 часа
                    <input
                      aria-label="Ссылка приглашения"
                      value={inviteUrl}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  <button
                    className="secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(inviteUrl)
                        .then(() => setNotice('Ссылка скопирована'))
                        .catch(() => setNotice('Выделите и скопируйте ссылку вручную'));
                    }}
                  >
                    Скопировать
                  </button>
                </section>
              )}
              <section className="list-overview">
                <div className="progress-block">
                  <div>
                    <strong>
                      {complete} из {snapshot.tasks.length}
                    </strong>
                    <span>задач выполнено</span>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${snapshot.tasks.length ? (complete / snapshot.tasks.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="members">
                  {snapshot.members.map((member) => (
                    <div className="member" key={member.id}>
                      <span className={`avatar ${member.id === user.id ? '' : 'alternate'}`}>
                        {member.name[0]}
                        {onlineUsers.has(member.id) && <i />}
                      </span>
                      <div>
                        <strong>
                          {member.name}
                          {member.id === user.id ? ' · вы' : ''}
                        </strong>
                        <span>
                          {member.id === snapshot.ownerId ? 'Владелец' : 'Участник'} ·{' '}
                          {onlineUsers.has(member.id) ? 'онлайн' : 'не в сети'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="tasks-panel">
                <div className="tasks-heading">
                  <h2>
                    Задачи <span className="count">{snapshot.tasks.length}</span>
                  </h2>
                  <span className="muted small">Порядок меняется перетаскиванием</span>
                </div>
                <form
                  className="new-task"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newTask.trim() || busy) return;
                    void send({
                      type: 'task.create',
                      commandId: crypto.randomUUID(),
                      listId: snapshot.id,
                      taskId: crypto.randomUUID(),
                      text: newTask.trim(),
                    }).then((saved) => {
                      if (saved) setNewTask('');
                    });
                  }}
                >
                  <span className="add-symbol">+</span>
                  <label className="sr-only" htmlFor="task-text">
                    Новая задача
                  </label>
                  <input
                    id="task-text"
                    value={newTask}
                    maxLength={2000}
                    onChange={(event) => setNewTask(event.target.value)}
                    placeholder="Что нужно сделать?"
                    required
                  />
                  <button
                    className="primary"
                    type="submit"
                    disabled={busy || disabled || !newTask.trim()}
                  >
                    Добавить
                  </button>
                </form>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={dragEnd}
                >
                  <SortableContext
                    items={snapshot.tasks.map((task) => task.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="task-list">
                      {snapshot.tasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          user={user}
                          list={snapshot}
                          presence={presence}
                          pending={journal.queue.some(
                            (item) => 'taskId' in item.command && item.command.taskId === task.id,
                          )}
                          disabled={busy || disabled}
                          onEdit={() => startEdit(task)}
                          onComplete={() => {
                            void send({
                              type: 'task.complete',
                              commandId: crypto.randomUUID(),
                              listId: snapshot.id,
                              taskId: task.id,
                              completed: !task.completed,
                            });
                          }}
                          onDelete={() => {
                            const editing = presence.some(
                              (person) => person.userId !== user.id && person.taskId === task.id,
                            );
                            if (
                              window.confirm(
                                `Удалить задачу «${task.text}»?${task.completed ? ' Задача выполнена.' : ''}${editing ? ' Её редактирует другой участник.' : ''}`,
                              )
                            )
                              void send({
                                type: 'task.delete',
                                commandId: crypto.randomUUID(),
                                listId: snapshot.id,
                                taskId: task.id,
                                expectedVersion: task.version,
                                confirmCompleted: task.completed,
                                confirmEditing: editing,
                              });
                          }}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                </DndContext>
                {snapshot.tasks.length === 0 && (
                  <div className="empty-tasks">
                    <span>✓</span>
                    <h3>Место для ваших планов</h3>
                    <p>Добавьте первую задачу — начнём с малого.</p>
                  </div>
                )}
                <footer className="tasks-footer">
                  <span>
                    {journal.queue.length
                      ? `В очереди действий: ${journal.queue.length}`
                      : 'Все изменения сохранены'}
                  </span>
                  <span>Вы — {admin ? 'владелец' : 'участник'}</span>
                </footer>
              </section>
            </>
          ) : (
            <section className="empty-space">
              <span className="empty-icon">▤</span>
              <h1>{lists.length ? 'Откройте список' : 'Создайте список дел'}</h1>
              <p>Создайте список в меню слева и пригласите второго участника.</p>
              {status === 'offline' && <p>Ранее открытые списки доступны без соединения.</p>}
            </section>
          )}
          <p className="page-footnote">Сделанное вместе становится проще.</p>
        </div>
      </main>
    </div>
  );
}

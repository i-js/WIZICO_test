'use client';

import { useState } from 'react';
import type { Command } from '@todo/contracts';
import {
  issueQueueVersion,
  latestQueuedText,
  resolveQueuedIssue,
  taskFor,
  type Journal,
  type QueueItem,
} from './sync/model';
import { mutateJournal } from './sync/storage';

export function QueueIssues({
  userId,
  journal,
  notify,
}: {
  userId: string;
  journal: Journal;
  notify: (message: string) => void;
}) {
  return (
    <div className="queue-issues">
      {journal.queue
        .filter((item) => item.status === 'blocked')
        .map((item) => (
          <Issue
            key={item.command.commandId}
            userId={userId}
            journal={journal}
            item={item}
            notify={notify}
          />
        ))}
    </div>
  );
}
function Issue({
  userId,
  journal,
  item,
  notify,
}: {
  userId: string;
  journal: Journal;
  item: QueueItem;
  notify: (message: string) => void;
}) {
  const { command, failure } = item;
  const draft = latestQueuedText(journal, command);
  const queueVersion = issueQueueVersion(journal, command.commandId);
  const [edit, setEdit] = useState<{
    text: string;
    queueVersion: string;
    textVersion: number;
  } | null>(null);
  const text = edit?.text ?? draft;
  const newerEdits = edit !== null && edit.queueVersion !== queueVersion;
  const [busy, setBusy] = useState(false);
  const task = taskFor(journal, command);
  const currentList = journal.snapshots[command.listId];
  const retry = async (replacement?: Command) => {
    setBusy(true);
    try {
      let resolved = false;
      await mutateJournal(userId, (journal) => {
        resolved = resolveQueuedIssue(journal, command.commandId, queueVersion, replacement);
      });
      if (!resolved)
        notify('Очередь изменилась в другой вкладке. Проверьте новые правки и повторите');
    } catch {
      notify('Не удалось обновить очередь. Повторите попытку');
    } finally {
      setBusy(false);
    }
  };
  const canMerge = command.type === 'task.update' && failure?.code === 'CONFLICT' && task;
  return (
    <section className="issue" role="alert">
      <div className="section-label">НУЖНО ВАШЕ РЕШЕНИЕ</div>
      <strong>{failure?.message ?? 'Действие требует проверки'}</strong>
      <p className="muted small">
        Изменения этого списка ожидают решения. Другие списки продолжают синхронизироваться.
      </p>
      {canMerge ? (
        <div className="merge-fields">
          <label>
            Текст на сервере
            <textarea value={task.text} readOnly rows={3} />
          </label>
          <label>
            Ваш согласованный текст
            <textarea
              value={text}
              onChange={(event) =>
                setEdit({
                  text: event.target.value,
                  queueVersion: edit?.queueVersion ?? queueVersion,
                  textVersion: edit?.textVersion ?? task.textVersion,
                })
              }
              rows={3}
              maxLength={2000}
            />
          </label>
          {newerEdits && (
            <div role="status">
              <p>В очереди появились новые правки. Ваш согласованный текст сохранён в этом поле.</p>
              <pre>{draft}</pre>
              <button className="secondary" onClick={() => setEdit(null)} disabled={busy}>
                Использовать последний текст из очереди
              </button>
              <button
                className="secondary"
                onClick={() => {
                  if (edit) setEdit({ ...edit, queueVersion });
                }}
                disabled={busy}
              >
                Продолжить с моим текстом
              </button>
            </div>
          )}
        </div>
      ) : draft ? (
        <div className="saved-text">
          <span>Сохранённый текст:</span>
          <pre>{draft}</pre>
        </div>
      ) : null}
      <div className="button-row">
        {canMerge && (
          <button
            className="primary"
            disabled={busy || newerEdits || !text.trim()}
            onClick={() => {
              void retry({
                type: 'task.update',
                commandId: crypto.randomUUID(),
                listId: command.listId,
                taskId: task.id,
                text: text.trim(),
                expectedTextVersion: edit?.textVersion ?? task.textVersion,
              });
            }}
          >
            Сохранить согласованный текст
          </button>
        )}
        {failure?.code === 'TASK_DELETED' && currentList && draft && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              void retry({
                type: 'task.create',
                commandId: crypto.randomUUID(),
                listId: command.listId,
                taskId: crypto.randomUUID(),
                text: draft,
              });
            }}
          >
            Создать новую задачу с этим текстом
          </button>
        )}
        {command.type === 'task.delete' &&
          task &&
          (failure?.code === 'CONFIRMATION_REQUIRED' || failure?.code === 'CONFLICT') && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Удалить задачу «${task.text}»?${task.completed ? ' Она выполнена.' : ''}${failure.details?.editing ? ' Её редактирует другой участник.' : ''}`,
                  )
                )
                  void retry({
                    ...command,
                    commandId: crypto.randomUUID(),
                    expectedVersion: task.version,
                    confirmCompleted: true,
                    confirmEditing: true,
                  });
              }}
            >
              Проверил, подтвердить удаление
            </button>
          )}
        {command.type === 'list.delete' && currentList && failure?.code === 'CONFLICT' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Удалить обновлённый список «${currentList.title}» со всеми задачами?`,
                )
              )
                void retry({
                  ...command,
                  commandId: crypto.randomUUID(),
                  expectedRevision: currentList.revision,
                });
            }}
          >
            Подтвердить удаление обновлённого списка
          </button>
        )}
        {draft && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void navigator.clipboard
                .writeText(draft)
                .then(() => notify('Текст скопирован'))
                .catch(() => notify('Выделите и скопируйте сохранённый текст вручную'));
            }}
          >
            Скопировать текст
          </button>
        )}
        <button
          className="secondary danger"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                'Отбросить это действие и зависимые изменения этой задачи? При действии над списком будут отброшены последующие изменения списка. Сначала скопируйте нужный текст.',
              )
            )
              void retry();
          }}
        >
          Отбросить действие и зависимые изменения
        </button>
      </div>
    </section>
  );
}

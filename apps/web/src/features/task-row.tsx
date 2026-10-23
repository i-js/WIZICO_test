'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Presence, Snapshot, Task, User } from '@todo/contracts';

export function TaskRow({
  task,
  user,
  list,
  presence,
  pending,
  disabled,
  onEdit,
  onComplete,
  onDelete,
}: {
  task: Task;
  user: User;
  list: Snapshot;
  presence: Presence[];
  pending: boolean;
  disabled: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  const editors = [
    ...new Set(
      presence
        .filter((person) => person.taskId === task.id && person.userId !== user.id)
        .map((person) => person.name),
    ),
  ];
  const author = list.members.find((member) => member.id === task.authorId)?.name ?? 'Участник';
  const canDelete = list.ownerId === user.id || (task.authorId === user.id && !task.completed);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task ${task.completed ? 'is-complete' : ''} ${isDragging ? 'is-dragging' : ''}`}
      data-testid="task-row"
    >
      <button
        className="drag-handle"
        type="button"
        aria-label={`Переместить ${task.text}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <input
        type="checkbox"
        checked={task.completed}
        onChange={onComplete}
        disabled={disabled}
        aria-label={`Выполнить ${task.text}`}
      />
      <div className="task-content">
        <button type="button" className="task-text" onClick={onEdit} disabled={disabled}>
          {task.text}
        </button>
        <div className="task-meta">
          <span>{author}</span>
          {pending && <span className="pending-label">Ожидает отправки</span>}
          {editors.length > 0 && (
            <span className="editing-label">{editors.join(', ')} редактирует</span>
          )}
        </div>
      </div>
      <div className="task-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={`Редактировать ${task.text}`}
          onClick={onEdit}
          disabled={disabled}
        >
          ✎
        </button>
        <button
          type="button"
          className="icon-button danger"
          aria-label={`Удалить ${task.text}`}
          onClick={onDelete}
          disabled={!canDelete || disabled}
          title={
            canDelete
              ? 'Удалить задачу'
              : task.authorId !== user.id
                ? 'Удалять чужие задачи может владелец'
                : 'Сначала снимите отметку выполнения'
          }
        >
          ×
        </button>
      </div>
    </li>
  );
}

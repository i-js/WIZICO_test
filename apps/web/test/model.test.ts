import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command, Snapshot, User } from '@todo/contracts';
import {
  acceptDeletion,
  acceptSnapshot,
  discardWithDependents,
  emptyJournal,
  issueQueueVersion,
  latestQueuedText,
  nextPending,
  project,
  resolveQueuedIssue,
} from '../src/features/sync/model';

const user: User = { id: 'u', name: 'User', email: 'u@example.com' };
const snapshot = (): Snapshot => ({
  id: 'list',
  title: 'List',
  ownerId: user.id,
  revision: 4,
  members: [user],
  tasks: [
    {
      id: 'a',
      listId: 'list',
      authorId: user.id,
      text: 'Original',
      completed: false,
      position: 0,
      textVersion: 1,
      version: 1,
    },
  ],
});
const edit = (commandId: string, text: string, version = 1): Command => ({
  type: 'task.update',
  commandId,
  listId: 'list',
  taskId: 'a',
  text,
  expectedTextVersion: version,
});

describe('client journal', () => {
  it('resolves the latest queued text in place and preserves subsequent completion', () => {
    const journal = emptyJournal();
    journal.queue = [
      { command: edit('conflict', 'First'), status: 'blocked' },
      { command: edit('latest', 'Latest'), status: 'pending' },
      {
        command: {
          type: 'task.complete',
          commandId: 'complete',
          listId: 'list',
          taskId: 'a',
          completed: true,
        },
        status: 'pending',
      },
      { command: { ...edit('other', 'Other'), taskId: 'b' }, status: 'pending' },
    ];
    const text = latestQueuedText(journal, journal.queue[0]!.command);
    assert.equal(text, 'Latest');
    assert.equal(
      resolveQueuedIssue(
        journal,
        'conflict',
        issueQueueVersion(journal, 'conflict'),
        edit('merged', text, 3),
      ),
      true,
    );
    assert.deepEqual(
      journal.queue.map((item) => item.command.commandId),
      ['merged', 'complete', 'other'],
    );
  });
  it('does not discard edits added by another tab after the conflict was displayed', () => {
    const journal = emptyJournal();
    journal.queue = [{ command: edit('conflict', 'First'), status: 'blocked' }];
    const displayedVersion = issueQueueVersion(journal, 'conflict');
    journal.queue.push({ command: edit('newer', 'Must survive'), status: 'pending' });
    const before = structuredClone(journal);
    assert.equal(
      resolveQueuedIssue(journal, 'conflict', displayedVersion, edit('merged', 'First')),
      false,
    );
    assert.deepEqual(journal, before);
    assert.equal(resolveQueuedIssue(journal, 'conflict', displayedVersion), false);
    assert.deepEqual(journal, before);
  });
  it('projects dependent offline edits without modifying confirmed server state', () => {
    const journal = emptyJournal();
    journal.snapshots.list = snapshot();
    journal.queue = [
      { command: edit('one', 'First'), status: 'pending' },
      { command: edit('two', 'Second', 2), status: 'pending' },
    ];
    const projected = project(journal, user);
    assert.equal(projected.list?.tasks[0]?.text, 'Second');
    assert.equal(projected.list?.tasks[0]?.textVersion, 3);
    assert.equal(journal.snapshots.list?.tasks[0]?.text, 'Original');
  });
  it('ignores older snapshots and prevents resurrection after deletion', () => {
    const journal = emptyJournal();
    acceptSnapshot(journal, snapshot());
    acceptSnapshot(journal, { ...snapshot(), revision: 2, title: 'Stale' });
    assert.equal(journal.snapshots.list?.title, 'List');
    acceptDeletion(journal, 'list');
    acceptSnapshot(journal, { ...snapshot(), revision: 99 });
    assert.equal(journal.snapshots.list, undefined);
  });
  it('blocks dependent changes in one list while allowing another list to sync', () => {
    const journal = emptyJournal();
    journal.queue = [
      { command: edit('blocked', 'A'), status: 'blocked' },
      { command: edit('dependent', 'B', 2), status: 'pending' },
      { command: { ...edit('independent', 'C'), listId: 'other' }, status: 'pending' },
    ];
    assert.equal(nextPending(journal)?.command.commandId, 'independent');
  });
  it('discards dependent operations on a task while preserving other tasks', () => {
    const journal = emptyJournal();
    journal.queue = [
      { command: edit('a1', 'A'), status: 'blocked' },
      { command: { ...edit('b1', 'B'), taskId: 'b' }, status: 'pending' },
      { command: edit('a2', 'C', 2), status: 'pending' },
    ];
    discardWithDependents(journal, 'a1');
    assert.deepEqual(
      journal.queue.map((item) => item.command.commandId),
      ['b1'],
    );
  });
  it('removes the acknowledged deletion and keeps other drafts available as blocked commands', () => {
    const journal = emptyJournal();
    journal.snapshots.list = snapshot();
    journal.queue = [
      { command: edit('draft', 'Save me'), status: 'pending' },
      {
        command: { type: 'list.delete', commandId: 'delete', listId: 'list', expectedRevision: 4 },
        status: 'pending',
      },
    ];
    acceptDeletion(journal, 'list', 'delete');
    assert.equal(journal.queue.length, 1);
    assert.equal(journal.queue[0]?.status, 'blocked');
    assert.equal(journal.queue[0]?.command.type, 'task.update');
  });
});

import { expect, test, type Page } from '@playwright/test';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Review',
  email: 'review@example.com',
};
const listId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// A browser-local fixture: no writes to the API or to other users' data.
async function conflict(page: Page) {
  await page.route('**/auth/me', (route) => route.fulfill({ json: user }));
  await page.context().routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.goto('/');
  await page.evaluate(
    async ({ user, listId, taskId }) => {
      sessionStorage.setItem(`todo-list:${user.id}`, listId);
      const request = indexedDB.open('collaborative-todo-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('journals');
        request.result.createObjectStore('drafts');
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('journals', 'readwrite');
      tx.objectStore('journals').put(
        {
          snapshots: {
            [listId]: {
              id: listId,
              title: 'Review fixture',
              ownerId: user.id,
              revision: 2,
              members: [user],
              tasks: [
                {
                  id: taskId,
                  listId,
                  authorId: user.id,
                  text: 'Server text',
                  completed: false,
                  position: 0,
                  version: 2,
                  textVersion: 2,
                },
              ],
            },
          },
          deletedIds: [],
          queue: [
            {
              command: {
                type: 'task.update',
                commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                listId,
                taskId,
                text: 'Old local edit',
                expectedTextVersion: 1,
              },
              status: 'blocked',
              failure: { ok: false, code: 'CONFLICT', message: 'Review conflict' },
            },
          ],
        },
        user.id,
      );
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { user, listId, taskId },
  );
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Ваш согласованный текст', exact: true }),
  ).toHaveValue('Old local edit');
}

async function addNewerEdit(page: Page) {
  await page.getByRole('button', { name: 'Редактировать Server text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Текст задачи', exact: true }).fill('Newest local edit');
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Текст задачи', exact: true })).toHaveCount(0);
}

test('conflict resolution uses newer queued text and preserves subsequent completion', async ({
  page,
}) => {
  await conflict(page);
  await addNewerEdit(page);
  const merged = page.getByRole('textbox', { name: 'Ваш согласованный текст', exact: true });
  await expect(merged).toHaveValue('Newest local edit');
  // This list's optimistic projection is paused until its text conflict is resolved.
  await page.getByRole('checkbox', { name: 'Выполнить Server text', exact: true }).click();
  await expect(page.getByText('В очереди действий: 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить согласованный текст', exact: true }).click();
  await expect(merged).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Newest local edit', exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Выполнить Newest local edit', exact: true }),
  ).toBeChecked();
});

test('new queued edits do not overwrite a merge being typed and require an explicit choice', async ({
  page,
}) => {
  await conflict(page);
  const merged = page.getByRole('textbox', { name: 'Ваш согласованный текст', exact: true });
  await merged.fill('My manually merged text');
  await addNewerEdit(page);
  await expect(merged).toHaveValue('My manually merged text');
  await expect(
    page.getByRole('button', { name: 'Сохранить согласованный текст', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Использовать последний текст из очереди', exact: true })
    .click();
  await expect(merged).toHaveValue('Newest local edit');
  await page.getByRole('button', { name: 'Сохранить согласованный текст', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Newest local edit', exact: true })).toBeVisible();
});

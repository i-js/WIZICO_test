import { expect, test, type Browser, type Page } from '@playwright/test';

test('idle reconciliation does not reload an unchanged list snapshot', async ({ page }) => {
  const frames: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => frames.push(String(payload))),
  );
  await login(page, 'alice@example.com');
  const title = `E2E reconciliation ${Date.now()}`;
  await page.getByLabel('Название нового списка').fill(title);
  await page.getByRole('button', { name: 'Создать список', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const selectedId = await page.evaluate(() =>
    sessionStorage.getItem('todo-list:11111111-1111-4111-8111-111111111111'),
  );
  await expect
    .poll(
      () =>
        frames.filter((frame) => frame.includes('"list:join"') && frame.includes(selectedId!))
          .length,
    )
    .toBeGreaterThan(0);
  // Wait for that join's final focus message, then observe a subsequent reconciliation.
  await expect
    .poll(
      () =>
        frames.filter((frame) => frame.includes('"presence:focus"') && frame.includes(selectedId!))
          .length,
    )
    .toBeGreaterThan(0);
  frames.length = 0;
  await expect
    .poll(() => frames.filter((frame) => frame.includes('"lists:read"')).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Соединение установлено', { exact: true })).toBeVisible();
  expect(frames.filter((frame) => frame.includes('"list:join"'))).toHaveLength(0);
});

async function login(page: Page, email: string) {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill('demo-password');
  await page.getByRole('button', { name: 'Войти →', exact: true }).click();
  await expect(page.getByText('Соединение установлено', { exact: true })).toBeVisible();
}
async function pair(browser: Browser, suffix: string) {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const alice = await a.newPage();
  const bob = await b.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob]) page.on('pageerror', (error) => errors.push(error.message));
  await login(alice, 'alice@example.com');
  await login(bob, 'bob@example.com');
  const title = `E2E ${suffix} ${Date.now()}`;
  await alice.getByLabel('Название нового списка').fill(title);
  await alice.getByRole('button', { name: 'Создать список', exact: true }).click();
  await expect(alice.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(alice.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
  await alice.getByRole('button', { name: '+ Пригласить участника', exact: true }).click();
  const input = alice.getByLabel('Ссылка приглашения');
  await expect(input).toBeVisible();
  await bob.goto(await input.inputValue());
  await bob.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
  await expect(bob.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(bob.getByText('Соединение установлено', { exact: true })).toBeVisible();
  return {
    alice,
    bob,
    errors,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}
async function add(page: Page, text: string) {
  await page.getByLabel('Новая задача', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.getByRole('button', { name: text, exact: true })).toBeVisible();
}
async function edit(page: Page, text: string, replacement: string) {
  await page.getByRole('button', { name: `Редактировать ${text}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Текст задачи', exact: true }).fill(replacement);
}

test('real-time updates, member rights, presence and draft preservation on deletion', async ({
  browser,
}) => {
  const { alice, bob, errors, close } = await pair(browser, 'rights');
  try {
    await add(alice, 'Общая задача');
    await expect(bob.getByRole('button', { name: 'Общая задача', exact: true })).toBeVisible();
    await expect(
      bob.getByRole('button', { name: 'Удалить Общая задача', exact: true }),
    ).toBeDisabled();
    await add(bob, 'Задача участника');
    await bob.getByRole('checkbox', { name: 'Выполнить Задача участника', exact: true }).click();
    await expect(
      bob.getByRole('checkbox', { name: 'Выполнить Задача участника', exact: true }),
    ).toBeChecked();
    await expect(
      bob.getByRole('button', { name: 'Удалить Задача участника', exact: true }),
    ).toBeDisabled();
    await expect(
      alice.getByRole('checkbox', { name: 'Выполнить Задача участника', exact: true }),
    ).toBeChecked();
    await alice.getByRole('button', { name: 'Удалить Задача участника', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Задача участника', exact: true })).toHaveCount(0);
    await edit(bob, 'Общая задача', 'Черновик, который нельзя потерять');
    await expect(alice.getByText('Борис редактирует', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Удалить Общая задача', exact: true }).click();
    await expect(
      bob.getByText('Ваш текст сохранён. Его можно скопировать или создать новую задачу.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(bob.getByRole('textbox', { name: 'Текст задачи', exact: true })).toHaveValue(
      'Черновик, который нельзя потерять',
    );
    await bob.getByRole('button', { name: 'Создать новую задачу', exact: true }).click();
    await expect(
      alice.getByRole('button', { name: 'Черновик, который нельзя потерять', exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('simultaneous edits surface a conflict and converge after explicit resolution', async ({
  browser,
}) => {
  const { alice, bob, errors, close } = await pair(browser, 'conflict');
  try {
    await add(alice, 'Начальный текст');
    await expect(bob.getByRole('button', { name: 'Начальный текст', exact: true })).toBeVisible();
    await edit(alice, 'Начальный текст', 'Версия Алисы');
    await edit(bob, 'Начальный текст', 'Версия Бориса');
    await alice.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(
      bob.getByText('Текст на сервере изменился. При сохранении предложим согласовать версии.', {
        exact: true,
      }),
    ).toBeVisible();
    await bob.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(bob.getByRole('textbox', { name: 'Текст на сервере', exact: true })).toHaveValue(
      'Версия Алисы',
    );
    await expect(
      bob.getByRole('textbox', { name: 'Ваш согласованный текст', exact: true }),
    ).toHaveValue('Версия Бориса');
    await bob
      .getByRole('textbox', { name: 'Ваш согласованный текст', exact: true })
      .fill('Согласованный результат');
    await bob.getByRole('button', { name: 'Сохранить согласованный текст', exact: true }).click();
    for (const page of [alice, bob]) {
      await expect(
        page.getByRole('button', { name: 'Согласованный результат', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('offline dependent commands survive reload and replay in order', async ({ browser }) => {
  const { alice, bob, errors, close } = await pair(browser, 'offline');
  let blockWebSocket = true;
  try {
    await bob.getByRole('button', { name: 'Проверить офлайн', exact: true }).click();
    await expect(bob.getByText('Нет соединения', { exact: true })).toBeVisible();
    await add(bob, 'Создано без связи');
    await edit(bob, 'Создано без связи', 'Изменено без связи');
    await bob.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await bob.getByRole('checkbox', { name: 'Выполнить Изменено без связи', exact: true }).click();
    await expect(
      bob.getByRole('checkbox', { name: 'Выполнить Изменено без связи', exact: true }),
    ).toBeChecked();
    await add(bob, 'Вторая локальная задача');
    await expect(alice.getByTestId('task-row')).toHaveCount(0);
    await bob.context().routeWebSocket('**/socket.io/**', (socket) => {
      if (blockWebSocket) socket.close();
      else socket.connectToServer();
    });
    await bob.reload();
    await expect(
      bob.getByRole('button', { name: 'Изменено без связи', exact: true }),
    ).toBeVisible();
    await expect(
      bob.getByRole('checkbox', { name: 'Выполнить Изменено без связи', exact: true }),
    ).toBeChecked();
    await expect(
      bob.getByRole('button', { name: 'Вторая локальная задача', exact: true }),
    ).toBeVisible();
    blockWebSocket = false;
    await bob.getByRole('button', { name: 'Проверить офлайн', exact: true }).click();
    await bob.getByRole('button', { name: 'Восстановить связь', exact: true }).click();
    await expect(bob.getByText('Соединение установлено', { exact: true })).toBeVisible();
    await expect(
      alice.getByRole('button', { name: 'Изменено без связи', exact: true }),
    ).toBeVisible();
    await expect(
      alice.getByRole('checkbox', { name: 'Выполнить Изменено без связи', exact: true }),
    ).toBeChecked();
    await expect(alice.getByTestId('task-row')).toHaveCount(2);
    await expect(bob.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('keyboard drag-and-drop converges to the same order for both users', async ({ browser }) => {
  const { alice, bob, errors, close } = await pair(browser, 'order');
  try {
    for (const text of ['Первый', 'Второй', 'Третий']) await add(alice, text);
    await expect(bob.getByTestId('task-row')).toHaveCount(3);
    await expect(alice.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    const handle = alice.getByRole('button', { name: 'Переместить Первый', exact: true });
    const draggedRow = alice
      .getByTestId('task-row')
      .filter({ has: alice.getByRole('button', { name: 'Первый', exact: true }) });
    const nextRow = alice.getByTestId('task-row').filter({
      has: alice.getByRole('button', { name: 'Второй', exact: true }),
    });
    await alice.bringToFront();
    await handle.focus();
    await alice.keyboard.press('Space');
    await expect(draggedRow).toHaveClass(/is-dragging/);
    // KeyboardSensor installs its key listener asynchronously after activation.
    await alice.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await alice.keyboard.press('ArrowDown');
    await expect(draggedRow).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 0, [1-9]/);
    // A scroll offset alone does not mean the next row has become the drop target.
    await expect(nextRow).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 0, -[1-9]/);
    await alice.keyboard.press('Space');
    await expect(alice.getByTestId('task-row').nth(0)).toContainText('Второй');
    await expect(bob.getByTestId('task-row').nth(0)).toContainText('Второй');
    await expect(alice.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await alice.screenshot({ path: 'test-results/desktop.png', fullPage: true });
    await bob.setViewportSize({ width: 390, height: 844 });
    await bob.screenshot({ path: 'test-results/mobile.png', fullPage: true });
    expect(
      await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await close();
  }
});

test('two tabs share a durable queue without duplicating commands', async ({ browser }) => {
  const { alice, bob, errors, close } = await pair(browser, 'tabs');
  const other = await alice.context().newPage();
  other.on('dialog', (dialog) => {
    void dialog.accept();
  });
  try {
    await other.goto('/');
    await expect(other.getByText('Соединение установлено', { exact: true })).toBeVisible();
    const title = await alice.getByRole('heading', { level: 1 }).textContent();
    await other.getByRole('navigation').getByRole('button').filter({ hasText: title! }).click();
    await expect(other.getByRole('heading', { name: title!, exact: true })).toBeVisible();
    for (const page of [alice, other])
      await page.getByRole('button', { name: 'Проверить офлайн', exact: true }).click();
    await add(alice, 'Из первой вкладки');
    await expect(
      other.getByRole('button', { name: 'Из первой вкладки', exact: true }),
    ).toBeVisible();
    await add(other, 'Из второй вкладки');
    await alice.getByRole('button', { name: 'Восстановить связь', exact: true }).click();
    await expect(bob.getByTestId('task-row')).toHaveCount(2);
    for (const page of [alice, other])
      await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a list and its dependent task can be created offline and synchronized together', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, 'bob@example.com');
    await page.getByRole('button', { name: 'Проверить офлайн', exact: true }).click();
    const title = `E2E local list ${Date.now()}`;
    await page.getByLabel('Название нового списка').fill(title);
    await page.getByRole('button', { name: 'Создать список', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await add(page, 'Зависимая локальная задача');
    await page.getByRole('button', { name: 'Восстановить связь', exact: true }).click();
    await expect(page.getByText('Соединение установлено', { exact: true })).toBeVisible();
    await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Зависимая локальная задача', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

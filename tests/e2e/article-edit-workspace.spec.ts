import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mount, body } from './article-workspace-fixture';
async function returnToPool(page: Page) {
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
}

type FixtureWindow = Window & {
  workspaceLog(): Array<[string, ...unknown[]]>;
  workspaceClose(): void;
};

for (const width of [1280, 800]) {
  test(`T5 creation keeps rich tools and cover controls with focused help clear of clipping at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mount(page);
    await returnToPool(page);
    await page.getByRole('button', { name: '新建文章', exact: true }).click();
    const save = page.getByRole('button', { name: '保存到本机', exact: true });
    await expect(save).toBeDisabled();
    const help = page.getByRole('button', {
      name: '正文编辑帮助',
      exact: true,
    });
    await help.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(help).toBeFocused();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('未保存修改在关闭后丢失');
    const box = (await tip.boundingBox())!;
    const footer = (await page.locator('.workspace-footer').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
    expect(
      await tip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
    ).toBe(true);
    await expect(save).toBeDisabled();
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-editor-help-${width}.png`,
      ),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await page.getByLabel('文章标题', { exact: true }).fill('创建文章与封面');
    await body(page).fill('正文保留现有加粗、小标题、列表和引用工具。');
    await expect(
      page.getByRole('toolbar', { name: '正文格式', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '文章封面', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-creation-${width}.png`,
      ),
      fullPage: true,
    });
    await page.locator('.focused-editor-header').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-creation-top-${width}.png`,
      ),
      fullPage: true,
    });
  });

  test(`T5 normal library shows both shared pagers at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mount(page, false, false, false, false, false, 11);
    await returnToPool(page);
    const top = page.getByRole('navigation', {
      name: '文章顶部分页',
      exact: true,
    });
    const bottom = page.getByRole('navigation', {
      name: '文章分页',
      exact: true,
    });
    await top.getByRole('button', { name: '下一页' }).click();
    await bottom.getByRole('button', { name: '上一页' }).focus();
    await expect(top).toContainText('第 2 页');
    await expect(bottom).toContainText('第 2 页');
    await expect(page.locator('.workspace-footer')).toContainText('准备就绪');
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-normal-library-${width}.png`,
      ),
      fullPage: true,
    });
    await page
      .getByRole('region', { name: '文章列表', exact: true })
      .screenshot({
        path: resolve(
          `.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-both-pagers-${width}.png`,
        ),
      });
  });
}

test('UI01 article precedes accessible mode workspace and one shared browser survives keyboard switches', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  const article = page.getByRole('region', { name: '文章', exact: true });
  const tabs = page.getByRole('tablist', { name: '存草稿方式' });
  const panel = page.getByRole('tabpanel');
  const browser = page.getByRole('region', { name: '专用浏览器', exact: true });
  await expect(article).toBeVisible();
  await expect(browser).toHaveCount(1);
  await expect(panel).toHaveAccessibleName('单篇存草稿');
  expect(
    await article.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(
            document.querySelector('[role=tablist]')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  expect(
    await tabs.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(
            document.querySelector('[role=tabpanel]')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  expect(
    await panel.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(
            document.querySelector('.browser-module')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: '单篇存草稿', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel).toHaveAccessibleName('批量存草稿');
  await expect(
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
  ).toBeHidden();
  await expect(
    browser.getByRole('button', { name: '检查登录状态' }),
  ).toHaveCount(1);
  await page.keyboard.press('Home');
  await expect(panel).toHaveAccessibleName('单篇存草稿');
});

test('UI04 batch cover opens the correct target in its workspace and dirty mode switches retain one editor', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 文章2', exact: true }).check();
  await page
    .getByRole('button', { name: '配置封面：文章2', exact: true })
    .click();
  const panel = page.getByRole('tabpanel');
  const cover = panel.getByRole('region', { name: '封面图片', exact: true });
  await expect(panel).toHaveAccessibleName('批量存草稿');
  await expect(
    panel.getByText('当前封面文章：文章2', { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: '关闭封面编辑区', exact: true })
    .click();
  await expect(cover).toBeHidden();
  await page
    .getByRole('button', { name: '配置封面：文章2', exact: true })
    .click();
  await cover.getByRole('button', { name: '编辑封面', exact: true }).click();
  await cover.getByRole('radio', { name: '单图', exact: true }).check();
  await expect(
    panel.getByRole('checkbox', { name: '全选新尝试', exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('checkbox', { name: '第1篇作为新尝试' }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole('region', { name: '全局操作状态' })
      .getByRole('button', { name: '停止并初始化', exact: true }),
  ).toBeEnabled();
  const sessionId = await page.evaluate(
    () => Reflect.get(window, 'coverFixture').state().sessionId,
  );
  await cover.evaluate((el) => Reflect.set(el, 'stableCover', true));
  await page.getByRole('tab', { name: '单篇存草稿', exact: true }).click();
  await expect(
    cover.getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  expect(await cover.evaluate((el) => Reflect.get(el, 'stableCover'))).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'coverFixture').state().sessionId,
    ),
  ).toBe(sessionId);
  await panel
    .getByRole('button', { name: '关闭封面编辑区', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: '离开封面编辑？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(
    cover.getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
  await page.getByRole('checkbox', { name: '选择 文章1', exact: true }).check();
  await page
    .getByRole('button', { name: '配置封面：文章1', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: '离开封面编辑？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(
    panel.getByText('当前封面文章：文章2', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '配置封面：文章1', exact: true })
    .click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(
    panel.getByText('当前封面文章：文章1', { exact: true }),
  ).toBeVisible();
});

async function installModeExecutionBridge(page: Page) {
  await page.evaluate(() => {
    const api = window.desktopApi;
    const read = api.getDraftState,
      prepare = api.prepareDraft,
      start = api.startDraft;
    let task: import('../../src/contracts/draft-task').TaskView | null = null;
    let current: import('../../src/contracts/draft-batch').BatchView | null =
      null;
    let batchPreparation:
      import('../../src/contracts/draft-batch').BatchPreparationView | null =
      null;
    let singlePreparation:
      import('../../src/contracts/draft-task').PreparationView | null = null;
    let active = 0,
      maximum = 0;
    const starts: Array<{
      mode: string;
      preparationId: string;
      taskId: string;
    }> = [];
    const begin = (
      mode: string,
      preparationId: string,
      articleKey: string,
      title: string,
    ) => {
      active++;
      maximum = Math.max(maximum, active);
      const next = {
        taskId: crypto.randomUUID(),
        articleKey,
        title,
        storeName: '测试门店',
        state: 'running' as const,
        stage: 'body' as const,
        revision: 1,
        possibleRemoteEffect: true,
        stopRequested: false,
        platformPaused: false,
        reason: null,
        canOpenDraft: false,
      };
      starts.push({ mode, preparationId, taskId: next.taskId });
      task = next;
      return next;
    };
    api.getDraftState = async () => ({ ...(await read()), task });
    api.prepareDraft = async (...args) => {
      if (active) return { status: 'blocked', reason: 'PLATFORM_BUSY' };
      const result = await prepare(...args);
      if (result.status === 'ready') singlePreparation = result.preparation;
      return result;
    };
    api.startDraft = async (id) => {
      if (active || singlePreparation?.preparationId !== id)
        return {
          status: 'blocked',
          reason: active ? 'PLATFORM_BUSY' : 'STALE_PREPARATION',
          view: await api.getDraftState(),
        };
      const result = await start(id);
      if (result.status === 'ok') {
        result.view.task = begin(
          'single',
          id,
          singlePreparation.articleKey,
          singlePreparation.title,
        );
        singlePreparation = null;
      }
      return result;
    };
    api.batch.getCurrent = async () => structuredClone(current);
    api.batch.prepare = async (input) => {
      if (active) return { status: 'blocked', reason: 'PLATFORM_BUSY' };
      batchPreparation = {
        preparationId: crypto.randomUUID(),
        storeName: '测试门店',
        items: input.articleKeys.map((articleKey) => ({
          articleKey,
          title: articleKey.startsWith('1111') ? '文章1' : '文章2',
          contentDeclaration: 'repost',
          coverSummary: { mode: 'none', imageCount: 0, images: [] },
          state: 'queued',
          reason: null,
          taskId: null,
        })),
      };
      return {
        status: 'ready',
        preparation: structuredClone(batchPreparation),
      };
    };
    api.batch.start = async ({ preparationId }) => {
      if (active || batchPreparation?.preparationId !== preparationId)
        return {
          status: 'blocked',
          reason: active ? 'PLATFORM_BUSY' : 'STALE_PREPARATION',
          view: structuredClone(current),
        };
      const item = batchPreparation.items[0];
      const next = begin('batch', preparationId, item.articleKey, item.title);
      current = {
        id: crypto.randomUUID(),
        revision: 1,
        state: 'running',
        storeName: '测试门店',
        stopRequested: false,
        reason: null,
        counts: {
          total: 1,
          attempted: 0,
          saved: 0,
          failed: 0,
          skipped: 0,
          pending: 1,
          needsHuman: 0,
          stopped: 0,
        },
        items: [{ ...item, taskId: next.taskId, state: 'running' }],
      };
      batchPreparation = null;
      return { status: 'ok', view: structuredClone(current) };
    };
    Object.assign(window, {
      modeFixture: {
        state: () => ({ active, maximum, starts: structuredClone(starts) }),
        release: () => {
          active = 0;
          if (task)
            task = {
              ...task,
              revision: 2,
              state: 'submission_recorded',
              stage: 'settled',
              submission: {
                observation: 'acknowledged',
                attemptedAt: new Date().toISOString(),
              },
            };
          if (current?.state === 'running')
            current = {
              ...current,
              revision: 2,
              state: 'completed',
              counts: { ...current.counts, attempted: 1, pending: 0 },
              items: current.items.map((item) => ({
                ...item,
                state: 'submission_recorded',
                submission: {
                  observation: 'acknowledged',
                  attemptedAt: new Date().toISOString(),
                },
              })),
            };
        },
      },
    });
  });
}

test('L06 single batch single execute only after fresh confirmations and keep one writer across mode switches', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await installModeExecutionBridge(page);
  const single = page.getByRole('tab', { name: '单篇存草稿', exact: true });
  const batch = page.getByRole('tab', { name: '批量存草稿', exact: true });
  const singleStart = page.getByRole('button', {
    name: '存到巨懂车草稿',
    exact: true,
  });
  const prepareSingle = page.getByRole('button', {
    name: '检查文章摘要',
    exact: true,
  });
  await prepareSingle.click();
  await expect(singleStart).toBeDisabled();
  await page
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await singleStart.click();
  await batch.click();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'modeFixture').release());
  await page.getByRole('checkbox', { name: '选择 文章1', exact: true }).check();
  const prepareBatch = page.getByRole('button', { name: '检查批量草稿摘要' });
  await expect(prepareBatch).toBeEnabled();
  await prepareBatch.click();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeEnabled();
  await single.click();
  await batch.click();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
  await prepareBatch.click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await single.click();
  await expect(prepareSingle).toBeDisabled();
  await expect(singleStart).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'modeFixture').release());
  await expect(prepareSingle).toBeEnabled();
  await prepareSingle.click();
  await expect(singleStart).toBeDisabled();
  await page
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await singleStart.click();
  const result = await page.evaluate(() =>
    Reflect.get(window, 'modeFixture').state(),
  );
  expect(result.starts.map((entry: { mode: string }) => entry.mode)).toEqual([
    'single',
    'batch',
    'single',
  ]);
  expect(
    new Set(
      result.starts.map(
        (entry: { preparationId: string }) => entry.preparationId,
      ),
    ).size,
  ).toBe(3);
  expect(
    new Set(result.starts.map((entry: { taskId: string }) => entry.taskId))
      .size,
  ).toBe(3);
  expect(result.maximum).toBe(1);
  await page.evaluate(() => Reflect.get(window, 'modeFixture').release());
});

test('L06 switching modes retires a previously checked single summary', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await expect(
    page.getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeEnabled();
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await page.getByRole('tab', { name: '单篇存草稿', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (entry: unknown[]) => entry[0] === 'start',
    ),
  ).toHaveLength(0);
});
test('save_then_delete_refresh_revision and title after editor settlement', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('保存后的新标题');
  await page.evaluate(() => {
    const original = window.desktopApi.listArticles;
    let calls = 0;
    Object.assign(window.desktopApi, {
      listArticles: async () => {
        const result = structuredClone(await original());
        if (++calls === 1)
          await new Promise<void>((resolve) =>
            Object.assign(window, { releaseOldList: resolve }),
          );
        return result;
      },
    });
  });
  await returnToPool(page);
  await expect(
    page.getByRole('dialog', { name: '离开当前编辑？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.evaluate(() => Reflect.get(window, 'releaseOldList')());
  await page
    .getByRole('button', { name: '删除 保存后的新标题', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '从本机删除文章？' });
  await expect(dialog).toContainText('保存后的新标题');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.getByText('本机文章共 1 篇', { exact: true }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((l) => l[0] === 'delete')).toEqual([
    ['delete', expect.objectContaining({ expectedArticleRevision: 2 })],
  ]);
  await expect(body(page)).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, 'releaseOldList')());
  await expect(
    page.getByText('本机文章共 1 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
  ).toBeDisabled();
});

test('delete settlement keep editing preserves unsaved document and never opens confirmation', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await body(page).fill('不能丢失的修改');
  await returnToPool(page);
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(body(page)).toHaveText('不能丢失的修改');
  await expect(
    page.getByRole('dialog', { name: '从本机删除文章？' }),
  ).toHaveCount(0);
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).workspaceLog(),
      )
    ).filter((l) => l[0] === 'delete'),
  ).toEqual([]);
});

test('save_then_delete_page_two refresh locates target after first-page editor refresh', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 11);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await page
    .getByRole('navigation', { name: '文章分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await page.getByRole('button', { name: /^文章11 文章编号/ }).click();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章11');
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('第二页保存后的标题');
  await returnToPool(page);
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page
    .getByRole('button', { name: '删除 第二页保存后的标题', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '从本机删除文章？' });
  await expect(dialog).toContainText('第二页保存后的标题');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: '文章分页', exact: true })
      .getByText('第 1 页 / 共 1 页', { exact: true }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((l) => l[0] === 'delete')).toEqual([
    [
      'delete',
      expect.objectContaining({
        articleKey: '11111111-1111-4111-8111-000000000011',
        expectedArticleRevision: 2,
      }),
    ],
  ]);
});
test('selection_load_is_not_blank_new_doc and platform remains mounted but hidden', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toHaveText('已保存正文1');
  await expect(body(page)).toBeEditable();
  await expect(page.getByRole('region', { name: '巨懂车草稿' })).toBeHidden();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章1');
});
for (const choice of ['继续编辑', '放弃修改', '保存并继续'])
  test('dirty_switch_' + choice, async ({ page }) => {
    await mount(page);
    await expect(body(page)).toBeEditable();
    await body(page).fill('改过正文');
    await returnToPool(page);
    await expect(
      page.getByRole('dialog', { name: '离开当前编辑？' }),
    ).toBeVisible();
    await page.getByRole('button', { name: choice, exact: true }).click();
    if (choice !== '继续编辑')
      await page.getByRole('button', { name: /文章2 文章编号/ }).click();
    await expect(body(page)).toHaveText(
      choice === '继续编辑' ? '改过正文' : '已保存正文2',
    );
    const logs = await page.evaluate(() =>
      (window as unknown as FixtureWindow).workspaceLog(),
    );
    expect(logs.filter((v) => v[0] === 'save')).toHaveLength(
      choice === '保存并继续' ? 1 : 0,
    );
    expect(logs.filter((v) => v[0] === 'open')).toHaveLength(
      choice === '继续编辑' ? 1 : 2,
    );
  });
test('invalid_local_input_can_explicitly_discard before switching', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('长'.repeat(513));
  await returnToPool(page);
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(body(page)).toHaveText('已保存正文2');
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'edit')).toHaveLength(0);
});
test('lost_save_reply_blocks_navigation', async ({ page }) => {
  await mount(page, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('保留未知修改');
  await returnToPool(page);
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(body(page)).toHaveText('保留未知修改');
  await expect(body(page)).not.toBeEditable();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'open')).toHaveLength(1);
  expect(logs.filter((v) => v[0] === 'close')).toHaveLength(0);
});
test('summary saves chosen edits then closes before preparing actual version', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await body(page).fill('用于草稿的修改');
  await returnToPool(page);
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'prepare')).toEqual([
    ['prepare', '11111111-1111-4111-8111-111111111111', 2, 'idle'],
  ]);
});
test('composition_close_wait before selection handover', async ({ page }) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await body(page).dispatchEvent('compositionstart');
  await body(page).fill('最终中文😀');
  await returnToPool(page);
  await page.waitForTimeout(150);
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).workspaceLog(),
      )
    ).filter((v) => v[0] === 'close'),
  ).toHaveLength(0);
  await body(page).dispatchEvent('compositionend');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(body(page)).toHaveText('已保存正文2');
});

test('native close waits for delayed save then responds on the same settled session', async ({
  page,
}) => {
  await mount(page, false, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('保存期间关闭');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceClose(),
  );
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (window as unknown as FixtureWindow).workspaceLog(),
          )
        ).filter((v) => v[0] === 'native').length,
    )
    .toBe(1);
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.findIndex((v) => v[0] === 'native')).toBeGreaterThan(
    logs.findIndex((v) => v[0] === 'save-settled'),
  );
});
test('native unknown save withholds blocked discard eligibility', async ({
  page,
}) => {
  await mount(page, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('保存结果未知');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(body(page)).not.toBeEditable();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceClose(),
  );
  await page.waitForTimeout(700);
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'native')).toHaveLength(0);
  expect(logs.filter((v) => v[0] === 'save')).toHaveLength(1);
});
test('native settled oversized local input responds blocked without applying or saving', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('长'.repeat(513));
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceClose(),
  );
  await expect
    .poll(async () =>
      (
        await page.evaluate(() =>
          (window as unknown as FixtureWindow).workspaceLog(),
        )
      ).filter((v) => v[0] === 'native'),
    )
    .toEqual([['native', 'blocked']]);
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).workspaceLog(),
      )
    ).filter((v) => ['edit', 'save'].includes(v[0])),
  ).toHaveLength(0);
});
test('proved formal save conflict permits only discard and explicit reopen', async ({
  page,
}) => {
  await mount(page, false, false, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('保留冲突正文');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(body(page)).not.toBeEditable();
  await returnToPool(page);
  await expect(
    page.getByRole('button', { name: '保存并继续', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(body(page)).toHaveText('已保存正文2');
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'lookup')).not.toHaveLength(0);
  expect(logs.filter((v) => v[0] === 'save')).toHaveLength(1);
});
test('native unresolved document ACK withholds discard eligibility', async ({
  page,
}) => {
  await mount(page, false, false, false, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('未获确认正文');
  await expect(body(page)).not.toBeEditable();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceClose(),
  );
  await page.waitForTimeout(700);
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'native')).toHaveLength(0);
  expect(logs.filter((v) => v[0] === 'close')).toHaveLength(0);
  await expect(body(page)).toHaveText('未获确认正文');
});
test('mismatched conflict operation proof never enables discard navigation', async ({
  page,
}) => {
  await mount(page, false, false, true, false, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('待核对冲突正文');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(body(page)).not.toBeEditable();
  await expect(
    page.getByRole('button', { name: '返回文章池', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'close')).toHaveLength(0);
  expect(logs.filter((v) => v[0] === 'open')).toHaveLength(1);
});
test('both title and body compositions settle before summary handover and newest save', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  const title = page.getByLabel('文章标题');
  await title.dispatchEvent('compositionstart');
  await body(page).dispatchEvent('compositionstart');
  await title.fill('完整标题😀');
  await body(page).fill('完整正文😀');
  await returnToPool(page);
  await body(page).dispatchEvent('compositionend');
  await page.waitForTimeout(100);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await title.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  const edit = logs.filter((v) => v[0] === 'edit').at(-1);
  expect(edit?.[1]).toMatchObject({
    title: '完整标题😀',
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '完整正文😀', marks: [] }],
      },
    ],
  });
  expect(logs.filter((v) => v[0] === 'save')).toHaveLength(1);
});
test('800x600 workspace exposes body and local save controls without a second clipped editor pane', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.setViewportSize({ width: 800, height: 600 });
  const pane = page.locator('.editor-view');
  expect(
    await pane.evaluate((node) => node.scrollHeight <= node.clientHeight),
  ).toBe(true);
  await page
    .getByRole('button', { name: '保存修改', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: '保存修改', exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: resolve('.tmp/article-workspace-800.png'),
    fullPage: true,
  });
});
for (const declaration of ['original', 'repost'] as const) {
  test(`T5 legacy ${declaration} article remains editable and preserves metadata without declaration controls`, async ({
    page,
  }) => {
    await mount(
      page,
      false,
      false,
      false,
      false,
      false,
      2,
      {},
      undefined,
      declaration,
    );
    await expect(body(page)).toBeEditable();
    await expect(page.getByLabel('文章声明', { exact: true })).toHaveCount(0);
    await page
      .getByLabel('文章标题', { exact: true })
      .fill(`旧文章 ${declaration}`);
    await body(page).fill('兼容正文修改');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.locator('.editor-save-status')).toHaveText(
      '已保存到本机',
    );
    const persisted = await page.evaluate(async () => {
      const list = await window.desktopApi.listArticles();
      if (list.status !== 'ok') throw Error('list');
      return window.desktopApi.getArticlePreview(list.page.items[0].articleKey);
    });
    expect(persisted).toMatchObject({
      status: 'ok',
      article: {
        title: `旧文章 ${declaration}`,
        contentDeclaration: declaration,
        body: [{ type: 'paragraph', text: '兼容正文修改' }],
      },
    });
    const edits = await page.evaluate(() =>
      Reflect.get(window, 'workspaceLog')().filter(
        (entry: unknown[]) => entry[0] === 'edit',
      ),
    );
    expect(edits.at(-1)[1].contentDeclaration).toBe(declaration);
    await returnToPool(page);
    await expect(page.locator('.library-view')).not.toContainText(
      /原创|转载|本地声明/,
    );
    await page.getByRole('button', { name: '检查文章摘要' }).click();
    await expect(
      page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '巨懂车草稿', exact: true }),
    ).not.toContainText(/原创|转载|本地声明/);
    await page
      .getByRole('button', {
        name: new RegExp(`^旧文章 ${declaration} 文章编号`),
      })
      .click();
    await expect(body(page)).toBeEditable();
    const state = await page.evaluate(() =>
      Reflect.get(window, 'workspaceState')(),
    );
    expect(state.draft.contentDeclaration).toBe(declaration);
  });
}

test('single and batch pages keep separate start controls and a stop-only fixed footer', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  const single = page.getByRole('tab', { name: '单篇存草稿', exact: true });
  const batch = page.getByRole('tab', { name: '批量存草稿', exact: true });
  await expect(single).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeHidden();
  await batch.click();
  await expect(batch).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeVisible();
  const footer = page.getByRole('region', { name: '全局操作状态' });
  await expect(footer.getByRole('button')).toHaveCount(1);
  await expect(
    footer.getByRole('button', { name: /停止并初始化/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 600 });
  const box = await footer.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  await single.click();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeHidden();
});

test('stop initialization clears this selection while retaining local articles and allowing a new summary', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  const storedCover = await page.evaluate(async () => {
    const key = '11111111-1111-4111-8111-111111111111';
    Reflect.get(window, 'coverFixture').configure(key, 'single', 1);
    return window.desktopApi.getArticleCover(key);
  });
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 文章1', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 文章2', exact: true }).check();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章1', exact: true }),
  ).toBeChecked();
  await page
    .getByRole('region', { name: '全局操作状态' })
    .getByRole('button', { name: /停止并初始化/ })
    .click();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章1', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章2', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByText('本机文章共 2 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('已停止并初始化');
  expect(
    await page.evaluate(() =>
      window.desktopApi.getArticleCover('11111111-1111-4111-8111-111111111111'),
    ),
  ).toEqual(storedCover);
  await page.getByRole('tab', { name: '单篇存草稿', exact: true }).click();
  await page.getByRole('button', { name: /文章1 文章编号/ }).click();
  await expect(body(page)).toBeEditable();
  await expect(body(page)).toContainText('已保存正文1');
  await returnToPool(page);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  await page
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page
    .getByRole('button', { name: '存到巨懂车草稿', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() => Reflect.get(window, 'workspaceLog')())
        ).filter((e: unknown[]) => e[0] === 'start').length,
    )
    .toBe(1);
});

test('one summary click settles a clean editing session and prepares without requiring a second click', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  await expect(body(page)).toHaveCount(0);
  const logs = await page.evaluate(() => Reflect.get(window, 'workspaceLog')());
  expect(logs.filter((entry: unknown[]) => entry[0] === 'prepare')).toEqual([
    ['prepare', '11111111-1111-4111-8111-111111111111', 1, 'idle'],
  ]);
  expect(
    logs.findIndex((entry: unknown[]) => entry[0] === 'prepare'),
  ).toBeGreaterThan(logs.findIndex((entry: unknown[]) => entry[0] === 'close'));
});
test('actual content edits while summary handover waits invalidate the old click and require fresh confirmation', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await returnToPool(page);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '我已核对门店和图文内容，仅存草稿' })
    .check();
  await page.getByRole('button', { name: /文章1 文章编号/ }).click();
  await expect(body(page)).toBeEditable();
  await body(page).dispatchEvent('compositionstart');
  await returnToPool(page);
  await body(page).fill('交接开始后才输入的新内容');
  await body(page).dispatchEvent('compositionend');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  const logs = await page.evaluate(() => Reflect.get(window, 'workspaceLog')());
  expect(
    logs
      .filter((entry: unknown[]) => entry[0] === 'prepare')
      .map((entry: unknown[]) => entry[2]),
  ).toEqual([1, 2]);
});

test('stop during a local save drains it and leaves retained editor resolution usable', async ({
  page,
}) => {
  await mount(page, false, true);
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('停止期间保留的新标题');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('button', { name: '停止并初始化', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('已停止并初始化');
  await page
    .getByRole('button', { name: /停止期间保留的新标题 文章编号/ })
    .click();
  await expect(page.getByLabel('文章标题')).toHaveValue('停止期间保留的新标题');
  await returnToPool(page);
  await expect(
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
  ).toBeEnabled();
});
test('15 second stopping observation keeps admission closed and identifies retained review', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.evaluate(() => {
    const view = {
      revision: 1,
      phase: 'stopping',
      owners: [{ scope: 'manual', state: 'active' }],
    };
    Object.assign(window.desktopApi, {
      requestStopAll: async () => structuredClone(view),
      getOperationControlState: async () => structuredClone(view),
    });
    Object.assign(window, { heldStopView: view });
  });
  await page.clock.install();
  await page.getByRole('button', { name: '停止并初始化', exact: true }).click();
  await page.clock.fastForward(15_001);
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('仍在停止');
  await expect(
    page.getByRole('button', {
      name: '检查文章摘要',
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await page.evaluate(() =>
    Object.assign(Reflect.get(window, 'heldStopView'), {
      revision: 2,
      phase: 'needs_review',
      owners: [{ scope: 'manual', state: 'needs_review' }],
    }),
  );
  await page.clock.fastForward(1_001);
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('正文编辑与图片');
});

test('renderer-only title at stop is retained for save and a subsequent clean stop can initialize', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').dispatchEvent('compositionstart');
  await page.getByLabel('文章标题').fill('停止前尚未同步的标题');
  await page.getByRole('button', { name: '停止并初始化', exact: true }).click();
  await page.getByLabel('文章标题').dispatchEvent('compositionend');
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('正文编辑与图片');
  await expect(page.getByLabel('文章标题')).toHaveValue('停止前尚未同步的标题');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('button', { name: '停止并初始化', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('已停止并初始化');
});

// These assertions exercise scroll geometry; removing sticky positioning, the
// history height cap, or footer compensation must fail at a real viewport.
for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  test(`UI03 UI08 UI09 viewport ${viewport.width}x${viewport.height} keeps ordered regions and focused actions clear of overlays`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mount(page, false, false, false, false, false, 12);
    await expect(body(page)).toBeEditable();
    await returnToPool(page);
    const article = page.locator('.article-module');
    const tabs = page.getByRole('tablist', { name: '存草稿方式' });
    const panel = page.getByRole('tabpanel');
    const browser = page.locator('.browser-module');
    const footer = page.locator('.workspace-footer');
    const stop = footer.getByRole('button', {
      name: '停止并初始化',
      exact: true,
    });
    const clearOfFooter = async (
      control: import('@playwright/test').Locator,
    ) => {
      await control.scrollIntoViewIfNeeded();
      const box = (await control.boundingBox())!;
      const footerBox = (await footer.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(footerBox.y);
      expect(
        await control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      ).toBe(true);
    };
    const assertLayout = async () => {
      const boxes = await Promise.all(
        [article, tabs, panel, browser].map((el) => el.boundingBox()),
      );
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]!.y).toBeGreaterThanOrEqual(
          boxes[i - 1]!.y + boxes[i - 1]!.height - 1,
        );
      }
      expect(
        Math.abs(boxes[2]!.y - (boxes[1]!.y + boxes[1]!.height)),
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(() =>
          [document.documentElement, document.querySelector('main')!].every(
            (el) => el.scrollWidth <= el.clientWidth,
          ),
        ),
      ).toBe(true);
      const stopBox = (await stop.boundingBox())!;
      expect(stopBox.y).toBeGreaterThan(0);
      expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(viewport.height);
      expect(
        await stop.evaluate((el) => ({
          color: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
        })),
      ).toEqual({
        color: 'rgb(255, 255, 255)',
        background: 'rgb(180, 35, 24)',
      });
    };
    await assertLayout();
    await tabs.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: test.info().outputPath(`single-top-${viewport.width}.png`),
    });
    const list = page.getByRole('region', { name: '文章列表', exact: true });
    const select = list.getByRole('checkbox', {
      name: '全选本页',
      exact: true,
    });
    await list.scrollIntoViewIfNeeded();
    await list.evaluate((el) => {
      el.scrollTop = 120;
    });
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    const selectBar = page.locator('.list-selection-bar');
    const listBox = (await list.boundingBox())!;
    const stickyBox = (await selectBar.boundingBox())!;
    expect(Math.abs(stickyBox.y - listBox.y - 1)).toBeLessThanOrEqual(1);
    await select.check();
    await expect(
      page.getByRole('checkbox', { name: /^选择 文章\d+$/, exact: false }),
    ).toHaveCount(10);
    for (const checkbox of await page
      .getByRole('checkbox', { name: /^选择 文章\d+$/ })
      .all())
      await expect(checkbox).toBeChecked();
    const row = list.getByRole('button', { name: /文章10 文章编号/ });
    await row.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const focused = (await row.boundingBox())!;
    const stickyFocused = (await selectBar.boundingBox())!;
    expect(focused.y).toBeGreaterThanOrEqual(
      stickyFocused.y + stickyFocused.height,
    );
    await page.screenshot({
      path: test.info().outputPath(`article-sticky-${viewport.width}.png`),
    });
    await clearOfFooter(
      page.getByRole('button', { name: '检查文章摘要', exact: true }),
    );
    await page.screenshot({
      path: test.info().outputPath(`single-${viewport.width}.png`),
    });
    const cover = panel.getByRole('region', { name: '封面图片', exact: true });
    await cover.getByRole('button', { name: '编辑封面', exact: true }).click();
    await clearOfFooter(
      cover.getByRole('button', { name: '保存封面', exact: true }),
    );
    await cover.getByRole('radio', { name: '单图', exact: true }).check();
    await cover
      .getByRole('button', { name: '完成封面编辑', exact: true })
      .click();
    const discard = page.getByRole('button', { name: '放弃修改', exact: true });
    await clearOfFooter(discard);
    await discard.click();
    await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
    await assertLayout();
    await tabs.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: test.info().outputPath(`batch-top-${viewport.width}.png`),
    });
    const attemptLabels = page
      .getByRole('group', { name: '人工新尝试（默认不选）' })
      .locator('label');
    const attemptBoxes = await attemptLabels.evaluateAll((els) =>
      els.slice(1).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          height: r.height,
        };
      }),
    );
    expect(attemptBoxes).toHaveLength(10);
    for (let i = 0; i < attemptBoxes.length; i++) {
      expect(attemptBoxes[i].height).toBeLessThan(30);
      if (i > 0) {
        const previous = attemptBoxes[i - 1],
          current = attemptBoxes[i];
        if (Math.abs(current.y - previous.y) < 1)
          expect(current.x - previous.right).toBeGreaterThanOrEqual(12);
        else expect(current.y - previous.bottom).toBeGreaterThanOrEqual(8);
      }
    }
    await clearOfFooter(
      page.getByRole('button', { name: '检查批量草稿摘要', exact: true }),
    );
    await page.screenshot({
      path: test.info().outputPath(`batch-${viewport.width}.png`),
    });
    for (const button of await browser.getByRole('button').all())
      await clearOfFooter(button);
    await page.screenshot({
      path: test.info().outputPath(`browser-${viewport.width}.png`),
    });
    await stop.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(stop).toBeFocused();
    expect(await stop.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
      'solid',
    );
    await stop.hover();
    expect(
      await stop.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgb(143, 29, 21)');
    await page.evaluate(() => {
      window.desktopApi.requestStopAll = () =>
        new Promise((resolve) =>
          Reflect.set(window, 'finishGeometryStop', () =>
            resolve({ revision: 1, phase: 'stopped', owners: [] }),
          ),
        );
    });
    await stop.click();
    await expect(stop).toBeDisabled();
    expect(
      await stop.evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      })),
    ).toEqual({ color: 'rgb(255, 255, 255)', background: 'rgb(118, 35, 35)' });
    await page.evaluate(() => Reflect.get(window, 'finishGeometryStop')());
    await expect(stop).toBeEnabled();
  });

  test(`UI07 UI09 history ${viewport.width}x${viewport.height} keeps long records bounded and reaches final result by wheel and keyboard`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mount(page);
    await expect(body(page)).toBeEditable();
    await returnToPool(page);
    await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
    const setHistory = async (count: number) => {
      await page.evaluate((count) => {
        const view: import('../../src/contracts/draft-batch').BatchView = {
          id: '33333333-3333-4333-8333-333333333333',
          revision: count,
          state: 'completed',
          storeName: '测试门店',
          stopRequested: false,
          reason: null,
          counts: {
            total: count,
            saved: 0,
            attempted: 1,
            failed: count - 1,
            skipped: 0,
            pending: 0,
            needsHuman: 0,
            stopped: 0,
          },
          items: Array.from({ length: count }, (_, i) => ({
            articleKey:
              '44444444-4444-4444-8444-' + String(i + 1).padStart(12, '0'),
            title:
              `第${i + 1}篇 ` +
              '长标题需要完整换行并展示文章记录'.repeat(7) +
              'LongUnbrokenTitle0123456789',
            contentDeclaration: 'repost',
            coverSummary: null,
            taskId: null,
            ...(i === count - 1
              ? {
                  state: 'submission_recorded',
                  reason: null,
                  submission: {
                    observation: 'acknowledged',
                    attemptedAt: '2026-10-21T00:00:00.000Z',
                  },
                }
              : { state: 'failed', reason: 'MANUAL_REVIEW_REQUIRED' }),
          })),
        };
        window.desktopApi.batch.getCurrent = async () => structuredClone(view);
      }, count);
      await expect(page.locator('.batch-history-scroll li')).toHaveCount(count);
    };
    await setHistory(12);
    const history = page.locator('.batch-history-scroll');
    const geometry = () =>
      history.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        client: el.clientHeight,
        scroll: el.scrollHeight,
        width: el.clientWidth,
        content: el.scrollWidth,
      }));
    const initial = await geometry();
    expect(initial.scroll).toBeGreaterThan(initial.client);
    expect(initial.content).toBeLessThanOrEqual(initial.width);
    if (viewport.height === 800) expect(initial.height).toBe(360);
    else expect(initial.height).toBeLessThan(360);
    const title = history.locator('strong').first();
    expect(
      await title.evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThan(24);
    if (viewport.width === 800)
      expect(
        await history
          .getByRole('alert')
          .first()
          .evaluate((el) => el.getBoundingClientRect().height),
      ).toBeGreaterThan(27);
    await history.scrollIntoViewIfNeeded();
    await history.hover();
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() =>
        history.evaluate(
          (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
        ),
      )
      .toBe(true);
    const finalResult = history
      .locator('li')
      .last()
      .getByText('平台已响应，实际草稿待人工核对', { exact: true });
    await expect(finalResult).toBeVisible();
    const footer = (await page.locator('.workspace-footer').boundingBox())!;
    const result = (await finalResult.boundingBox())!;
    expect(result.y + result.height).toBeLessThanOrEqual(footer.y);
    await page.screenshot({
      path: test.info().outputPath(`history-last-${viewport.width}.png`),
    });
    await history.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(0);
    await page.keyboard.press('End');
    await expect
      .poll(() =>
        history.evaluate(
          (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
        ),
      )
      .toBe(true);
    await setHistory(24);
    expect((await geometry()).height).toBe(initial.height);
    expect(
      await page.evaluate(() =>
        [document.documentElement, document.querySelector('main')!].every(
          (el) => el.scrollWidth <= el.clientWidth,
        ),
      ),
    ).toBe(true);
  });
}

// T7: changing this to an embedded editor or unmounting hidden panels must fail.
test('T7 focused view hides mounted work panels and returns to the same saved editor session', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  const pool = page.locator('.library-view');
  const editor = page.getByRole('region', { name: '修改文章', exact: true });
  await expect(pool).toBeHidden();
  await expect(pool).toHaveAttribute('inert', '');
  await expect(page.getByRole('tablist', { name: '存草稿方式' })).toBeHidden();
  const session = await page.evaluate(
    () => Reflect.get(window, 'workspaceState')().sessionId,
  );
  await page
    .locator('.library')
    .evaluate((el) => Reflect.set(el, 'preservedPool', true));
  await page
    .locator('.browser-module')
    .evaluate((el) => Reflect.set(el, 'preservedBrowser', true));
  await body(page).fill('专注页保留的修改');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole('status').filter({ hasText: '已保存到本机' }),
  ).toHaveCount(1);
  await editor.getByRole('button', { name: '返回文章池', exact: true }).click();
  await expect(pool).toBeVisible();
  const logs = await page.evaluate(() => Reflect.get(window, 'workspaceLog')());
  expect(logs.filter((v: unknown[]) => v[0] === 'close')).toHaveLength(0);
  expect(
    await page
      .locator('.library')
      .evaluate((el) => Reflect.get(el, 'preservedPool')),
  ).toBe(true);
  expect(
    await page
      .locator('.browser-module')
      .evaluate((el) => Reflect.get(el, 'preservedBrowser')),
  ).toBe(true);
  await page.getByRole('button', { name: /文章1 文章编号/ }).click();
  await expect(editor).toBeVisible();
  await expect(body(page)).toHaveText('专注页保留的修改');
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'workspaceState')().sessionId,
    ),
  ).toBe(session);
  await editor.getByRole('button', { name: '返回文章池', exact: true }).focus();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest('.library-view'),
      ),
    ).toBe(false);
  }
});

test('T7 returning protects unsaved input and save unknown never leaves the focused page', async ({
  page,
}) => {
  await mount(page, true);
  await expect(body(page)).toBeEditable();
  await body(page).fill('未知保存不能丢失');
  const back = page.getByRole('button', { name: '返回文章池', exact: true });
  await back.click();
  await expect(
    page.getByRole('dialog', { name: '离开当前编辑？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(body(page)).toHaveText('未知保存不能丢失');
  await back.click();
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '修改文章', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.library-view')).toBeHidden();
  await expect(body(page)).toHaveText('未知保存不能丢失');
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (v: unknown[]) => v[0] === 'close',
    ),
  ).toHaveLength(0);
});

test('T7 hidden batch polling projects action and completion without releasing or closing the editor', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.evaluate(() => {
    const batch = {
      id: crypto.randomUUID(),
      revision: 1,
      state: 'running',
      storeName: '测试门店',
      stopRequested: false,
      reason: null,
      counts: {
        total: 1,
        attempted: 0,
        saved: 0,
        failed: 0,
        skipped: 0,
        pending: 1,
        needsHuman: 0,
        stopped: 0,
      },
      items: [
        {
          articleKey: '11111111-1111-4111-8111-111111111111',
          title: '文章1',
          contentDeclaration: 'repost',
          coverSummary: null,
          state: 'running',
          reason: null,
          taskId: crypto.randomUUID(),
        },
      ],
    };
    Reflect.set(window, 'focusBatch', batch);
    window.desktopApi.batch.getCurrent = async () =>
      structuredClone(Reflect.get(window, 'focusBatch'));
  });
  const status = page.getByRole('region', { name: '全局操作状态' });
  await expect(status).toContainText('批次执行中');
  await page.evaluate(() =>
    Object.assign(Reflect.get(window, 'focusBatch'), {
      revision: 2,
      state: 'paused',
      reason: 'LOGIN_REQUIRED',
    }),
  );
  await expect(status).toContainText('批次已暂停');
  await expect(
    status.getByRole('button', { name: '返回工作区处理', exact: true }),
  ).toBeVisible();
  await body(page).fill('查看任务仍需保护的正文');
  await status
    .getByRole('button', { name: '返回工作区处理', exact: true })
    .click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(body(page)).toHaveText('查看任务仍需保护的正文');
  await page.evaluate(() =>
    Object.assign(Reflect.get(window, 'focusBatch'), {
      revision: 3,
      state: 'completed',
      reason: null,
      counts: {
        total: 1,
        attempted: 1,
        saved: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        needsHuman: 0,
        stopped: 0,
      },
    }),
  );
  await expect(status).toContainText('本批次尝试已结束');
  await expect(page.locator('.library-view')).toBeHidden();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (v: unknown[]) => v[0] === 'close',
    ),
  ).toHaveLength(0);
});

test('T7 page two, batch mode and legal checked selection survive local save and view return', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 12);
  await expect(body(page)).toBeEditable();
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await page
    .getByRole('navigation', { name: '文章分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await page
    .getByRole('checkbox', { name: '选择 文章11', exact: true })
    .check();
  await page.getByRole('button', { name: /^文章11 文章编号/ }).click();
  await expect(body(page)).toBeEditable();
  await body(page).fill('第二页修改');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.editor-save-status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: '文章分页', exact: true })
      .getByText('第 2 页 / 共 2 页', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章11', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('tab', { name: '批量存草稿', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('T7 new article saves continue editing the same existing identity', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '新建文章', exact: true }),
  ).toBeVisible();
  await page.getByLabel('文章标题').fill('新建后的持续编辑');
  await body(page).fill('新建正文');
  const session = await page.evaluate(
    () => Reflect.get(window, 'workspaceState')().sessionId,
  );
  await page.getByRole('button', { name: '保存到本机', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '修改文章', exact: true }),
  ).toBeVisible();
  const key = await page.evaluate(
    () => Reflect.get(window, 'workspaceState')().target.articleKey,
  );
  await body(page).fill('同一篇文章的第二次修改');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.editor-save-status')).toHaveText('已保存到本机');
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'workspaceState')().sessionId,
    ),
  ).toBe(session);
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'workspaceState')().target.articleKey,
    ),
  ).toBe(key);
  await page.getByRole('button', { name: '返回文章池', exact: true }).click();
  await expect(
    page.getByText('本机文章共 3 篇', { exact: true }),
  ).toBeVisible();
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 800, height: 600 },
]) {
  test(`T7 focused rich article ${viewport.width}x${viewport.height} has one scrollport and unobscured tools, caret and footer`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mount(page);
    await expect(body(page)).toBeEditable();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 320;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#e4eee8';
      ctx.fillRect(0, 0, 720, 320);
      ctx.fillStyle = '#527c6b';
      ctx.beginPath();
      ctx.moveTo(0, 280);
      ctx.lineTo(190, 85);
      ctx.lineTo(350, 260);
      ctx.lineTo(540, 70);
      ctx.lineTo(720, 280);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f7f9f7';
      ctx.fillRect(210, 180, 300, 74);
      ctx.fillStyle = '#245b45';
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('本地合成图片 · 布局核对', 360, 225);
      const bytes = Uint8Array.from(
        atob(canvas.toDataURL('image/png').split(',')[1]),
        (c) => c.charCodeAt(0),
      );
      window.desktopApi.getManualImage = async () => ({
        status: 'ok',
        mime: 'image/png',
        bytes,
      });
      const state = Reflect.get(window, 'workspaceState')();
      const key = () => crypto.randomUUID();
      const paragraph = (text: string) => ({
        type: 'paragraph',
        blockKey: key(),
        content: [{ type: 'text', text, marks: [] }],
      });
      const imageToken = key();
      state.revision++;
      state.draft = {
        bodyVersion: 2,
        title: '周末出行，把沿途风景写进文章',
        contentDeclaration: 'repost',
        blocks: [
          paragraph(
            '这是一篇合成的布局样例。文字、图片和段落沿同一条阅读路径展开，便于核对标题、正文与图片顺序。',
          ),
          { type: 'image', blockKey: key(), imageToken },
          {
            type: 'heading',
            blockKey: key(),
            content: [
              { type: 'text', text: '出发前，先留一点从容', marks: [] },
            ],
          },
          ...Array.from({ length: 8 }, (_, i) =>
            paragraph(
              `第${i + 1}段：在连续正文里写下沿途所见，保留清楚的段落，也给图片留出自然的空间。`,
            ),
          ),
          {
            type: 'heading',
            blockKey: key(),
            content: [{ type: 'text', text: '收尾核对清单', marks: [] }],
          },
          {
            type: 'list',
            blockKey: key(),
            kind: 'ordered',
            start: 1,
            items: [
              paragraph('核对标题、文字格式与图片顺序'),
              paragraph('明确保存到本机，再返回文章池'),
            ],
          },
          {
            type: 'paragraph',
            blockKey: key(),
            content: [
              { type: 'text', text: '文章尾部：', marks: [] },
              {
                type: 'text',
                text: '光标和操作按钮应完整可见。',
                marks: ['bold'],
              },
            ],
          },
        ],
      };
      state.images = [
        {
          imageToken,
          mime: 'image/png',
          width: 720,
          height: 320,
          byteSize: bytes.length,
        },
      ];
    });
    await expect(page.getByLabel('文章标题')).toHaveValue(
      '周末出行，把沿途风景写进文章',
    );
    const image = page.getByRole('img', { name: '正文图片', exact: true });
    await expect(image).toBeVisible();
    const toolbar = page.getByRole('toolbar', { name: '正文格式' });
    const footer = page.getByRole('region', { name: '全局操作状态' });
    const title = page.getByLabel('文章标题');
    for (const button of await toolbar.getByRole('button').all()) {
      const size = await button.boundingBox();
      expect(size!.width).toBeGreaterThanOrEqual(32);
      expect(size!.height).toBeGreaterThanOrEqual(32);
      if ((await button.getAttribute('aria-label')) === '正文格式帮助')
        await expect(button).toHaveAttribute('aria-describedby', /.+/);
      else await expect(button).toHaveAttribute('title', /.+/);
      await expect(button).toHaveAccessibleName(/.+/);
    }
    expect(await toolbar.evaluate((el) => getComputedStyle(el).position)).toBe(
      'sticky',
    );
    expect(
      await body(page).evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe(viewport.width === 800 ? '16px' : '18px');
    expect(await title.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      '28px',
    );
    expect(
      await page
        .locator('.ProseMirror h2')
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe('22px');
    const geometry = await page
      .locator('.continuous-body-shell')
      .evaluate((el) => ({
        client: el.clientHeight,
        scroll: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY,
      }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    expect(geometry.overflow).toBe('visible');
    expect(
      await page.evaluate(() =>
        [document.documentElement, document.querySelector('main')!].every(
          (el) => el.scrollWidth <= el.clientWidth,
        ),
      ),
    ).toBe(true);
    const main = page.locator('main');
    await main.evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-10-23-rich-text-editor/task-7-focused-${viewport.width}.png`,
      ),
    });
    await image.scrollIntoViewIfNeeded();
    const imageBox = (await image.boundingBox())!;
    expect(Math.abs(imageBox.width / imageBox.height - 720 / 320)).toBeLessThan(
      0.02,
    );
    await body(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    const caret = await body(page).evaluate(() => {
      const range = document.getSelection()!.getRangeAt(0).cloneRange();
      range.collapse(false);
      const rect = range.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    });
    const tools = (await toolbar.boundingBox())!;
    const bar = (await footer.boundingBox())!;
    expect(caret.height).toBeGreaterThan(0);
    expect(caret.top).toBeGreaterThanOrEqual(tools.y + tools.height);
    expect(caret.bottom).toBeLessThanOrEqual(bar.y);
    await page
      .getByRole('button', { name: '正文编辑帮助', exact: true })
      .focus();
    const declaration = (await page
      .getByRole('button', { name: '正文编辑帮助', exact: true })
      .boundingBox())!;
    expect(declaration.y).toBeGreaterThanOrEqual(
      (await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height,
    );
    expect(declaration.y + declaration.height).toBeLessThanOrEqual(bar.y);
    await page.screenshot({
      path: resolve(
        `.superpowers/sdd/2026-10-23-rich-text-editor/task-7-focused-end-${viewport.width}.png`,
      ),
    });
    await title.focus();
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.y).toBeGreaterThanOrEqual(
      (await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height,
    );
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(bar.y);
    await page.getByRole('button', { name: '保存修改', exact: true }).focus();
    await expect(
      page.getByRole('button', { name: '保存修改', exact: true }),
    ).toBeFocused();
  });
}

test('T7 global stop during the return decision cancels navigation and retains dirty content', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await body(page).fill('返回确认期间停止，正文仍需保留');
  await returnToPool(page);
  const dialog = page.getByRole('dialog', { name: '离开当前编辑？' });
  await dialog
    .getByRole('button', { name: '停止并初始化', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('region', { name: '全局操作状态' }),
  ).toContainText('正文编辑与图片');
  await expect(body(page)).toHaveText('返回确认期间停止，正文仍需保留');
  await expect(page.locator('.library-view')).toBeHidden();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (v: unknown[]) => v[0] === 'close',
    ),
  ).toHaveLength(0);
});

for (const outcome of [
  {
    state: 'needs_human',
    platformPaused: false,
    reason: 'MANUAL_REVIEW_REQUIRED',
    text: '需要人工处理',
  },
  {
    state: 'failed',
    platformPaused: false,
    reason: 'ASSET_UNAVAILABLE',
    text: '文章失败',
  },
  {
    state: 'running',
    platformPaused: true,
    reason: 'PAGE_CHANGED',
    text: '平台已暂停',
  },
  {
    state: 'interrupted',
    platformPaused: true,
    reason: 'INTERRUPTED',
    text: '平台已暂停',
  },
  {
    state: 'submission_recorded',
    platformPaused: false,
    reason: null,
    text: '实际草稿待人工核对',
  },
]) {
  test(`T7 hidden single task ${outcome.state}/${outcome.platformPaused} remains visible in global projection`, async ({
    page,
  }) => {
    const task = {
      taskId: '33333333-3333-4333-8333-333333333333',
      articleKey: '11111111-1111-4111-8111-111111111111',
      title: '文章1',
      storeName: '测试门店',
      state: 'running' as const,
      stage: 'body' as const,
      revision: 1,
      possibleRemoteEffect: true,
      stopRequested: false,
      platformPaused: false,
      reason: null,
      canOpenDraft: false,
    };
    await mount(page, false, false, false, false, false, 2, {}, task);
    await expect(body(page)).toBeEditable();
    const status = page.getByRole('region', { name: '全局操作状态' });
    await expect(status).toContainText('草稿任务执行中');
    await page.evaluate(
      (outcome) =>
        Reflect.get(
          window,
          'workspaceTask',
        )({
          ...Reflect.get(window, 'workspaceTask')(),
          state: outcome.state,
          platformPaused: outcome.platformPaused,
          reason: outcome.reason,
          revision: 2,
          ...(outcome.state === 'submission_recorded'
            ? {
                stage: 'settled',
                submission: {
                  observation: 'acknowledged',
                  attemptedAt: '2026-10-23T00:00:00.000Z',
                },
              }
            : {}),
        }),
      outcome,
    );
    await expect(status).toContainText(outcome.text);
    await expect(
      status.getByRole('button', { name: '返回工作区处理', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.library-view')).toBeHidden();
    const logs = await page.evaluate(() =>
      Reflect.get(window, 'workspaceLog')(),
    );
    expect(
      logs.filter((v: unknown[]) => ['close', 'start'].includes(String(v[0]))),
    ).toHaveLength(0);
  });
}

test('T7 FIX1 retained completed batch attention and newer single running then completion remain visible together', async ({
  page,
}) => {
  const task = {
    taskId: '33333333-3333-4333-8333-333333333333',
    articleKey: '11111111-1111-4111-8111-111111111111',
    title: '文章1',
    storeName: '测试门店',
    state: 'queued' as const,
    stage: 'reserved' as const,
    revision: 1,
    possibleRemoteEffect: false,
    stopRequested: false,
    platformPaused: false,
    reason: null,
    canOpenDraft: false,
  };
  await mount(page, false, false, false, false, false, 2, {}, task);
  await expect(body(page)).toBeEditable();
  await page.evaluate(() => {
    const batch: import('../../src/contracts/draft-batch').BatchView = {
      id: '44444444-4444-4444-8444-444444444444',
      revision: 1,
      state: 'completed',
      storeName: '测试门店',
      stopRequested: false,
      reason: null,
      counts: {
        total: 2,
        attempted: 0,
        saved: 0,
        failed: 1,
        skipped: 0,
        pending: 0,
        needsHuman: 1,
        stopped: 0,
      },
      items: [
        {
          articleKey: '11111111-1111-4111-8111-111111111111',
          title: '旧文章1',
          contentDeclaration: 'repost',
          coverSummary: null,
          state: 'failed',
          reason: 'ASSET_UNAVAILABLE',
          taskId: '55555555-5555-4555-8555-555555555555',
        },
        {
          articleKey: '22222222-2222-4222-8222-222222222222',
          title: '旧文章2',
          contentDeclaration: 'repost',
          coverSummary: null,
          state: 'needs_human',
          reason: 'MANUAL_REVIEW_REQUIRED',
          taskId: '66666666-6666-4666-8666-666666666666',
        },
      ],
    };
    Reflect.set(window, 'retainedAttentionBatch', batch);
    window.desktopApi.batch.getCurrent = async () =>
      structuredClone(Reflect.get(window, 'retainedAttentionBatch'));
  });
  const footer = page.getByRole('region', { name: '全局操作状态' });
  const headerStatus = page.locator('.editor-task-status');
  await expect(footer).toContainText('失败 1 篇，需人工处理 1 篇');
  await page.evaluate(() =>
    Reflect.get(
      window,
      'workspaceTask',
    )({
      ...Reflect.get(window, 'workspaceTask')(),
      state: 'running',
      stage: 'body',
      revision: 2,
      possibleRemoteEffect: true,
    }),
  );
  for (const target of [headerStatus, footer]) {
    await expect(target).toContainText('草稿任务执行中');
    await expect(target).toContainText('失败 1 篇，需人工处理 1 篇');
  }
  await page.evaluate(() =>
    Reflect.get(
      window,
      'workspaceTask',
    )({
      ...Reflect.get(window, 'workspaceTask')(),
      state: 'submission_recorded',
      stage: 'settled',
      revision: 3,
      submission: {
        observation: 'acknowledged',
        attemptedAt: '2026-10-23T00:00:00.000Z',
      },
    }),
  );
  for (const target of [headerStatus, footer]) {
    await expect(target).toContainText('已尝试保存，实际草稿待人工核对');
    await expect(target).toContainText('失败 1 篇，需人工处理 1 篇');
    await expect(target).not.toContainText('草稿任务执行中');
  }
  await expect(page.locator('.library-view')).toBeHidden();
  expect(
    await page.evaluate(() => window.desktopApi.batch.getCurrent()),
  ).toMatchObject({
    state: 'completed',
    revision: 1,
    counts: { failed: 1, needsHuman: 1 },
  });
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (v: unknown[]) => ['close', 'start'].includes(String(v[0])),
    ),
  ).toHaveLength(0);
});

test('T7 FIX1 retained single attention does not hide an active batch projection', async ({
  page,
}) => {
  const task = {
    taskId: '33333333-3333-4333-8333-333333333333',
    articleKey: '11111111-1111-4111-8111-111111111111',
    title: '文章1',
    storeName: '测试门店',
    state: 'needs_human' as const,
    stage: 'body' as const,
    revision: 1,
    possibleRemoteEffect: true,
    stopRequested: false,
    platformPaused: false,
    reason: 'MANUAL_REVIEW_REQUIRED' as const,
    canOpenDraft: false,
  };
  await mount(page, false, false, false, false, false, 2, {}, task);
  await expect(body(page)).toBeEditable();
  const footer = page.getByRole('region', { name: '全局操作状态' });
  await expect(footer).toContainText('文章需要人工处理');
  await page.evaluate(() => {
    const batch: import('../../src/contracts/draft-batch').BatchView = {
      id: '44444444-4444-4444-8444-444444444444',
      revision: 1,
      state: 'running',
      storeName: '测试门店',
      stopRequested: false,
      reason: null,
      counts: {
        total: 1,
        attempted: 0,
        saved: 0,
        failed: 0,
        skipped: 0,
        pending: 1,
        needsHuman: 0,
        stopped: 0,
      },
      items: [
        {
          articleKey: '22222222-2222-4222-8222-222222222222',
          title: '新文章2',
          contentDeclaration: 'repost',
          coverSummary: null,
          state: 'running',
          reason: null,
          taskId: '55555555-5555-4555-8555-555555555555',
        },
      ],
    };
    window.desktopApi.batch.getCurrent = async () => structuredClone(batch);
  });
  for (const target of [page.locator('.editor-task-status'), footer]) {
    await expect(target).toContainText('批次执行中');
    await expect(target).toContainText('文章需要人工处理');
  }
  await expect(
    footer.getByRole('button', { name: '返回工作区处理', exact: true }),
  ).toBeVisible();
  await expect(
    footer.getByRole('button', { name: '停止并初始化', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.library-view')).toBeHidden();
});

for (const destination of ['normal return', 'body', 'title'] as const) {
  test(`T7 delayed leave-dialog focus restoration preserves ${destination}`, async ({
    page,
  }) => {
    await mount(page);
    const editor = body(page);
    await expect(editor).toBeEditable();
    await editor.fill('继续编辑前的正文');
    const back = page.getByRole('button', { name: '返回文章池', exact: true });
    await back.click();
    const leave = page.getByRole('dialog', { name: '离开当前编辑？' });
    await expect(leave).toBeVisible();
    // Hold the real deferred callbacks so an explicit focus change can happen
    // after native dialog.close() and before the accessible return-focus work.
    await page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window);
      const held = new Map<number, FrameRequestCallback>();
      let next = -1;
      window.requestAnimationFrame = (callback) => {
        const id = next--;
        held.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (!held.delete(id)) cancel(id);
      };
      Reflect.set(window, 'heldLeaveFrames', () => held.size);
      Reflect.set(window, 'flushLeaveFrames', () => {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        const callbacks = [...held.values()];
        held.clear();
        for (const callback of callbacks) callback(performance.now());
      });
    });
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(leave).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'heldLeaveFrames')()))
      .toBeGreaterThan(0);
    const title = page.getByRole('textbox', { name: '文章标题', exact: true });
    if (destination === 'body') await editor.fill('继续编辑前的正文');
    else if (destination === 'title') await title.focus();
    else {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      });
      expect(
        await page.evaluate(() => document.activeElement === document.body),
      ).toBe(true);
    }
    await page.evaluate(() => Reflect.get(window, 'flushLeaveFrames')());
    await expect(
      destination === 'body' ? editor : destination === 'title' ? title : back,
    ).toBeFocused();
    if (destination === 'body') {
      // Page keyboard deliberately uses the existing focus; locator.press would
      // refocus the editor and hide the regression that reopens the dialog.
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('继续输入');
      await expect(editor).toContainText('继续输入');
    }
    await expect(leave).toBeHidden();
    await expect(page.locator('.library-view')).toBeHidden();
    expect(
      (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
        (entry: unknown[]) => entry[0] === 'close',
      ),
    ).toHaveLength(0);
  });
}

test('T5 rich formatting routine help appears on focus while retaining every format control', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page);
  await expect(body(page)).toBeEditable();
  const toolbar = page.getByRole('toolbar', { name: '正文格式', exact: true });
  const help = toolbar.getByRole('button', {
    name: '正文格式帮助',
    exact: true,
  });
  await expect(help).toBeVisible();
  const tip = page.getByRole('tooltip');
  await expect(tip).not.toBeVisible();
  for (const name of [
    '撤销',
    '重做',
    '正文',
    '小标题',
    '加粗',
    '斜体',
    '下划线',
    '无序列表',
    '有序列表',
    '引用',
    '清除格式',
    '插入图片',
  ]) {
    await expect(
      toolbar.getByRole('button', { name, exact: true }),
    ).toHaveCount(1);
  }
  await help.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  expect(
    await help.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe('solid');
  await expect(tip).toHaveText(
    '加粗、斜体、下划线、小标题、列表、引用会一并写入平台草稿。',
  );
  await expect(help).toHaveAttribute(
    'aria-describedby',
    (await tip.getAttribute('id'))!,
  );
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(800);
  await page.screenshot({
    path: resolve(
      '.superpowers/sdd/2026-11-08-operator-recovery-ui/t5-rich-format-help-800.png',
    ),
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(tip).not.toBeVisible();
  await expect(help).toBeFocused();
});

test('creation cover participates in one Save and a failed cover cannot leave or show fully saved', async ({
  page,
}) => {
  await mount(page);
  await returnToPool(page);
  await page.evaluate(() => {
    const api = window.desktopApi;
    const state = () => Reflect.get(window, 'workspaceState')();
    const reply = () => ({ status: 'ok', snapshot: structuredClone(state()) });
    const originalBegin = api.beginManualArticle;
    const originalSave = api.commitManualDocument;
    const savedCovers = new Map();
    let attempts = 0;
    Object.assign(window, { manualCoverAttempts: () => attempts });
    Object.assign(api, {
      beginManualArticle: async () => {
        await originalBegin();
        state().cover = {
          draftRevision: 0,
          baseCoverRevision: 0,
          mode: 'none',
          dirty: false,
        };
        return reply();
      },
      pickManualCoverImage: async (command: {
        expectedCoverDraftRevision: number;
      }) => {
        if (command.expectedCoverDraftRevision !== state().cover.draftRevision)
          throw Error('Stale cover');
        state().cover = {
          draftRevision: 1,
          baseCoverRevision: 0,
          mode: 'single',
          dirty: true,
          image: {
            imageToken: crypto.randomUUID(),
            mime: 'image/png',
            width: 1,
            height: 1,
          },
        };
        state().revision++;
        return reply();
      },
      getManualCoverImage: async () => ({ status: 'unavailable' }),
      commitManualDocument: async (command: {
        expectedCoverDraftRevision?: number;
      }) => {
        if (command.expectedCoverDraftRevision !== state().cover.draftRevision)
          throw Error('Cover not frozen');
        if (state().dirty || state().target.kind === 'new')
          await originalSave(command as never);
        attempts++;
        state().revision++;
        state().nextSaveOperationId = crypto.randomUUID();
        if (attempts === 1)
          state().cover.outcome = {
            status: 'failed',
            operationId: crypto.randomUUID(),
          };
        else {
          state().cover.dirty = false;
          state().cover.baseCoverRevision = 1;
          state().cover.outcome = {
            status: 'committed',
            receipt: {
              operationId: crypto.randomUUID(),
              articleKey: state().target.articleKey,
              coverRevision: 1,
              configurationDigest: 'a'.repeat(64),
            },
          };
          savedCovers.set(state().target.articleKey, {
            articleKey: state().target.articleKey,
            coverRevision: 1,
            mode: 'single',
            images: [
              {
                assetKey: crypto.randomUUID(),
                mime: 'image/png',
                width: 1,
                height: 1,
              },
            ],
          });
        }
        return reply();
      },
      getArticleCover: async (key: string) => ({
        status: 'ok',
        configuration: savedCovers.get(key) ?? {
          articleKey: key,
          coverRevision: 0,
          mode: 'none',
          images: [],
        },
      }),
    });
  });
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByRole('textbox', { name: '文章标题' }).fill('创建时封面');
  const panel = page.getByRole('region', { name: '文章封面', exact: true });
  await panel
    .getByRole('button', { name: '从本地选择封面', exact: true })
    .click();
  await expect(panel.getByText('封面尚未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存到本机', exact: true }).click();
  await expect(
    page.getByText('文章已保存，封面未保存', { exact: true }),
  ).toBeVisible();
  await returnToPool(page);
  const dialog = page.getByRole('dialog', { name: '离开当前编辑？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('.editor-save-status')).toHaveText('已保存到本机');
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'workspaceLog')().filter(
          (v: unknown[]) => v[0] === 'save',
        ).length,
    ),
  ).toBe(1);
  await returnToPool(page);
  const row = page
    .locator('.article-rows li')
    .filter({ hasText: '创建时封面' });
  await expect(row.locator('.article-cover-thumbnail')).toHaveAttribute(
    'data-cover-revision',
    '1',
  );
});

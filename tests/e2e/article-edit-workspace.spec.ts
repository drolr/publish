import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mount, body } from './article-workspace-fixture';
type FixtureWindow = Window & {
  workspaceLog(): Array<[string, ...unknown[]]>;
  workspaceClose(): void;
};

test('UI01 article precedes accessible mode workspace and one shared browser survives keyboard switches', async ({
  page,
}) => {
  await mount(page);
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
  await page.getByRole('button', { name: '删除 文章1', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '离开当前编辑？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
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
  await page.getByRole('button', { name: '删除 文章1', exact: true }).click();
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
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: /^文章11 文章编号/ }).click();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章11');
  await expect(body(page)).toBeEditable();
  await page.getByLabel('文章标题').fill('第二页保存后的标题');
  await page.getByRole('button', { name: '删除 文章11', exact: true }).click();
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从本机删除文章？' });
  await expect(dialog).toContainText('第二页保存后的标题');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.getByText('本机文章共 10 篇', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('第 1 页 / 共 1 页', { exact: true }),
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
test('selection_load_is_not_blank_new_doc and platform remains visible', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toHaveText('已保存正文1');
  await expect(body(page)).toBeEditable();
  await expect(page.getByRole('region', { name: '巨懂车草稿' })).toBeVisible();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章1');
});
for (const choice of ['继续编辑', '放弃修改', '保存并继续'])
  test('dirty_switch_' + choice, async ({ page }) => {
    await mount(page);
    await expect(body(page)).toBeEditable();
    await body(page).fill('改过正文');
    await page.getByRole('button', { name: /文章2 文章编号/ }).click();
    await expect(
      page.getByRole('dialog', { name: '离开当前编辑？' }),
    ).toBeVisible();
    await page.getByRole('button', { name: choice, exact: true }).click();
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
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
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
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
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
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
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
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
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
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(
    page.getByRole('button', { name: '保存并继续', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
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
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
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
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await body(page).dispatchEvent('compositionend');
  await page.waitForTimeout(100);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await title.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  const edit = logs.filter((v) => v[0] === 'edit').at(-1);
  expect(edit?.[1]).toMatchObject({
    title: '完整标题😀',
    blocks: [{ type: 'paragraph', text: '完整正文😀' }],
  });
  expect(logs.filter((v) => v[0] === 'save')).toHaveLength(1);
});
test('800x600 workspace exposes body and local save controls without a second clipped editor pane', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.setViewportSize({ width: 800, height: 600 });
  const pane = page.getByRole('region', { name: '文章预览' });
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
test('F06 declaration change retires old summary and requires new human confirmation', async ({
  page,
}) => {
  await mount(page);
  await expect(body(page)).toBeEditable();
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  await page
    .getByLabel('文章预览')
    .getByRole('combobox')
    .selectOption('original');
  await page.getByRole('button', { name: '保存声明', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: '存到巨懂车草稿', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '检查文章摘要' }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  const logs = await page.evaluate(() =>
    (window as unknown as FixtureWindow).workspaceLog(),
  );
  expect(logs.filter((v) => v[0] === 'prepare').map((v) => v[2])).toEqual([
    1, 2,
  ]);
  await expect(page.getByText(/本地声明：原创/)).toBeVisible();
});

test('single and batch pages keep separate start controls and a stop-only fixed footer', async ({
  page,
}) => {
  await mount(page);
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
  await body(page).dispatchEvent('compositionstart');
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await body(page).fill('交接开始后才输入的新内容');
  await body(page).dispatchEvent('compositionend');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(body(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
  ).toBeEnabled();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (entry: unknown[]) => entry[0] === 'prepare',
    ),
  ).toHaveLength(0);
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '检查文章摘要', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '请确认本次存草稿摘要' }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'workspaceLog')())).filter(
      (entry: unknown[]) => entry[0] === 'prepare',
    ),
  ).toEqual([['prepare', '11111111-1111-4111-8111-111111111111', 2, 'idle']]);
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
    page.getByRole('button', { name: '检查文章摘要', exact: true }),
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
    const selectBar = page.locator('.select-page');
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

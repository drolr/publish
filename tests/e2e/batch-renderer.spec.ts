import { test, expect, type Page } from '@playwright/test';
import webpack from 'webpack';
import { installCoverBridge } from './cover-renderer-fixture';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraftHarness } from '../fixtures/draft-harness';
import { createBatchController } from '../../src/application/batch-controller';
import { openDraftBatchRepository } from '../../src/infrastructure/persistence/draft-batch-repository';
import { operatorSettlement } from '../fixtures/operator-settlement';

test.beforeAll(async () => {
  await new Promise<void>((done, reject) => {
    webpack(
      {
        mode: 'development',
        entry: resolve('tests/e2e/batch-renderer-entry.tsx'),
        output: { path: resolve('.tmp/batch-renderer'), filename: 'app.js' },
        module: {
          rules: [
            {
              test: /\.tsx?$/,
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
                compilerOptions: { noEmit: false },
              },
            },
            {
              test: /\.css$/,
              use: [MiniCssExtractPlugin.loader, 'css-loader'],
            },
          ],
        },
        plugins: [new MiniCssExtractPlugin({ filename: 'app.css' })],
        resolve: { extensions: ['.tsx', '.ts', '.js'] },
        devtool: false,
      },
      (error, stats) =>
        error || stats?.hasErrors()
          ? reject(error ?? new Error(stats?.toString()))
          : done(),
    );
  });
});

const key = '11111111-1111-4111-8111-111111111111';

test('UI06 select all new attempts scopes unique current keys, invalidates summary and resets on selection and stop', async ({
  page,
}) => {
  await boot(page);
  const second = '22222222-2222-4222-8222-222222222222';
  await page.evaluate(
    ({ key, second }) => {
      Reflect.get(window, 'changeBatchSelection')([key, second, key]);
      const prepare = window.desktopApi.batch.prepare;
      window.desktopApi.batch.prepare = async (input) => {
        Reflect.set(window, 'attemptSelection', input.newAttemptArticleKeys);
        return prepare(input);
      };
    },
    { key, second },
  );
  const all = page.getByRole('checkbox', { name: '全选新尝试', exact: true });
  await expect(all).not.toBeChecked();
  await page.getByRole('checkbox', { name: '第1篇作为新尝试' }).check();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await all.check();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'attemptSelection')),
  ).toEqual([key, second]);
  await page
    .getByRole('checkbox', { name: '取消全选新尝试', exact: true })
    .uncheck();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
  await all.check();
  await page.evaluate(() => Reflect.get(window, 'resetBatch')());
  await expect(all).not.toBeChecked();
  await all.check();
  await page.evaluate(
    (second) => Reflect.get(window, 'changeBatchSelection')([second]),
    second,
  );
  await expect(all).not.toBeChecked();
  await page.evaluate(() => Reflect.get(window, 'changeBatchSelection')([]));
  await expect(all).toBeDisabled();
});

test('UI06 all and per-article attempts freeze through configuration, busy, unknown, held and uncertain start', async ({
  page,
}) => {
  await boot(page);
  const all = page.getByRole('checkbox', { name: '全选新尝试', exact: true });
  const one = page.getByRole('checkbox', { name: '第1篇作为新尝试' });
  const prepare = page.getByRole('button', { name: '检查批量草稿摘要' });
  await expect(all).toBeEnabled();
  for (const control of ['freezeBatchConfiguration', 'blockBatchActions']) {
    await page.evaluate((name) => Reflect.get(window, name)(true), control);
    await expect(all).toBeDisabled();
    await expect(one).toBeDisabled();
    await page.evaluate((name) => Reflect.get(window, name)(false), control);
    await expect(all).toBeEnabled();
  }
  await page.evaluate(() => {
    const original = window.desktopApi.batch.prepare;
    window.desktopApi.batch.prepare = async (input) => {
      await new Promise<void>((resolve) =>
        Reflect.set(window, 'releaseAttemptPrepare', resolve),
      );
      return original(input);
    };
  });
  await prepare.click();
  await expect(all).toBeDisabled();
  await expect(one).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'releaseAttemptPrepare')());
  await expect(all).toBeEnabled();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(all).toBeDisabled();
  await expect(one).toBeDisabled();
  await page.getByRole('button', { name: '停止本批次' }).click();
  await expect(all).toBeEnabled();
  await page.evaluate(() => {
    window.desktopApi.batch.getCurrent = async () => {
      throw Error('fixture read unavailable');
    };
  });
  await expect(page.getByText('批次状态暂时无法确认，正在核对…')).toBeVisible();
  await expect(all).toBeDisabled();
  await expect(one).toBeDisabled();
  await page.evaluate(() => {
    window.desktopApi.batch.getCurrent = async () => null;
  });
  await expect(all).toBeEnabled();
  await page.evaluate(() => {
    window.desktopApi.batch.start = async () => {
      throw Error('fixture unknown start');
    };
  });
  await prepare.click();
  await page.evaluate(() => Reflect.get(window, 'releaseAttemptPrepare')());
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(
    page.getByText('操作回复未确认，正在核对批次记录；请勿重复开始。'),
  ).toBeVisible();
  await expect(all).toBeDisabled();
  await expect(one).toBeDisabled();
  await expect(all).not.toBeChecked();
  await expect(one).not.toBeChecked();
});

test('failed batch archive action preserves durable batch items and attempt evidence after repository restart', async ({
  page,
}) => {
  const h = await createDraftHarness();
  const migrations = resolve('src/infrastructure/persistence/migrations');
  let repository = openDraftBatchRepository(h.path, migrations);
  // A conclusive local failure before any adapter checkpoint has no remote effect.
  h.platform.execute = async () => ({
    status: 'blocked',
    reason: 'ASSET_UNAVAILABLE',
  });
  const batch = createBatchController({
    repository,
    draft: h.api,
    preparation: h.preparation,
    articles: h.articles,
    snapshots: h.snapshots,
    newId: randomUUID,
    now: () => h.control.now,
    gate: () => 'ready',
  });
  try {
    await boot(page);
    await page.exposeFunction('t5DraftState', () => h.api.getDraftState());
    await page.exposeFunction('t5BatchCurrent', () => batch.getCurrent());
    await page.exposeFunction(
      't5BatchPrepare',
      (input: Parameters<typeof batch.prepare>[0]) => batch.prepare(input),
    );
    await page.exposeFunction(
      't5BatchStart',
      (input: Parameters<typeof batch.start>[0]) => batch.start(input),
    );
    await page.exposeFunction(
      't5BatchArchive',
      (input: Parameters<typeof batch.archiveFinishedBatch>[0]) =>
        batch.archiveFinishedBatch(input),
    );
    await page.evaluate((articleKey) => {
      const invoke = (name: string, input?: unknown) =>
        Reflect.get(window, name)(input);
      window.desktopApi.getDraftState = () => invoke('t5DraftState');
      window.desktopApi.batch.getCurrent = () => invoke('t5BatchCurrent');
      window.desktopApi.batch.prepare = (input) =>
        invoke('t5BatchPrepare', input);
      window.desktopApi.batch.start = (input) => invoke('t5BatchStart', input);
      window.desktopApi.batch.archiveFinishedBatch = (input) =>
        invoke('t5BatchArchive', input);
      Reflect.get(window, 'changeBatchSelection')([articleKey]);
    }, h.articleKey);
    await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
    await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
    await batch.waitForIdle();
    const before = (await batch.getCurrent())!;
    expect(before).toMatchObject({
      state: 'completed',
      counts: { failed: 1, pending: 0 },
    });
    const taskBefore = h.tasks.get(before.items[0].taskId!)!;
    expect(taskBefore).toMatchObject({
      state: 'failed',
      holdsPlatform: false,
      saveAttempted: false,
      reason: 'ASSET_UNAVAILABLE',
    });
    const archive = page.getByRole('button', {
      name: '移除失败批次',
      exact: true,
    });
    await expect(archive).toBeVisible();
    await expect(archive).toBeEnabled();
    await archive.click();
    await expect(archive).toHaveCount(0);
    await expect.poll(() => repository.getCurrent()).toBeNull();
    repository.close();
    repository = openDraftBatchRepository(h.path, migrations);
    expect(repository.getCurrent()).toBeNull();
    const historical = repository.get(before.id)!;
    expect(historical).toEqual({ ...before, revision: before.revision + 1 });
    await h.restart();
    expect(h.tasks.get(taskBefore.taskId)).toEqual(taskBefore);
    expect(
      h.tasks.findIdentity(taskBefore.articleKey, taskBefore.store.storeKey),
    ).toEqual(taskBefore);
    expect(h.calls).not.toContain('save');
  } finally {
    await batch.stopAndWait();
    repository.close();
    await h.close();
  }
});

async function boot(page: Page, lost = false) {
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost/batch');
  await page.evaluate(
    ({ key, lost }) => {
      let current: unknown = null;
      const calls: string[] = [];
      const item = {
        articleKey: key,
        title: '测试文章',
        contentDeclaration: 'original',
        coverSummary: { mode: 'none', imageCount: 0, images: [] },
        taskId: null,
        state: 'queued',
        reason: null,
      };
      Object.assign(window, {
        batchCalls: calls,
        desktopApi: {
          getDraftState: async () => ({
            session: {
              status: 'ready',
              bindingToken: key,
              storeName: '测试门店',
              reason: null,
            },
            preparation: null,
            task: null,
          }),
          batch: {
            getCurrent: async () => current,
            prepare: async () => {
              calls.push('prepare');
              return {
                status: 'ready',
                preparation: {
                  preparationId: key,
                  storeName: '测试门店',
                  items: [item],
                },
              };
            },
            start: async () => {
              calls.push('start');
              current = {
                id: key,
                revision: 1,
                state: 'running',
                storeName: '测试门店',
                stopRequested: false,
                reason: null,
                counts: {
                  total: 1,
                  saved: 0,
                  failed: 0,
                  skipped: 0,
                  pending: 1,
                  needsHuman: 0,
                  stopped: 0,
                },
                items: [{ ...item, state: 'running' }],
              };
              if (lost) throw Error('lost');
              return { status: 'ok', view: current };
            },
            stop: async () => {
              calls.push('stop');
              current = {
                ...(current as object),
                revision: 2,
                state: 'stopped',
                stopRequested: true,
                items: [{ ...item, state: 'stopped' }],
                counts: {
                  total: 1,
                  saved: 0,
                  failed: 0,
                  skipped: 0,
                  pending: 0,
                  needsHuman: 0,
                  stopped: 1,
                },
              };
              return { status: 'ok', view: current };
            },
            finish: async () => ({ status: 'ok', view: current }),
          },
        },
      });
    },
    { key, lost },
  );
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: readFileSync(resolve('.tmp/batch-renderer/app.css'), 'utf8'),
  });
  await page.addScriptTag({
    content: readFileSync(resolve('.tmp/batch-renderer/app.js'), 'utf8'),
  });
}
test('requires summary confirmation, shows durable progress and stops at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await boot(page);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(page.getByText('目标门店：测试门店')).toBeVisible();
  await expect(page.getByText('测试文章', { exact: true })).toBeVisible();
  await expect(page.locator('.draft-panel')).not.toContainText(
    /原创|转载|声明/,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual(['prepare']);
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(page.getByText(/正在上传/)).toBeVisible();
  await page.screenshot({
    path: '.tmp/batch-renderer/running-narrow.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '停止本批次' }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual(['prepare', 'start', 'stop']);
});
test('lost start reply reads durable batch without submitting again', async ({
  page,
}) => {
  await boot(page, true);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(page.getByText(/正在上传/)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { batchCalls: string[] }).batchCalls.filter(
          (x) => x === 'start',
        ).length,
    ),
  ).toBe(1);
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
});

test('remount reads an existing batch without starting it again', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(page.getByText(/正在上传/)).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { remountBatch(): void }).remountBatch(),
  );
  await expect(page.getByText(/正在上传/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual(['prepare', 'start']);
});

test('finishing an interrupted batch displays the returned stopped state without resubmission', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(page.getByText(/正在上传/)).toBeVisible();
  await page.evaluate(async () => {
    const api = window.desktopApi.batch;
    const current = await api.getCurrent();
    if (!current) throw Error('fixture');
    const view = {
      ...current,
      state: 'interrupted' as const,
      stopRequested: true,
      reason: 'RESULT_AMBIGUOUS' as const,
    };
    api.getCurrent = async () => view;
    api.finish = async () => {
      (window as unknown as { batchCalls: string[] }).batchCalls.push('finish');
      const stopped = {
        ...view,
        revision: view.revision + 1,
        state: 'stopped' as const,
        items: view.items.map((item) => ({
          ...item,
          state: 'stopped' as const,
        })),
        counts: { ...view.counts, pending: 0, stopped: 1 },
      };
      api.getCurrent = async () => stopped;
      return { status: 'ok', view: stopped };
    };
  });
  await expect(page.getByText('上次批次已中断', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '结束本批次' }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual(['prepare', 'start', 'finish']);
});
test('each article keeps a separate cover warning', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        desktopApi: { batch: { getCurrent: () => Promise<unknown> } };
      }
    ).desktopApi.batch;
    api.getCurrent = async () => ({
      id: '11111111-1111-4111-8111-111111111111',
      revision: 3,
      state: 'completed',
      storeName: '测试门店',
      stopRequested: false,
      reason: null,
      counts: {
        total: 1,
        saved: 1,
        failed: 0,
        skipped: 0,
        pending: 0,
        needsHuman: 0,
        stopped: 0,
      },
      items: [
        {
          articleKey: '11111111-1111-4111-8111-111111111111',
          title: '测试文章',
          contentDeclaration: 'original',
          coverSummary: { mode: 'none', imageCount: 0, images: [] },
          taskId: null,
          state: 'draft_saved',
          reason: null,
          coverReport: {
            phase: 'needs_human',
            requestedMode: 'single',
            expectedCount: 1,
            confirmedCount: 0,
            reason: 'COVER_MISMATCH',
            updatedAt: '2026-10-15T00:00:00.000Z',
          },
        },
      ],
    });
  });
  await expect(
    page.getByText('重开草稿后的封面与所选图片不一致。'),
  ).toBeVisible();
});

test('unknown start without a durable batch never enables a second submission', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.desktopApi.batch.start = async () => {
      throw Error('unknown');
    };
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(
    page.getByText('操作回复未确认，正在核对批次记录；请勿重复开始。'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
});

test('all failed preflight items remain readable and cannot start', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const original = window.desktopApi.batch.prepare;
    window.desktopApi.batch.prepare = async (input) => {
      const result = await original(input);
      if (result.status === 'ready')
        result.preparation.items = result.preparation.items.map((item) => ({
          ...item,
          state: 'failed',
          reason: 'ASSET_UNAVAILABLE',
        }));
      return result;
    };
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(
    page.getByText('文章图片无法读取，请检查本地素材。'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeDisabled();
});

test('failed state read blocks new work and recovers only after a successful read', async ({
  page,
}) => {
  await boot(page);
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.desktopApi.batch.getCurrent = async () => {
      throw Error('read unavailable');
    };
  });
  await expect(page.getByText('批次状态暂时无法确认，正在核对…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.desktopApi.batch.getCurrent = async () => null;
  });
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual([]);
});

test('a hung read preserves stop access and cannot roll back its durable reply', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(page.getByText(/正在上传/)).toBeVisible();
  await page.evaluate(() => {
    const original = window.desktopApi.batch.getCurrent;
    window.desktopApi.batch.getCurrent = async () => {
      const stale = await original();
      return new Promise((resolve) =>
        Object.assign(window, { releaseBatchRead: () => resolve(stale) }),
      );
    };
  });
  await expect(page.getByText('批次状态暂时无法确认，正在核对…')).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: '停止本批次' }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseBatchRead(): void }).releaseBatchRead(),
  );
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { batchCalls: string[] }).batchCalls,
    ),
  ).toEqual(['prepare', 'start', 'stop']);
});

test('failed article handover explains the blocker and never silently starts a batch', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => Reflect.set(window, 'handoverBlocked', true));
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(page.getByRole('alert')).toContainText('请先停止操作');
  expect(await page.evaluate(() => Reflect.get(window, 'batchCalls'))).toEqual(
    [],
  );
  await page.evaluate(() => Reflect.set(window, 'handoverBlocked', false));
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeEnabled();
});

test('operator-reviewed submissions are attempted counts, never saved successes', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(page.getByText(/保存结果由运营人员核对/)).toBeVisible();
  await page.evaluate(() => {
    const start = window.desktopApi.batch.start;
    window.desktopApi.batch.start = async (input) => {
      const result = await start(input);
      if (result.view) {
        result.view.state = 'completed';
        result.view.items = result.view.items.map((item) => ({
          ...item,
          state: 'submission_recorded',
          submission: {
            observation: 'unknown',
            attemptedAt: '2026-10-16T12:00:00.000Z',
          },
        }));
        result.view.counts = {
          ...result.view.counts,
          attempted: 1,
          saved: 0,
          pending: 0,
        };
      }
      return result;
    };
  });
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(
    page.getByText('本批次尝试已结束，保存结果待人工核对'),
  ).toBeVisible();
  await expect(page.getByText(/已尝试保存 1/)).toBeVisible();
  await expect(page.getByRole('listitem')).toContainText(
    '已尝试保存（待人工核对）',
  );
  await expect(
    page.getByRole('button', { name: '检查批量草稿摘要' }),
  ).toBeEnabled();
});

for (const [observation, stopped, message] of [
  ['acknowledged', false, '平台已响应，实际草稿待人工核对'],
  ['rejected', false, '保存返回失败，待人工核对'],
  ['unknown', false, '保存结果未知，待人工核对'],
  ['pending', false, '草稿状态尚未确认，请先核对后台记录。'],
  ['acknowledged', true, '平台已响应，实际草稿待人工核对'],
  ['rejected', true, '保存返回失败，待人工核对'],
  ['unknown', true, '保存结果未知，待人工核对'],
] as const)
  test(`persisted operator result remains visible ${observation} stopped=${stopped}`, async ({
    browser,
    page,
  }) => {
    const platform = await browser.newContext();
    try {
      const result = await operatorSettlement(
        platform,
        await platform.newPage(),
        observation,
        stopped ? 'settling' : undefined,
      );
      await boot(page);
      await page.evaluate((view) => {
        window.desktopApi.batch.getCurrent = async () => view;
        Reflect.get(window, 'remountBatch')();
      }, result.view);
      const item = page
        .getByRole('listitem')
        .filter({ hasText: 'Durable operator result' });
      await expect(item).toContainText(message);
      await expect(item).not.toContainText('草稿已保存');
      if (stopped)
        await expect(item).toContainText('已请求停止，请核对已完成的操作。');
    } finally {
      await platform.close();
    }
  });

test('shared cover previews replacement scope before saving and applies only selected articles', async ({
  page,
}) => {
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await expect(page.getByRole('group', { name: '统一封面确认' })).toContainText(
    '所选 2 篇，其中 1 篇已有封面将被替换',
  );
  expect(await coverCalls(page, 'save')).toHaveLength(0);
  await page.getByRole('button', { name: '确认应用到所选文章' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '已为所选 2 篇' }),
  ).toBeVisible();
  expect(await coverCalls(page, 'pick')).toHaveLength(1);
  expect(await coverCalls(page, 'save')).toHaveLength(2);
  expect(await coverCalls(page, 'copy')).toHaveLength(1);
  expect(
    await page.evaluate(
      async () =>
        await window.desktopApi.getArticleCover(
          '33333333-3333-4333-8333-333333333333',
        ),
    ),
  ).toMatchObject({ configuration: { coverRevision: 0 } });
});

async function coverCalls(page: Page, kind: string) {
  return page.evaluate(
    (kind) =>
      Reflect.get(window, 'coverFixture')
        .log()
        .filter((r: string[]) => r[0] === kind),
    kind,
  );
}
async function bootCovers(page: Page) {
  await page.addInitScript(() => Object.assign(window, { desktopApi: {} }));
  await installCoverBridge(page);
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost/covers');
  await page.evaluate(() => {
    Reflect.get(window, 'coverFixture').configure(
      '22222222-2222-4222-8222-222222222222',
      'single',
      1,
    );
    Object.assign(window.desktopApi, {
      getArticlePreview: async (key: string) => ({
        status: 'ok',
        article: {
          articleKey: key,
          externalId: 'article-' + key,
          title: key.startsWith('1') ? '露营出游文章' : '长途舒适文章',
          contentDeclaration: 'repost',
          imageCount: key.startsWith('1') ? 9 : 3,
          articleRevision: 1,
          createdAt: '2026-10-16T00:00:00.000Z',
          editorBody: {
            version: 2,
            blocks: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '原文', marks: [] }],
              },
            ],
          },
          body: [{ type: 'paragraph', text: '原文' }],
          assets: [],
        },
      }),
    });
  });
  await page.addStyleTag({
    content: readFileSync(resolve('.tmp/batch-renderer/app.css'), 'utf8'),
  });
  await page.addScriptTag({
    content: readFileSync(resolve('.tmp/batch-renderer/app.js'), 'utf8'),
  });
  await page.evaluate(() => Reflect.get(window, 'renderBatchCoverHarness')());
  await expect(
    page.getByRole('button', { name: '为所选文章选择同一张封面' }),
  ).toBeEnabled();
}
test('cancelling shared cover leaves configurations untouched', async ({
  page,
}) => {
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await page.getByRole('button', { name: '取消统一封面' }).click();
  await expect(
    page.getByRole('group', { name: '统一封面确认' }),
  ).not.toBeVisible();
  expect(await coverCalls(page, 'save')).toHaveLength(0);
  expect(
    await page.evaluate(
      async () =>
        await window.desktopApi.getArticleCover(
          '22222222-2222-4222-8222-222222222222',
        ),
    ),
  ).toMatchObject({ configuration: { coverRevision: 1 } });
});
test('stop or changed selection invalidates an unconfirmed cover, and footer remains reachable at 800x600', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  const stop = page.getByRole('button', {
    name: /停止所有未完成操作|停止并初始化/,
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const box = await stop.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  await stop.click();
  await expect(
    page.getByRole('group', { name: '统一封面确认' }),
  ).not.toBeVisible();
  expect(await coverCalls(page, 'save')).toHaveLength(0);
  await page.evaluate(() => Reflect.get(window, 'changeCoverSelection')());
  await expect(
    page.getByRole('button', { name: '配置封面：长途舒适文章' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '配置封面：长途舒适文章' }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'editedCover'))).toBe(
    '22222222-2222-4222-8222-222222222222',
  );
  await page.screenshot({
    path: '.tmp/batch-renderer/cover-layout-800x600.png',
    fullPage: true,
  });
});

test('stop during first local save prevents a second article or automatic retry', async ({
  page,
}) => {
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await page.evaluate(() => {
    const save = window.desktopApi.saveCoverEdit;
    window.desktopApi.saveCoverEdit = async (input) => {
      Reflect.set(window, 'coverSaveWaiting', true);
      await new Promise<void>((resolve) =>
        Reflect.set(window, 'releaseCoverSave', resolve),
      );
      return save(input);
    };
  });
  await page.getByRole('button', { name: '确认应用到所选文章' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'coverSaveWaiting')))
    .toBe(true);
  await page
    .getByRole('button', { name: /停止所有未完成操作|停止并初始化/ })
    .click();
  await page.evaluate(() => Reflect.get(window, 'releaseCoverSave')());
  await expect(
    page.getByText('封面操作已停止，已保存的本地配置保留，请核对后继续。'),
  ).toBeVisible();
  expect(await coverCalls(page, 'save')).toHaveLength(1);
  expect(await coverCalls(page, 'copy')).toHaveLength(0);
});
test('a local cover failure reports partial completion without repeating saves', async ({
  page,
}) => {
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await page.evaluate(() => {
    window.desktopApi.copyCoverImage = async () => {
      throw Error('local image unavailable');
    };
  });
  await page.getByRole('button', { name: '确认应用到所选文章' }).click();
  await expect(
    page.getByText('已确认更新 1/2 篇封面', { exact: false }),
  ).toBeVisible();
  expect(await coverCalls(page, 'save')).toHaveLength(1);
});

test('completed stop retires a lost cover save response without waiting for it', async ({
  page,
}) => {
  await bootCovers(page);
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await page.evaluate(() => {
    const save = window.desktopApi.saveCoverEdit;
    window.desktopApi.saveCoverEdit = async (input) => {
      const result = await save(input);
      Reflect.set(window, 'coverResponseHeld', true);
      await new Promise<void>((resolve) =>
        Reflect.set(window, 'releaseLostCoverReply', resolve),
      );
      return result;
    };
  });
  await page.getByRole('button', { name: '确认应用到所选文章' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'coverResponseHeld')))
    .toBe(true);
  await page
    .getByRole('button', { name: /停止所有未完成操作|停止并初始化/ })
    .click();
  await expect(
    page.getByRole('button', { name: '为所选文章选择同一张封面' }),
  ).toBeEnabled();
  await page.evaluate(() => Reflect.get(window, 'releaseLostCoverReply')());
  expect(await coverCalls(page, 'save')).toHaveLength(1);
  expect(await coverCalls(page, 'copy')).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: '为所选文章选择同一张封面' }),
  ).toBeEnabled();
});

test('completed reset retires a hung batch preparation and ignores its late reply', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const api = window.desktopApi.batch;
    const original = api.prepare;
    let resolve!: (v: Awaited<ReturnType<typeof original>>) => void;
    const hung = new Promise<Awaited<ReturnType<typeof original>>>(
      (r) => (resolve = r),
    );
    api.prepare = () => hung;
    Object.assign(window, {
      releaseOldPreparation: async () =>
        resolve(
          await original({
            articleKeys: ['11111111-1111-4111-8111-111111111111'],
            bindingToken: '11111111-1111-4111-8111-111111111111',
          }),
        ),
      restorePreparation: () => {
        api.prepare = original;
      },
    });
  });
  const prepare = page.getByRole('button', { name: '检查批量草稿摘要' });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(prepare).toBeDisabled();
  await page.evaluate(() => {
    Reflect.get(window, 'restorePreparation')();
    Reflect.get(window, 'resetBatch')();
  });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '取消摘要' }).click();
  await page.evaluate(() => Reflect.get(window, 'releaseOldPreparation')());
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
});

test('authoritative stopped state retires a lost stop reply and completes initialization once', async ({
  page,
}) => {
  await boot(page);
  await page.clock.install();
  await page.evaluate(() => {
    Object.assign(window.desktopApi, {
      requestStopAll: () => new Promise(() => {}),
      getOperationControlState: async () => ({
        revision: 2,
        phase: 'stopped',
        owners: [{ scope: 'draft', state: 'idle' }],
      }),
    });
    Reflect.get(window, 'renderStopHarness')();
  });
  const stop = page.getByRole('button', {
    name: /停止所有未完成操作|停止并初始化/,
  });
  await stop.click();
  await page.clock.fastForward(11000);
  await expect(stop).toBeEnabled();
  await expect(page.getByLabel('初始化次数')).toHaveText('1');
});

test('stop remains usable for a fresh read when an earlier release query never returns', async ({
  page,
}) => {
  await boot(page);
  await page.clock.install();
  await page.evaluate(() => {
    Object.assign(window.desktopApi, {
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopping',
        owners: [{ scope: 'draft', state: 'active' }],
      }),
      getOperationControlState: () => new Promise(() => {}),
    });
    Reflect.get(window, 'renderStopHarness')();
  });
  const stop = page.getByRole('button', { name: /停止并初始化/ });
  await stop.click();
  await page.clock.fastForward(1500);
  await expect(stop).toBeEnabled();
  await page.evaluate(() => {
    window.desktopApi.getOperationControlState = async () => ({
      revision: 2,
      phase: 'stopped',
      owners: [{ scope: 'draft', state: 'idle' }],
    });
  });
  await stop.click();
  await expect(page.getByLabel('初始化次数')).toHaveText('1');
});

test('a new selection clears a stale busy notice and keeps completed results in a separate history region', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const start = window.desktopApi.batch.start;
    window.desktopApi.batch.start = async (input) => {
      const result = await start(input);
      if (result.view) {
        result.view.state = 'completed';
        result.view.items = result.view.items.map((item) => ({
          ...item,
          state: 'submission_recorded',
          submission: {
            observation: 'acknowledged',
            attemptedAt: '2026-10-16T12:00:00.000Z',
          },
        }));
        result.view.counts = {
          total: 1,
          attempted: 1,
          saved: 0,
          failed: 0,
          skipped: 0,
          pending: 0,
          needsHuman: 0,
          stopped: 0,
        };
      }
      return result;
    };
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await page.getByRole('button', { name: '确认逐篇存草稿' }).click();
  await expect(
    page.getByText('本批次尝试已结束，保存结果待人工核对'),
  ).toBeVisible();
  await page.evaluate(() => {
    window.desktopApi.batch.prepare = async () => ({
      status: 'blocked',
      reason: 'PLATFORM_BUSY',
    });
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(page.getByRole('alert')).toContainText('当前有操作尚未结束');
  await page.evaluate(() =>
    Reflect.get(
      window,
      'changeBatchSelection',
    )(['22222222-2222-4222-8222-222222222222']),
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  const history = page.getByRole('region', {
    name: '上一批次记录',
    exact: true,
  });
  await expect(history).toContainText('测试文章');
  const current = page.getByRole('region', {
    name: '本次上传确认',
    exact: true,
  });
  await expect(current).not.toContainText('已尝试 1 / 1');
  await page.evaluate(() => {
    window.desktopApi.batch.prepare = async () => ({
      status: 'ready',
      preparation: {
        preparationId: '22222222-2222-4222-8222-222222222222',
        storeName: '测试门店',
        items: [
          {
            articleKey: '22222222-2222-4222-8222-222222222222',
            title: '新选择的文章',
            contentDeclaration: 'repost',
            coverSummary: null,
            taskId: null,
            state: 'queued',
            reason: null,
          },
        ],
      },
    });
  });
  await current.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(current).toContainText('新选择的文章');
  await expect(current).not.toContainText('测试文章');
  await expect(history).not.toContainText('新选择的文章');
});

test('an all-submitted summary says previously submitted without claiming saved or enabling replay', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.desktopApi.batch.prepare = async () => ({
      status: 'ready',
      preparation: {
        preparationId: '11111111-1111-4111-8111-111111111111',
        storeName: '测试门店',
        items: [
          {
            articleKey: '11111111-1111-4111-8111-111111111111',
            title: '此前提交文章',
            contentDeclaration: 'repost',
            coverSummary: null,
            taskId: null,
            state: 'skipped',
            reason: null,
            submission: {
              observation: 'unknown',
              attemptedAt: '2026-10-16T12:00:00.000Z',
            },
          },
        ],
      },
    });
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(page.getByRole('listitem')).toContainText(
    '此前已提交，本次跳过',
  );
  await expect(page.getByRole('listitem')).not.toContainText('已保存，跳过');
  await expect(page.getByText('保存结果未知，待人工核对')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, 'batchCalls'))).toEqual(
    [],
  );
});

test('new-attempt choices default off, invalidate the old summary and freeze intent in the next request', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const api = window.desktopApi.batch;
    const prepare = api.prepare;
    api.prepare = async (input) => {
      Reflect.set(window, 'lastAttemptInput', input);
      return prepare(input);
    };
  });
  const choice = page.getByRole('checkbox', { name: '第1篇作为新尝试' });
  await expect(choice).not.toBeChecked();
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(
    page.getByText('选择1篇，可执行1篇，跳过0篇，需处理0篇'),
  ).toBeVisible();
  await choice.check();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'lastAttemptInput').newAttemptArticleKeys,
    ),
  ).toEqual([key]);
});
test('an all-skipped summary explains why start is disabled and exposes the human new-attempt choice', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => Reflect.get(window, 'fixBatchBar')());
  await page.evaluate(() => {
    window.desktopApi.batch.prepare = async () => ({
      status: 'ready',
      preparation: {
        preparationId: '11111111-1111-4111-8111-111111111111',
        storeName: '测试门店',
        items: [
          {
            articleKey: '11111111-1111-4111-8111-111111111111',
            title: '测试文章',
            contentDeclaration: 'original',
            coverSummary: { mode: 'none', imageCount: 0, images: [] },
            state: 'skipped',
            reason: null,
            taskId: null,
          },
        ],
      },
    });
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  await expect(
    page.getByRole('button', { name: '确认逐篇存草稿' }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /本次无可执行文章/ })
      .first(),
  ).toBeVisible();
  const actions = page.getByRole('region', { name: '草稿执行操作' });
  await expect(actions).toHaveClass(/fixed/);
  await expect(actions).toContainText('本次无可执行文章');
  await expect(actions).toContainText('作为新尝试');
  await expect(actions).not.toContainText('准备上传 1 篇');
  await expect(
    page.getByRole('checkbox', { name: '第1篇作为新尝试' }),
  ).toBeVisible();
});

test('the fixed action bar counts executable articles in a mixed skipped selection', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => Reflect.get(window, 'fixBatchBar')());
  await page.evaluate(() => {
    Reflect.get(
      window,
      'changeBatchSelection',
    )([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    window.desktopApi.batch.prepare = async () => ({
      status: 'ready',
      preparation: {
        preparationId: '11111111-1111-4111-8111-111111111111',
        storeName: '测试门店',
        items: ['skipped', 'queued'].map((state, index) => ({
          articleKey:
            index === 0
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          title: '文章' + index,
          contentDeclaration: 'original',
          coverSummary: { mode: 'none', imageCount: 0, images: [] },
          state: state as 'queued' | 'skipped',
          reason: null,
          taskId: null,
        })),
      },
    });
  });
  await page.getByRole('button', { name: '检查批量草稿摘要' }).click();
  const actions = page.getByRole('region', { name: '草稿执行操作' });
  await expect(actions).toHaveClass(/fixed/);
  await expect(actions).toContainText('准备上传 1 篇');
  await expect(actions).not.toContainText('准备上传 2 篇');
  await expect(
    page.getByText('选择2篇，可执行1篇，跳过1篇，需处理0篇'),
  ).toBeVisible();
});

test('manual skip binds current identity, disables pending recovery and keeps unknown-save history visible', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate((key) => {
    const api = window.desktopApi.batch;
    const view = {
      id: key,
      revision: 7,
      state: 'paused' as const,
      storeName: '测试门店',
      stopRequested: false,
      reason: 'RESULT_AMBIGUOUS' as const,
      counts: {
        total: 1,
        saved: 0,
        attempted: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        needsHuman: 1,
        stopped: 0,
      },
      items: [
        {
          articleKey: key,
          title: '测试文章',
          contentDeclaration: 'original' as const,
          coverSummary: null,
          taskId: key,
          state: 'needs_human' as const,
          reason: 'RESULT_AMBIGUOUS' as const,
          saveAttempted: true,
        },
      ],
    };
    api.getCurrent = async () => view;
    api.skipCurrentAndContinue = async (input) => {
      Reflect.set(window, 'recoveryInput', input);
      await new Promise<void>((resolve) =>
        Reflect.set(window, 'releaseRecovery', resolve),
      );
      return { status: 'blocked', reason: 'LOGIN_REQUIRED', view };
    };
  }, key);
  await page.getByRole('button', { name: '跳过这篇，继续上传' }).click();
  await expect(page.getByRole('button', { name: '正在接续…' })).toBeDisabled();
  expect(
    await page.evaluate(() => Reflect.get(window, 'recoveryInput')),
  ).toEqual({ batchId: key, expectedRevision: 7, taskId: key });
  await page.evaluate(() => Reflect.get(window, 'releaseRecovery')());
  await expect(
    page.getByRole('button', { name: '跳过这篇，继续上传' }),
  ).toBeEnabled();
  await expect(
    page.getByText('请在专用浏览器中登录，再检查登录状态。'),
  ).toBeVisible();
  await page.evaluate(() => {
    const api = window.desktopApi.batch;
    api.skipCurrentAndContinue = async () => {
      const current = (await api.getCurrent())!;
      const view = {
        ...current,
        revision: 8,
        state: 'completed' as const,
        reason: null,
        counts: { ...current.counts, needsHuman: 0, skipped: 1 },
        items: current.items.map((item) => ({
          ...item,
          state: 'skipped' as const,
        })),
      };
      api.getCurrent = async () => view;
      return { status: 'ok', view };
    };
  });
  await page.getByRole('button', { name: '跳过这篇，继续上传' }).click();
  await expect(
    page.getByText('曾尝试保存，原保存结果仍需人工核对；不会重传这篇。'),
  ).toBeVisible();
  await expect(page.getByText(/已跳过/)).toBeVisible();
});

test('restart without a current task exposes explicit untouched-queue recovery', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate((key) => {
    const api = window.desktopApi.batch;
    const view = {
      id: key,
      revision: 9,
      state: 'interrupted' as const,
      storeName: '测试门店',
      stopRequested: true,
      reason: 'RESULT_AMBIGUOUS' as const,
      counts: {
        total: 1,
        saved: 0,
        attempted: 0,
        failed: 0,
        skipped: 0,
        pending: 1,
        needsHuman: 0,
        stopped: 0,
      },
      items: [
        {
          articleKey: key,
          title: '测试文章',
          contentDeclaration: 'original' as const,
          coverSummary: null,
          taskId: null,
          state: 'queued' as const,
          reason: null,
        },
      ],
    };
    api.getCurrent = async () => view;
    api.skipCurrentAndContinue = async (input) => {
      Reflect.set(window, 'recoveryInput', input);
      return { status: 'blocked', reason: 'LOGIN_REQUIRED', view };
    };
  }, key);
  await page.getByRole('button', { name: '继续上传', exact: true }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'recoveryInput')),
  ).toEqual({ batchId: key, expectedRevision: 9, taskId: null });
});

import { test, expect, type Page } from '@playwright/test';
import { mount as mountEditor, body } from './article-workspace-fixture';
async function returnToPool(page: Page) {
  const back = page.getByRole('button', { name: '返回文章池', exact: true });
  if (await back.isVisible()) await back.click();
}
async function mount(...args: Parameters<typeof mountEditor>) {
  await mountEditor(...args);
  await returnToPool(args[0]);
}
async function edit(page: Page) {
  if (!(await body(page).isVisible()))
    await page.getByRole('button', { name: /文章1 文章编号/ }).click();
  await expect(body(page)).toBeEditable();
}

const cover = (p: Page) => p.getByRole('region', { name: '封面图片' });
test('stop while cover leave is reading prevents late selection and editor handover', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await page.evaluate(() => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const read = window.desktopApi.getCoverEditState;
    Object.assign(window, {
      delayedCoverLeave: { release, waiting: () => waiting, mutations: [] },
    });
    Object.assign(window.desktopApi, {
      getCoverEditState: async () => {
        waiting = true;
        await pending;
        return read();
      },
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    });
    for (const name of [
      'closeCoverEdit',
      'closeManualEditor',
      'openManualArticle',
    ] as const) {
      const original = window.desktopApi[name];
      Object.assign(window.desktopApi, {
        [name]: async (...args: unknown[]) => {
          Reflect.get(window, 'delayedCoverLeave').mutations.push(name);
          return Reflect.apply(original, window.desktopApi, args);
        },
      });
    }
  });
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'delayedCoverLeave').waiting()),
    )
    .toBe(true);
  await page
    .getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    })
    .click();
  await page.evaluate(() => Reflect.get(window, 'delayedCoverLeave').release());
  await expect(
    page.getByRole('button', { name: '新建文章', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'delayedCoverLeave').mutations,
    ),
  ).toEqual([]);
  await expect(
    page.getByRole('dialog', { name: '离开封面编辑？' }),
  ).not.toBeVisible();
});
test('stop during save-and-return composition wait prevents late commit and close', async ({
  page,
}) => {
  test.setTimeout(20000);
  await mount(page);
  await edit(page);
  await body(page).fill('停止时保留的修改');
  await page.evaluate(() => {
    Object.assign(window, { lateHandoverCalls: [] });
    for (const name of ['commitManualDocument', 'closeManualEditor'] as const) {
      const original = window.desktopApi[name];
      Object.assign(window.desktopApi, {
        [name]: async (...args: unknown[]) => {
          Reflect.get(window, 'lateHandoverCalls').push(name);
          return Reflect.apply(original, window.desktopApi, args);
        },
      });
    }
    Object.assign(window.desktopApi, {
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    });
  });
  await returnToPool(page);
  const dialog = page.getByRole('dialog', { name: '离开当前编辑？' });
  await expect(dialog).toBeVisible();
  await body(page).dispatchEvent('compositionstart');
  await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page
    .getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    })
    .click();
  await body(page).dispatchEvent('compositionend');
  await expect(
    page.getByRole('button', { name: '返回文章池', exact: true }),
  ).toBeEnabled();
  await expect(body(page)).toHaveText('停止时保留的修改');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'lateHandoverCalls')))
    .toEqual([]);
});
test('stop is reachable in dirty cover handover and retains candidates', async ({
  page,
}) => {
  test.setTimeout(20000);
  await mount(page);
  await begin(page);
  await cover(page).getByRole('radio', { name: '单图', exact: true }).check();
  await pick(page);
  await page.evaluate(() => {
    Object.assign(window, { afterStopCoverCalls: [] });
    for (const name of ['saveCoverEdit', 'closeCoverEdit'] as const) {
      const original = window.desktopApi[name];
      Object.assign(window.desktopApi, {
        [name]: async (...args: unknown[]) => {
          Reflect.get(window, 'afterStopCoverCalls').push(name);
          return Reflect.apply(original, window.desktopApi, args);
        },
      });
    }
    Object.assign(window.desktopApi, {
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    });
  });
  await page.getByRole('button', { name: '检查登录状态', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '离开封面编辑？' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  expect(
    await page.evaluate(() => Reflect.get(window, 'afterStopCoverCalls')),
  ).toEqual([]);
});
test('stop bypasses pending browser command and waits for actual settlement', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await returnToPool(page);
  await page.evaluate(() => {
    let stopped = false,
      settled = false,
      calls = 0;
    const state = () => ({
      revision: settled ? 2 : 1,
      phase: settled ? 'stopped' : 'stopping',
      owners: [{ scope: 'draft', state: settled ? 'idle' : 'active' }],
    });
    Object.assign(window, {
      stopFixture: {
        calls: () => calls,
        settle: () => {
          settled = true;
        },
        stopped: () => stopped,
      },
    });
    Object.assign(window.desktopApi, {
      checkDraftSession: () => new Promise(() => {}),
      requestStopAll: async () => {
        stopped = true;
        calls++;
        return state();
      },
      getOperationControlState: async () => state(),
    });
  });
  await page.getByRole('button', { name: '检查登录状态', exact: true }).click();
  await page
    .getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    })
    .click();
  await expect(page.getByRole('status', { name: '停止状态' })).toContainText(
    '正在停止',
  );
  expect(
    await page.evaluate(() => Reflect.get(window, 'stopFixture').calls()),
  ).toBe(1);
  await page.evaluate(() => Reflect.get(window, 'stopFixture').settle());
  await expect(page.getByRole('status', { name: '停止状态' })).toContainText(
    '已停止并释放占用',
  );
});
test('stop cancels dirty return without discarding text or reaching browser controls', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await body(page).fill('保留此未保存正文');
  await page.evaluate(() => {
    Object.assign(window, { stopBrowserCalls: 0 });
    Object.assign(window.desktopApi, {
      checkDraftSession: async () => {
        Reflect.set(window, 'stopBrowserCalls', 1);
        throw Error('must not open');
      },
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    });
  });
  await returnToPool(page);
  const dialog = page.getByRole('dialog', { name: '离开当前编辑？' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(body(page)).toHaveText('保留此未保存正文');
  expect(
    await page.evaluate(() => Reflect.get(window, 'stopBrowserCalls')),
  ).toBe(0);
});
test('browser control completes clean editor handover before invoking main', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await returnToPool(page);
  await page.evaluate(() => {
    const check = window.desktopApi.checkDraftSession;
    Object.assign(window.desktopApi, {
      checkDraftSession: async () => {
        const state = await window.desktopApi.getManualArticleState();
        Object.assign(window, { browserHandoverState: state.state });
        return check();
      },
    });
  });
  await page.getByRole('button', { name: '检查登录状态', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'browserHandoverState')),
    )
    .toBe('idle');
});

test('dirty return preserves editor before browser controls become reachable', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await body(page).fill('本机未保存的修改');
  await page.evaluate(() => {
    Object.assign(window, { browserControlCalls: 0 });
    const check = window.desktopApi.checkDraftSession;
    Object.assign(window.desktopApi, {
      checkDraftSession: async () => {
        Reflect.set(
          window,
          'browserControlCalls',
          Reflect.get(window, 'browserControlCalls') + 1,
        );
        return check();
      },
    });
  });
  await returnToPool(page);
  const dialog = page.getByRole('dialog', { name: '离开当前编辑？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(body(page)).toContainText('本机未保存的修改');
  expect(
    await page.evaluate(() => Reflect.get(window, 'browserControlCalls')),
  ).toBe(0);
});
for (const fault of [
  'operation',
  'session',
  'article',
  'cover base',
  'article base',
  'draft revision',
  'idle',
  'pending',
  'not_started',
  'needs_review',
])
  test(
    'queried failed cover save remains held for ' + fault,
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      await page.evaluate((fault) => {
        const read = window.desktopApi.getCoverEditState;
        let request:
          | import('../../src/contracts/article-cover').CoverSaveCommand
          | undefined;
        const lookups: string[] = [];
        let fixed = false,
          writes = 0;
        Object.assign(window, {
          failedProbe: {
            fix: () => {
              fixed = true;
            },
            writes: () => writes,
            lookups: () => [...lookups],
            operationId: () => request?.operationId,
          },
        });
        Object.assign(window.desktopApi, {
          saveCoverEdit: async (
            c: import('../../src/contracts/article-cover').CoverSaveCommand,
          ) => {
            request = c;
            writes++;
            throw Error('lost result');
          },
          getCoverSaveResult: async (id: string) => {
            lookups.push(id);
            return {
              status:
                !fixed &&
                ['pending', 'not_started', 'needs_review'].includes(fault)
                  ? fault
                  : 'failed',
              operationId:
                !fixed && fault === 'operation'
                  ? '00000000-0000-4000-8000-000000000999'
                  : id,
            };
          },
          getCoverEditState: async () => {
            const state = await read();
            if (!request || fixed || !('sessionId' in state)) return state;
            if (fault === 'idle') return { status: 'idle', notice: null };
            if (fault === 'session')
              return {
                ...state,
                sessionId: '00000000-0000-4000-8000-000000000999',
              };
            if (fault === 'article')
              return {
                ...state,
                articleKey: '00000000-0000-4000-8000-000000000999',
              };
            if (fault === 'cover base')
              return {
                ...state,
                baseCoverRevision: state.baseCoverRevision + 1,
              };
            if (fault === 'article base')
              return {
                ...state,
                baseArticleRevision: state.baseArticleRevision + 1,
              };
            if (fault === 'draft revision')
              return { ...state, draftRevision: state.draftRevision + 1 };
            if (fault === 'needs_review')
              return { ...state, notice: 'needs_review' };
            return state;
          },
        });
      }, fault);
      await cover(page)
        .getByRole('button', { name: '保存封面', exact: true })
        .click();
      await expect(cover(page)).toContainText('封面保存结果待核对');
      await cover(page)
        .getByRole('button', { name: '核对封面保存结果', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: '新建文章', exact: true }),
      ).toBeDisabled();
      if (fault === 'idle' || fault === 'article')
        await expect(
          cover(page).getByRole('button', { name: '编辑封面', exact: true }),
        ).toBeDisabled();
      else
        await expect(
          cover(page).getByRole('button', { name: '保存封面', exact: true }),
        ).toBeDisabled();
      expect(
        await page.evaluate(() => Reflect.get(window, 'failedProbe').writes()),
      ).toBe(1);
      await page.evaluate(() => Reflect.get(window, 'failedProbe').fix());
      // The existing background receipt poll can settle before another click.
      // Assert its canonical release instead of racing a removed reconcile button.
      await expect(
        cover(page).getByRole('button', { name: '保存封面', exact: true }),
      ).toBeEnabled();
      const proof = await page.evaluate(() => {
        const fixture = Reflect.get(window, 'failedProbe');
        return {
          writes: fixture.writes(),
          lookups: fixture.lookups(),
          operationId: fixture.operationId(),
        };
      });
      expect(proof.writes).toBe(1);
      expect(proof.lookups.length).toBeGreaterThan(0);
      expect([...new Set(proof.lookups)]).toEqual([proof.operationId]);
    },
  );
for (const transport of ['rejected', 'hung'])
  test(
    'durable failed receipt releases ' +
      transport +
      ' cover save and save-and-leave waiter',
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      const candidate = await page.evaluate(() =>
        Reflect.get(window, 'coverFixture').state(),
      );
      await page.evaluate((transport) => {
        let request: import('../../src/contracts/article-cover').CoverSaveCommand;
        let saves = 0,
          queries = 0;
        Object.assign(window, { failedCounts: () => ({ saves, queries }) });
        Object.assign(window.desktopApi, {
          saveCoverEdit: async (
            c: import('../../src/contracts/article-cover').CoverSaveCommand,
          ) => {
            request = c;
            saves++;
            if (transport === 'rejected') throw Error('lost');
            await new Promise<void>((r) =>
              Object.assign(window, { releaseFailedReply: r }),
            );
            return { status: 'failed', operationId: c.operationId };
          },
          getCoverSaveResult: async (id: string) => {
            queries++;
            return {
              status: 'failed',
              operationId: request?.operationId ?? id,
            };
          },
        });
      }, transport);
      await page.getByRole('button', { name: /文章2 文章编号/ }).click();
      await page
        .getByRole('dialog', { name: '离开封面编辑？' })
        .getByRole('button', { name: '保存并继续', exact: true })
        .click();
      if (transport === 'hung') {
        await expect(cover(page)).toContainText('封面保存结果待核对', {
          timeout: 6000,
        });
        await cover(page)
          .getByRole('button', { name: '核对封面保存结果', exact: true })
          .click();
      }
      await expect(cover(page)).toContainText('封面未保存，请检查图片', {
        timeout: 7000,
      });
      await expect(
        cover(page).getByRole('button', { name: '保存封面', exact: true }),
      ).toBeEnabled();
      expect(
        await page.evaluate(() => Reflect.get(window, 'coverFixture').state()),
      ).toEqual(candidate);
      expect(
        await page.evaluate(() => Reflect.get(window, 'failedCounts')().saves),
      ).toBe(1);
      await page.getByRole('button', { name: /文章2 文章编号/ }).click();
      await expect(
        page.getByRole('dialog', { name: '离开封面编辑？' }),
      ).toBeVisible();
      await page
        .getByRole('dialog', { name: '离开封面编辑？' })
        .getByRole('button', { name: '放弃修改', exact: true })
        .click();
      await begin(page);
      await pick(page);
      if (transport === 'hung')
        await page.evaluate(() => Reflect.get(window, 'releaseFailedReply')());
      await expect(
        cover(page).getByRole('button', { name: '保存封面', exact: true }),
      ).toBeEnabled();
    },
  );
async function begin(p: Page) {
  await returnToPool(p);
  await p.getByRole('button', { name: '编辑封面', exact: true }).click();
  await expect(
    cover(p).getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
}
async function pick(p: Page) {
  await cover(p)
    .getByRole('button', { name: '从本地选择封面', exact: true })
    .click();
}
test('unsaved focused article keeps cover admission unreachable until formal save', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await expect(body(page)).toBeEditable();
  await expect(cover(page)).toBeHidden();
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toHaveCount(0);
});
test('single first edit default and triple needs exactly three with numbered keyboard controls', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await expect(
    cover(page).getByRole('button', { name: '保存封面', exact: true }),
  ).toBeDisabled();
  await cover(page).getByRole('radio', { name: '三图', exact: true }).check();
  await pick(page);
  await expect(cover(page).getByRole('img')).toHaveCount(3);
  await cover(page)
    .getByRole('button', { name: '移除第2张封面', exact: true })
    .click();
  await expect(
    cover(page).getByRole('button', { name: '保存封面', exact: true }),
  ).toBeDisabled();
  await expect(cover(page)).toContainText('还需选择1张');
  await cover(page)
    .getByRole('button', { name: '补充第3张封面', exact: true })
    .click();
  await expect(
    cover(page).getByRole('button', { name: '保存封面', exact: true }),
  ).toBeEnabled();
  const beforeOrder: string[] = await page.evaluate(
    () => Reflect.get(window, 'coverFixture').state().draft.imageTokens,
  );
  await cover(page)
    .getByRole('button', { name: '第3张封面前移', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面已保存到本机');
  const formal = await page.evaluate(() =>
    window.desktopApi.getArticleCover('11111111-1111-4111-8111-111111111111'),
  );
  expect(
    formal.status === 'ok' &&
      formal.configuration.images.map((i) => i.assetKey),
  ).toEqual([beforeOrder[0], beforeOrder[2], beforeOrder[1]]);
  await expect(
    page.getByText('本机文章共 2 篇', { exact: true }),
  ).toBeVisible();
});
test('switch mode requires choosing retained image and none requires explicit removal', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await cover(page).getByRole('radio', { name: '三图', exact: true }).check();
  await pick(page);
  await cover(page).getByRole('radio', { name: '单图', exact: true }).click();
  const d = page.getByRole('dialog', { name: '选择要保留的封面' });
  await expect(d).toBeVisible();
  await d.getByRole('button', { name: '保留第2张封面', exact: true }).click();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await cover(page).getByRole('radio', { name: '无封面', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除当前封面？' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(
    cover(page).getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
});
for (const choice of ['继续编辑', '放弃修改', '保存并继续'])
  test('cover dirty navigation ' + choice, async ({ page }) => {
    await mount(page);
    await begin(page);
    await pick(page);
    await page.getByRole('button', { name: /文章2 文章编号/ }).click();
    const d = page.getByRole('dialog', { name: '离开封面编辑？' });
    await expect(d).toBeVisible();
    await d.getByRole('button', { name: choice, exact: true }).click();
    if (choice === '继续编辑')
      await expect(cover(page).getByRole('img')).toHaveCount(1);
    else {
      await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
      await returnToPool(page);
      await expect(cover(page)).toContainText('未配置封面');
    }
  });
test('dirty return must settle explicitly before cover begins and continue preserves content', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await body(page).fill('未保存正文');
  await returnToPool(page);
  await page
    .getByRole('dialog', { name: '离开当前编辑？' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(body(page)).toHaveText('未保存正文');
  await returnToPool(page);
  await page
    .getByRole('dialog', { name: '离开当前编辑？' })
    .getByRole('button', { name: '保存并继续', exact: true })
    .click();
  await begin(page);
  await expect(
    cover(page).getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
  await expect(page.getByText('未保存正文', { exact: true })).toBeVisible();
});
test('unknown save holds navigation and queries only original receipt', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 2, {
    unknownSave: true,
  });
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面保存结果待核对');
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await expect(
    cover(page).getByRole('button', { name: '保存封面', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'coverFixture').resolveSave());
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面已保存到本机');
  const log = await page.evaluate(() =>
    Reflect.get(window, 'coverFixture').log(),
  );
  expect(log.filter((r: unknown[]) => r[0] === 'save')).toHaveLength(1);
});
test('stored cover reopen remains visible while body editing does not overwrite it', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await cover(page)
    .getByRole('button', { name: '完成封面编辑', exact: true })
    .click();
  await page.getByRole('button', { name: /文章1 文章编号/ }).click();
  await edit(page);
  await body(page).fill('修改后正文');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await returnToPool(page);
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await expect(cover(page)).toContainText('单图');
});
test('late preview different article never creates stray blobs and transfers are singular', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await cover(page).getByRole('radio', { name: '三图', exact: true }).check();
  await page.evaluate(() => Reflect.get(window, 'coverFixture').holdImage());
  await pick(page);
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await page
    .getByRole('dialog', { name: '离开封面编辑？' })
    .getByRole('button', { name: '放弃修改', exact: true })
    .click();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
  await page.evaluate(() => Reflect.get(window, 'releaseCoverImage')());
  await returnToPool(page);
  await expect(cover(page).getByRole('img')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'coverFixture').blobs()),
    )
    .toBe(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'coverFixture').max()),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'image').length,
    ),
  ).toBe(1);
});
test('800x600 accessible errors preserve candidate after failed native pick and cancellation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page);
  await begin(page);
  await pick(page);
  await page.evaluate(() => Reflect.get(window, 'coverFixture').failPick());
  await cover(page)
    .getByRole('button', { name: '替换第1张封面', exact: true })
    .click();
  await expect(cover(page).getByRole('alert')).toContainText('第1张');
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await page.evaluate(() => Reflect.get(window, 'coverFixture').cancelPick());
  await cover(page)
    .getByRole('button', { name: '替换第1张封面', exact: true })
    .click();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 800),
  ).toBe(true);
});

for (const phase of [
  'failed',
  'needs_human',
  'pending',
  'confirmed',
  'legacy',
] as const)
  test(
    'body result remains independent of cover ' + phase,
    async ({ page }) => {
      await mount(page);
      await edit(page);
      await returnToPool(page);
      await page.evaluate((phase) => {
        const task = {
          taskId: '33333333-3333-4333-8333-333333333333',
          articleKey: '11111111-1111-4111-8111-111111111111',
          title: '文章1',
          storeName: '测试门店',
          state: 'draft_saved',
          stage: 'settled',
          revision: 2,
          possibleRemoteEffect: true,
          stopRequested: false,
          platformPaused: false,
          reason: null,
          canOpenDraft: true,
          ...(phase === 'legacy'
            ? {}
            : {
                coverSummary: {
                  mode: 'triple',
                  imageCount: 3,
                  images: [1, 2, 3].map((i) => ({
                    assetKey:
                      '11111111-1111-4111-8111-' + String(i).padStart(12, '0'),
                    mime: 'image/png',
                    width: 1,
                    height: 1,
                  })),
                },
                coverReport: {
                  phase,
                  requestedMode: 'triple',
                  expectedCount: 3,
                  confirmedCount:
                    phase === 'confirmed' || phase === 'pending' ? 3 : 2,
                  reason:
                    phase === 'failed'
                      ? 'UPLOAD_INCOMPLETE'
                      : phase === 'needs_human'
                        ? 'PAGE_UNVERIFIED'
                        : null,
                  updatedAt: '2026-10-09T00:00:00.000Z',
                },
              }),
        };
        Object.assign(window.desktopApi, {
          getDraftState: async () => ({
            session: {
              status: 'ready',
              bindingToken: '11111111-1111-4111-8111-111111111111',
              storeName: '测试门店',
              reason: null,
            },
            task,
            preparation: null,
          }),
          checkDraftSession: async () => ({
            status: 'ok',
            view: await window.desktopApi.getDraftState(),
          }),
        });
      }, phase);
      await page
        .getByRole('button', { name: '检查登录状态', exact: true })
        .click();
      const result = page.getByRole('region', { name: '巨懂车草稿' });
      await expect(result).toContainText('草稿已保存并核对');
      if (phase === 'failed' || phase === 'needs_human') {
        await expect(result).toContainText(
          '草稿已保存；封面未上传成功，请人工补充',
        );
        await expect(result).toContainText('已关联2/3张');
      } else if (phase === 'pending') {
        await expect(result).toContainText('已关联3/3张');
        await expect(result).toContainText('仍待重开核对');
        await expect(result).not.toContainText('封面已上传并核对');
      } else if (phase === 'confirmed')
        await expect(result).toContainText('封面已上传并核对');
      else await expect(result).toContainText('历史封面由人工处理');
    },
  );

test('trusted invalid second file identifies exact slot while atomic multi-pick keeps all previous images', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await cover(page).getByRole('radio', { name: '三图', exact: true }).check();
  await pick(page);
  const old = await page.evaluate(
    () => Reflect.get(window, 'coverFixture').state().draft.imageTokens,
  );
  await page.evaluate(() => {
    const api = window.desktopApi;
    Object.assign(api, {
      pickCoverImages: async () => ({
        ...Reflect.get(window, 'coverFixture').state(),
        notice: 'image_invalid',
        imageFailure: { position: 1, reason: 'IMAGE_INVALID' },
      }),
    });
  });
  await pick(page);
  await expect(cover(page).getByRole('alert')).toContainText('第2张封面');
  await expect(cover(page).getByRole('alert')).not.toContainText('第1张封面');
  await expect(cover(page).getByRole('img')).toHaveCount(3);
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'coverFixture').state().draft.imageTokens,
    ),
  ).toEqual(old);
});

test('formal new-article save enables cover and newly saved none remains none on next edit', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('文章标题').fill('新建正式文章');
  await body(page).fill('新建正文');
  await page.getByRole('button', { name: '保存到本机', exact: true }).click();
  await returnToPool(page);
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeEnabled();
  await begin(page);
  await cover(page).getByRole('radio', { name: '无封面', exact: true }).check();
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await cover(page)
    .getByRole('button', { name: '完成封面编辑', exact: true })
    .click();
  await cover(page)
    .getByRole('button', { name: '编辑封面', exact: true })
    .click();
  await expect(
    cover(page).getByRole('radio', { name: '无封面', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByText('本机文章共 3 篇', { exact: true }),
  ).toBeVisible();
});
test('live canonical platform task disables cover admission but stop remains reachable', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await returnToPool(page);
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const current = {
      session: {
        status: 'ready',
        bindingToken: '11111111-1111-4111-8111-111111111111',
        storeName: '测试门店',
        reason: null,
      },
      preparation: null,
      task: {
        taskId: '33333333-3333-4333-8333-333333333333',
        articleKey: '11111111-1111-4111-8111-111111111111',
        title: '文章1',
        storeName: '测试门店',
        state: 'running',
        stage: 'body',
        revision: 2,
        possibleRemoteEffect: true,
        stopRequested: false,
        platformPaused: false,
        reason: null,
        canOpenDraft: false,
      },
    };
    Object.assign(window.desktopApi, {
      getDraftState: async () => current,
      checkDraftSession: async () => ({ status: 'ok', view: current }),
      stopDraft: async () => {
        current.task.stopRequested = true;
        current.task.revision++;
        return { status: 'ok', view: current };
      },
    });
  });
  await page.getByRole('button', { name: '检查登录状态', exact: true }).click();
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '停止操作', exact: true }).click();
  await expect(page.getByRole('region', { name: '巨懂车草稿' })).toContainText(
    '正在安全停止',
  );
});

for (const mode of ['single', 'triple'] as const)
  test(
    'current-release configured preparation ' +
      mode +
      ' after an enabled none baseline',
    async ({ page }) => {
      await mount(page);
      await edit(page);
      await returnToPool(page);
      await page.evaluate(() => {
        const get = window.desktopApi.getDraftState;
        const prepare = window.desktopApi.prepareDraft;
        let mode: 'none' | 'single' | 'triple' = 'none';
        let current:
          import('../../src/contracts/draft-task').PreparationView | null =
          null;
        const history: import('../../src/contracts/draft-task').PreparationView[] =
          [];
        Object.assign(window, {
          coverPreparationFixture: {
            configure: (next: 'single' | 'triple') => {
              if (!current) throw Error('Expected baseline preparation');
              Reflect.get(window, 'coverFixture').configure(
                current.articleKey,
                next,
                next === 'single' ? 1 : 3,
              );
              mode = next;
              current = null; // Changed cover retires the frozen summary.
            },
            history: () => structuredClone(history),
          },
        });
        Object.assign(window.desktopApi, {
          getDraftState: async () => ({
            ...(await get()),
            preparation: structuredClone(current),
          }),
          prepareDraft: async (...args: Parameters<typeof prepare>) => {
            const result = await prepare(...args);
            if (result.status !== 'ready') return result;
            const positions =
              mode === 'none' ? [] : mode === 'single' ? [1] : [1, 2, 3];
            current = {
              ...result.preparation,
              coverPolicy: 'local-upload-v1',
              coverSummary: {
                mode,
                imageCount: positions.length,
                images: positions.map((i) => ({
                  assetKey:
                    '11111111-1111-4111-8111-' + String(i).padStart(12, '0'),
                  mime: 'image/png',
                  width: 1,
                  height: 1,
                })),
              },
            };
            history.push(structuredClone(current));
            return { status: 'ready', preparation: structuredClone(current) };
          },
          checkDraftSession: async () => ({
            status: 'ok',
            view: await window.desktopApi.getDraftState(),
          }),
        });
      });
      const panel = page.getByRole('region', { name: '巨懂车草稿' });
      const summary = panel.getByRole('heading', {
        name: '请确认本次存草稿摘要',
        exact: true,
      });
      const confirm = panel.getByRole('checkbox', {
        name: '我已核对门店和图文内容，仅存草稿',
        exact: true,
      });
      const start = panel.getByRole('button', {
        name: '存到巨懂车草稿',
        exact: true,
      });
      await panel
        .getByRole('button', { name: '检查文章摘要', exact: true })
        .click();
      await expect(summary).toBeVisible();
      await expect(panel).toContainText('封面：无封面 · 0张');
      await confirm.check();
      await expect(start).toBeEnabled();

      await page.evaluate(
        (mode) =>
          Reflect.get(window, 'coverPreparationFixture').configure(mode),
        mode,
      );
      await page
        .getByRole('region', { name: '专用浏览器', exact: true })
        .getByRole('button', { name: '检查登录状态', exact: true })
        .click();
      await expect(summary).toHaveCount(0);
      await expect(confirm).toHaveCount(0);
      await expect(start).toBeDisabled();
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'workspaceLog')().filter(
            ([name]: [string]) => name === 'start',
          ),
        ),
      ).toEqual([]);

      await panel
        .getByRole('button', { name: '检查文章摘要', exact: true })
        .click();
      await expect(summary).toBeVisible();
      await expect(confirm).not.toBeChecked();
      await expect(start).toBeDisabled();
      const history = (await page.evaluate(() =>
        Reflect.get(window, 'coverPreparationFixture').history(),
      )) as import('../../src/contracts/draft-task').PreparationView[];
      expect(history).toHaveLength(2);
      expect(history[1].preparationId).not.toBe(history[0].preparationId);
      expect(history[0].coverSummary).toEqual({
        mode: 'none',
        imageCount: 0,
        images: [],
      });
      expect(history[1].coverSummary?.mode).toBe(mode);
      await confirm.check();
      if (mode === 'single') {
        await expect(panel).toContainText(
          '单图封面将在正文填写后、存草稿前上传',
        );
        await expect(start).toBeEnabled();
      } else {
        await expect(panel).toContainText('三图封面暂不支持自动存稿。');
        await expect(start).toBeDisabled();
      }
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'workspaceLog')().filter(
            ([name]: [string]) => name === 'start',
          ),
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(
          async () => (await window.desktopApi.getDraftState()).task,
        ),
      ).toBeNull();
    },
  );
for (const notice of ['conflict', 'blocked'] as const)
  test(
    'known cover ' +
      notice +
      ' freezes candidate but discard remains reachable',
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      await page.evaluate(
        (notice) =>
          Object.assign(window.desktopApi, {
            getCoverEditState: async () => ({
              ...Reflect.get(window, 'coverFixture').state(),
              notice,
            }),
          }),
        notice,
      );
      await expect(cover(page).getByRole('alert')).toBeVisible();
      await expect(
        cover(page).getByRole('radio', { name: '三图', exact: true }),
      ).toBeDisabled();
      await expect(
        cover(page).getByRole('button', { name: '保存封面', exact: true }),
      ).toBeDisabled();
      await cover(page)
        .getByRole('button', { name: '完成封面编辑', exact: true })
        .click();
      const d = page.getByRole('dialog', { name: '离开封面编辑？' });
      await expect(
        d.getByRole('button', { name: '保存并继续', exact: true }),
      ).toBeDisabled();
      await d.getByRole('button', { name: '放弃修改', exact: true }).click();
      await expect(
        cover(page).getByRole('button', { name: '编辑封面', exact: true }),
      ).toBeVisible();
    },
  );
test('human dirty-return decision does not start a cover command timeout or submit twice', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await body(page).fill('等待人工决定的正文');
  await returnToPool(page);
  const d = page.getByRole('dialog', { name: '离开当前编辑？' });
  await expect(d).toBeVisible();
  await page.waitForTimeout(3300);
  expect(
    await page.evaluate(() => window.desktopApi.getCoverEditState()),
  ).toMatchObject({ status: 'idle' });
  await expect(page.getByText('状态待核对', { exact: false })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'begin').length,
    ),
  ).toBe(0);
  await d.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(body(page)).toHaveText('等待人工决定的正文');
  await expect(
    page.getByRole('button', { name: '返回文章池', exact: true }),
  ).toBeEnabled();
});
test('committed receipt releases a hung save and late reply cannot unlock another cover save', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await pick(page);
  await page.evaluate(() => {
    const save = window.desktopApi.saveCoverEdit;
    const replies: Array<() => void> = [];
    Object.assign(window, { releaseCoverSave: (i: number) => replies[i]() });
    Object.assign(window.desktopApi, {
      saveCoverEdit: async (
        c: import('../../src/contracts/article-cover').CoverSaveCommand,
      ) => {
        const r = await save(c);
        await new Promise<void>((resolve) => replies.push(resolve));
        return r;
      },
    });
  });
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面保存结果待核对', {
    timeout: 6000,
  });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(
    cover(page).getByRole('button', { name: '完成封面编辑', exact: true }),
  ).toBeEnabled();
  await cover(page)
    .getByRole('button', { name: '完成封面编辑', exact: true })
    .click();
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await page.evaluate(() => Reflect.get(window, 'releaseCoverSave')(0));
  await expect(
    cover(page).getByRole('radio', { name: '三图', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, 'releaseCoverSave')(1));
  await expect(cover(page)).toContainText('封面已保存到本机');
  await expect(
    cover(page).getByRole('button', { name: '完成封面编辑', exact: true }),
  ).toBeEnabled();
});
test('parallel receipt checks share one read and cannot lose the original committed proof', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 2, {
    unknownSave: true,
  });
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await page.evaluate(() => {
    Reflect.get(window, 'coverFixture').resolveSave();
    const query = window.desktopApi.getCoverSaveResult;
    let active = 0,
      max = 0;
    Object.assign(window, { receiptMax: () => max });
    Object.assign(window.desktopApi, {
      getCoverSaveResult: async (id: string) => {
        active++;
        max = Math.max(active, max);
        await new Promise<void>((resolve) =>
          Object.assign(window, { releaseReceipt: resolve }),
        );
        active--;
        return query(id);
      },
    });
  });
  const button = cover(page).getByRole('button', {
    name: '核对封面保存结果',
    exact: true,
  });
  await button.evaluate((b) => {
    (b as HTMLButtonElement).click();
    (b as HTMLButtonElement).click();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'receiptMax')()))
    .toBe(1);
  await page.evaluate(() => Reflect.get(window, 'releaseReceipt')());
  await expect(cover(page)).toContainText('封面已保存到本机');
  expect(await page.evaluate(() => Reflect.get(window, 'receiptMax')())).toBe(
    1,
  );
});

test('native main closure after unknown save accepts only its matching receipt and formal cover', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 2, {
    unknownSave: true,
  });
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'coverFixture');
    f.resolveSave();
    await window.desktopApi.closeCoverEdit(f.state().sessionId);
  });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeEnabled();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'save').length,
    ),
  ).toBe(1);
});

test('legacy batch image failure gives no guessed ordinal and keyboard leave restores focus at 800x600', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await mount(page);
  await begin(page);
  await pick(page);
  await page.evaluate(() => {
    const state = {
      ...Reflect.get(window, 'coverFixture').state(),
      notice: 'image_invalid',
    };
    Object.assign(window.desktopApi, {
      pickCoverImages: async () => state,
      getCoverEditState: async () => state,
    });
  });
  await cover(page)
    .getByRole('button', { name: '替换第1张封面', exact: true })
    .click();
  await expect(cover(page).getByRole('alert')).toContainText('本次选择的封面');
  await expect(cover(page).getByRole('alert')).not.toContainText('第1张封面');
  const finish = cover(page).getByRole('button', {
    name: '完成封面编辑',
    exact: true,
  });
  await finish.focus();
  await page.keyboard.press('Enter');
  const d = page.getByRole('dialog', { name: '离开封面编辑？' });
  await expect(d).toBeVisible();
  await expect(
    d.getByRole('button', { name: '继续编辑', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    d.getByRole('button', {
      name: /停止所有未完成操作|停止并初始化/,
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    d.getByRole('button', { name: '放弃修改', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(d).not.toBeVisible();
  await expect(finish).toBeFocused();
  await expect(cover(page).getByRole('img')).toHaveCount(1);
  await finish.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.tmp/cover-editor-800.png' });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 800),
  ).toBe(true);
});
test('wrong-article committed receipt and mismatched formal cover keep unknown save held', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 2, {
    unknownSave: true,
  });
  await begin(page);
  await pick(page);
  await cover(page)
    .getByRole('button', { name: '保存封面', exact: true })
    .click();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'coverFixture');
    f.resolveSave();
    const original = window.desktopApi.getCoverSaveResult;
    Object.assign(window, { correctCoverReceipt: original });
    Object.assign(window.desktopApi, {
      getCoverSaveResult: async (id: string) => {
        const r = await original(id);
        return r.status === 'committed'
          ? {
              ...r,
              receipt: {
                ...r.receipt,
                articleKey: '22222222-2222-4222-8222-222222222222',
              },
            }
          : r;
      },
    });
  });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面保存结果待核对');
  await expect(
    cover(page).getByRole('button', { name: '完成封面编辑', exact: true }),
  ).toBeDisabled();
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'coverFixture');
    await window.desktopApi.closeCoverEdit(f.state().sessionId);
    const original = window.desktopApi.getArticleCover;
    Object.assign(window, { correctFormalCover: original });
    Object.assign(window.desktopApi, {
      getCoverSaveResult: Reflect.get(window, 'correctCoverReceipt'),
      getArticleCover: async (k: string) => {
        const r = await original(k);
        return r.status === 'ok'
          ? {
              ...r,
              configuration: {
                ...r.configuration,
                coverRevision: r.configuration.coverRevision + 1,
              },
            }
          : r;
      },
    });
  });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(cover(page)).toContainText('封面保存结果待核对');
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    Object.assign(window.desktopApi, {
      getArticleCover: Reflect.get(window, 'correctFormalCover'),
    }),
  );
  // The normal background poll may already remove the reconciliation control.
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeEnabled();
  const log = await page.evaluate(() =>
    Reflect.get(window, 'coverFixture').log(),
  );
  const writes = log.filter((entry: unknown[]) => entry[0] === 'save');
  const receipts = log.filter((entry: unknown[]) => entry[0] === 'receipt');
  expect(writes).toHaveLength(1);
  expect(receipts.length).toBeGreaterThan(0);
  expect([...new Set(receipts.map((entry: unknown[]) => entry[1]))]).toEqual([
    writes[0][1].operationId,
  ]);
});

for (const status of ['conflict', 'blocked'] as const)
  test(
    'acknowledged save ' +
      status +
      ' freezes edits even when canonical notice remains normal',
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      await page.evaluate(
        (status) =>
          Object.assign(window.desktopApi, {
            saveCoverEdit: async (
              c: import('../../src/contracts/article-cover').CoverSaveCommand,
            ) => ({ status, operationId: c.operationId }),
          }),
        status,
      );
      await cover(page)
        .getByRole('button', { name: '保存封面', exact: true })
        .click();
      await expect(cover(page)).toContainText('封面未保存');
      await expect(
        cover(page).getByRole('radio', { name: '三图', exact: true }),
      ).toBeDisabled();
      await expect(
        cover(page).getByRole('button', { name: '完成封面编辑', exact: true }),
      ).toBeEnabled();
      await cover(page)
        .getByRole('button', { name: '完成封面编辑', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '离开封面编辑？' })
        .getByRole('button', { name: '放弃修改', exact: true })
        .click();
      await page.getByRole('button', { name: /文章2 文章编号/ }).click();
      await begin(page);
      await expect(
        cover(page).getByRole('radio', { name: '三图', exact: true }),
      ).toBeEnabled();
    },
  );

test('read-only cover refresh cannot leave editable candidates after a save-and-leave receipt', async ({
  page,
}) => {
  await mount(page);
  await begin(page);
  await pick(page);
  await page.evaluate(() => {
    const get = window.desktopApi.getArticleCover;
    const held: Array<() => void> = [];
    Object.assign(window, {
      coverReadCount: () => held.length,
      releaseCoverReads: () => held.splice(0).forEach((r) => r()),
    });
    Object.assign(window.desktopApi, {
      getArticleCover: async (k: string) => {
        if (
          Reflect.get(window, 'coverFixture').state().notice === 'saved' ||
          Reflect.get(window, 'coverFixture').state().status === 'idle'
        )
          await new Promise<void>((r) => held.push(r));
        return get(k);
      },
    });
  });
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await page
    .getByRole('dialog', { name: '离开封面编辑？' })
    .getByRole('button', { name: '保存并继续', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'coverReadCount')()))
    .toBeGreaterThan(0);
  await expect(
    cover(page).getByRole('radio', { name: '三图', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, 'releaseCoverReads')());
  await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
});

test('authoritative main close after an observed hung begin retires its late reply before another article', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await returnToPool(page);
  await page.evaluate(() => {
    const begin = window.desktopApi.beginCoverEdit;
    let first = true;
    Object.assign(window.desktopApi, {
      beginCoverEdit: async (k: string) => {
        const r = await begin(k);
        if (first) {
          first = false;
          await new Promise<void>((release) =>
            Object.assign(window, { releaseOldBegin: release }),
          );
        }
        return r;
      },
    });
  });
  await page.getByRole('button', { name: '编辑封面', exact: true }).click();
  await expect(cover(page)).toContainText('状态待核对', { timeout: 6000 });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await page.evaluate(async () => {
    const state = Reflect.get(window, 'coverFixture').state();
    await window.desktopApi.closeCoverEdit(state.sessionId);
  });
  await expect(
    cover(page).getByRole('button', { name: '核对封面保存结果', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: /文章2 文章编号/ }).click();
  await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
  await begin(page);
  await page.evaluate(() => Reflect.get(window, 'releaseOldBegin')());
  await expect(
    cover(page).getByRole('radio', { name: '单图', exact: true }),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'coverFixture').state().articleKey,
    ),
  ).toBe('22222222-2222-4222-8222-222222222222');
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'draft').length,
    ),
  ).toBe(1);
});

test('initial idle cannot release a timed-out begin before main admits the original command', async ({
  page,
}) => {
  await mount(page);
  await edit(page);
  await returnToPool(page);
  await page.evaluate(() => {
    const begin = window.desktopApi.beginCoverEdit;
    Object.assign(window.desktopApi, {
      beginCoverEdit: async (k: string) => {
        await new Promise<void>((release) =>
          Object.assign(window, { admitBegin: release }),
        );
        return begin(k);
      },
    });
  });
  await page.getByRole('button', { name: '编辑封面', exact: true }).click();
  await expect(cover(page)).toContainText('状态待核对', { timeout: 6000 });
  await cover(page)
    .getByRole('button', { name: '核对封面保存结果', exact: true })
    .click();
  await expect(
    cover(page).getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'begin').length,
    ),
  ).toBe(0);
  await page.evaluate(() => Reflect.get(window, 'admitBegin')());
  await expect(
    cover(page).getByRole('radio', { name: '单图', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, 'coverFixture')
          .log()
          .filter((r: unknown[]) => r[0] === 'begin').length,
    ),
  ).toBe(1);
});

for (const destination of ['selection', 'finish'] as const)
  test(
    'fix I1 receipt completes same save-and-leave ' +
      destination +
      ' before held transport and protects next dirty prompt',
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      await page.evaluate(() => {
        const save = window.desktopApi.saveCoverEdit;
        Object.assign(window.desktopApi, {
          saveCoverEdit: async (
            c: import('../../src/contracts/article-cover').CoverSaveCommand,
          ) => {
            const r = await save(c);
            await new Promise<void>((release) =>
              Object.assign(window, { releaseLeaveSave: release }),
            );
            return r;
          },
        });
      });
      if (destination === 'selection')
        await page.getByRole('button', { name: /文章2 文章编号/ }).click();
      else
        await cover(page)
          .getByRole('button', { name: '完成封面编辑', exact: true })
          .click();
      await page
        .getByRole('dialog', { name: '离开封面编辑？' })
        .getByRole('button', { name: '保存并继续', exact: true })
        .click();
      await expect(cover(page)).toContainText('封面保存结果待核对', {
        timeout: 6000,
      });
      await cover(page)
        .getByRole('button', { name: '核对封面保存结果', exact: true })
        .click();
      if (destination === 'selection')
        await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
      else {
        await expect(
          cover(page).getByRole('button', { name: '编辑封面', exact: true }),
        ).toBeEnabled();
        await page.getByRole('button', { name: /文章2 文章编号/ }).click();
        await expect(page.getByLabel('文章标题')).toHaveValue('文章2');
      }
      await begin(page);
      await pick(page);
      await cover(page)
        .getByRole('button', { name: '完成封面编辑', exact: true })
        .click();
      const d = page.getByRole('dialog', { name: '离开封面编辑？' });
      await expect(d).toBeVisible();
      await page.evaluate(() => Reflect.get(window, 'releaseLeaveSave')());
      await expect(d).toBeVisible();
      await d.getByRole('button', { name: '继续编辑', exact: true }).click();
      await expect(cover(page).getByRole('img')).toHaveCount(1);
      expect(
        await page.evaluate(
          () => Reflect.get(window, 'coverFixture').state().articleKey,
        ),
      ).toBe('22222222-2222-4222-8222-222222222222');
      expect(
        await page.evaluate(
          () =>
            Reflect.get(window, 'coverFixture')
              .log()
              .filter((r: unknown[]) => r[0] === 'save').length,
        ),
      ).toBe(1);
    },
  );
for (const destination of ['selection', 'finish'] as const)
  test(
    'fix I2 retired close ' +
      destination +
      ' cannot overwrite new same-article dirty session or its leave dialog',
    async ({ page }) => {
      await mount(page);
      await begin(page);
      await pick(page);
      await page.evaluate(() => {
        const close = window.desktopApi.closeCoverEdit;
        let first = true;
        Object.assign(window.desktopApi, {
          closeCoverEdit: async (id: string) => {
            const r = await close(id);
            if (first) {
              first = false;
              await new Promise<void>((release) =>
                Object.assign(window, { releaseRetiredClose: release }),
              );
            }
            return r;
          },
        });
      });
      if (destination === 'selection')
        await page.getByRole('button', { name: /文章2 文章编号/ }).click();
      else
        await cover(page)
          .getByRole('button', { name: '完成封面编辑', exact: true })
          .click();
      await page
        .getByRole('dialog', { name: '离开封面编辑？' })
        .getByRole('button', { name: '放弃修改', exact: true })
        .click();
      await expect(
        cover(page).getByRole('button', { name: '编辑封面', exact: true }),
      ).toBeEnabled({ timeout: 7000 });
      await begin(page);
      await pick(page);
      const before = await page.evaluate(() =>
        Reflect.get(window, 'coverFixture').state(),
      );
      await cover(page)
        .getByRole('button', { name: '完成封面编辑', exact: true })
        .click();
      const d = page.getByRole('dialog', { name: '离开封面编辑？' });
      await expect(d).toBeVisible();
      await page.evaluate(() => Reflect.get(window, 'releaseRetiredClose')());
      await expect(d).toBeVisible();
      await expect(cover(page).getByRole('img')).toHaveCount(1);
      expect(
        await page.evaluate(() => Reflect.get(window, 'coverFixture').state()),
      ).toEqual(before);
      expect(
        await page.evaluate(
          () =>
            Reflect.get(window, 'workspaceLog')().filter(
              (r: unknown[]) =>
                r[0] === 'open' &&
                r[1] === '22222222-2222-4222-8222-222222222222',
            ).length,
        ),
      ).toBe(0);
      await d.getByRole('button', { name: '继续编辑', exact: true }).click();
      await expect(
        cover(page).getByRole('radio', { name: '单图', exact: true }),
      ).toBeChecked();
    },
  );

test('workspace shared cover remains confirmable while selection is frozen, and rows support individual overrides', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 文章1', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 文章2', exact: true }).check();
  await expect(
    page.getByRole('button', { name: '为所选文章选择同一张封面' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '为所选文章选择同一张封面' }).click();
  await expect(page.getByRole('group', { name: '统一封面确认' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '确认应用到所选文章' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('checkbox', { name: '选择 文章1', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '确认应用到所选文章' }).click();
  await expect(
    page.getByText(/已为所选 2 篇文章保存同一张本地封面/),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole('region', { name: '所选文章与封面' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: '.tmp/phase2-cover-layout-1280x900.png' });
  await page
    .getByRole('button', { name: '配置封面：文章2', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '封面图片' })).toContainText(
    '单图',
  );
  await expect(
    page
      .getByRole('region', { name: '封面图片' })
      .getByRole('button', { name: '编辑封面', exact: true }),
  ).toBeEnabled();
});

test('a retired cover state read rejection cannot freeze the initialized workspace again', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const original = window.desktopApi.getCoverEditState;
    let rejectOld!: (e: Error) => void;
    let waiting = false;
    window.desktopApi.getCoverEditState = () => {
      waiting = true;
      return new Promise((_, reject) => {
        rejectOld = reject;
      });
    };
    Object.assign(window, {
      retiredCoverRead: {
        waiting: () => waiting,
        restore: () => {
          window.desktopApi.getCoverEditState = original;
        },
        reject: () => rejectOld(Error('retired read')),
      },
    });
    Object.assign(window.desktopApi, {
      requestStopAll: async () => ({
        revision: 1,
        phase: 'stopped',
        owners: [],
      }),
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'retiredCoverRead').waiting()),
    )
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'retiredCoverRead').restore());
  await page
    .getByRole('region', { name: '全局操作状态' })
    .getByRole('button', { name: /停止并初始化/ })
    .click();
  const fresh = page.getByRole('button', { name: '新建文章', exact: true });
  await expect(fresh).toBeEnabled();
  await page.evaluate(() => Reflect.get(window, 'retiredCoverRead').reject());
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(await fresh.isEnabled()).toBe(true);
});

test('saved row thumbnails discard old page transfers and reload the current head after a cover epoch', async ({
  page,
}) => {
  await mount(page, false, false, false, false, false, 11);
  const firstKey = '11111111-1111-4111-8111-111111111111';
  const lastKey = '11111111-1111-4111-8111-000000000011';
  await page.evaluate(
    ({ firstKey, lastKey }) => {
      const fixture = Reflect.get(window, 'coverFixture');
      fixture.configure(firstKey, 'single', 1);
      fixture.configure(lastKey, 'single', 1);
      fixture.holdImage();
    },
    { firstKey, lastKey },
  );
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof Reflect.get(window, 'releaseCoverImage')),
    )
    .toBe('function');
  await page
    .getByRole('navigation', { name: '文章分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  const lastRow = page
    .locator('.article-rows li')
    .filter({ hasText: '文章11' });
  await expect(lastRow.locator('.article-cover-thumbnail')).toHaveAttribute(
    'data-cover-revision',
    '1',
  );
  await expect(lastRow.locator('.article-cover-thumbnail')).toContainText(
    '正在读取第1张封面',
  );
  await page.evaluate(() => Reflect.get(window, 'releaseCoverImage')());
  await expect(lastRow.locator('.article-cover-thumbnail img')).toBeVisible();
  await expect(page.locator('.article-rows li')).toHaveCount(1);
  expect(
    await page.evaluate(() => Reflect.get(window, 'coverFixture').max()),
  ).toBe(1);
  const blobsBeforeClear = await page.evaluate(() =>
    Reflect.get(window, 'coverFixture').blobs(),
  );
  await page.evaluate(
    (key) => Reflect.get(window, 'coverFixture').configure(key, 'none', 0),
    lastKey,
  );
  await page.getByRole('tab', { name: '单篇存草稿', exact: true }).click();
  await expect(lastRow.locator('.article-cover-thumbnail')).toHaveText(
    '未设封面',
  );
  await expect(lastRow.locator('.article-cover-thumbnail img')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'coverFixture').blobs()),
    )
    .toBeLessThan(blobsBeforeClear);
  await page.evaluate((key) => {
    Reflect.get(window, 'coverFixture').configure(key, 'single', 1);
    window.desktopApi.getCoverImage = async () => ({
      status: 'ok',
      mime: 'image/png',
      bytes: new Uint8Array([1]),
    });
  }, lastKey);
  await page.getByRole('tab', { name: '批量存草稿', exact: true }).click();
  await expect(
    lastRow.locator('.article-cover-thumbnail').getByRole('alert'),
  ).toContainText('封面暂时无法读取');
});

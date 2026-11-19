import { coverDraftHarness, coverSession } from '../fixtures/cover-draft';
import { makeDraftTask } from '../fixtures/draft-task';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { test, expect } from '@playwright/test';
import { installCoverFixture, coverInput } from '../fixtures/judongche-cover';
import { denyExternalNetwork } from './network-policy';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/production-state';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';

test.beforeEach(async ({ context }) => denyExternalNetwork(context));
for (const mode of ['single', 'triple'] as const) {
  test('single_and_triple_order: ' + mode, async ({ page }) => {
    const f = await installCoverFixture(page);
    const input = coverInput(mode);
    const result = await f.upload(input, () => false);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.libraryUnchecked).toBe(true);
      expect(
        result.items.map((i) => [i.position, i.assetKey, i.sha256]),
      ).toEqual(input.files.map((i) => [i.position, i.assetKey, i.sha256]));
      expect(
        result.items.every((i) => /^[a-f0-9]{64}$/.test(i.resourceKey)),
      ).toBe(true);
    }
    expect(await f.actions()).toEqual([
      'mode:' + mode,
      'open',
      'upload:' + input.files.map((i) => i.assetKey + '.png').join(','),
      'library:false',
      'confirm:false',
    ]);
    expect(await page.locator('#body').innerHTML()).toBe(
      '<p>合成正文保持不变</p>',
    );
  });
}
test('default_library_checked: false readback precedes confirmation', async ({
  page,
}) => {
  const f = await installCoverFixture(page);
  expect((await f.upload(coverInput('single'), () => false)).status).toBe(
    'completed',
  );
  expect(f.reads[f.reads.indexOf('confirm') - 1]).toBe('read:false');
  expect(f.reads.slice(0, f.reads.indexOf('confirm'))).toContain('read:false');
});
test('unreadable_library_option: never confirm; safe cancellation', async ({
  page,
}) => {
  const f = await installCoverFixture(page, { unreadable: true });
  const result = await f.upload(coverInput('single'), () => false);
  expect(result.status).toBe('recoverable_failure');
  if (result.status === 'recoverable_failure') {
    expect(result.reason).toBe('LIBRARY_OPTION_UNVERIFIED');
    expect(result.safeEditorProof.uploadsSettled).toBe(true);
  }
  expect(await f.actions()).not.toContain('confirm:false');
  expect(await f.actions()).toContain('cancel');
});
test('partial_triple: one retry then a closed, unchanged blocked proof', async ({
  page,
}) => {
  const f = await installCoverFixture(page, { partial: true });
  const result = await f.upload(coverInput('triple'), () => false);
  expect(result).toMatchObject({
    status: 'blocked',
    reason: 'COVER_UPLOAD_FAILED',
    safeEditorProof: { modalClosed: true, uploadsSettled: true },
  });
  expect(
    (await f.actions()).filter((a) => a.startsWith('upload:')),
  ).toHaveLength(2);
  expect((await f.actions()).filter((a) => a === 'cancel')).toHaveLength(2);
  expect(await f.actions()).not.toContain('confirm:false');
});
test('late_upload_after_cancel: closed modal is not settlement', async ({
  page,
}) => {
  const f = await installCoverFixture(page, { partial: true, late: true });
  expect(await f.upload(coverInput('triple'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await page.locator('#cover-modal').isVisible()).toBe(false);
  expect(await f.actions()).toContain('cancel');
});
for (const drift of [
  undefined,
  'generation',
  'context',
  'store',
  'body',
  'title',
] as const) {
  test(
    'cancel_restores_same_editor: ' + (drift ?? 'same'),
    async ({ page }) => {
      const f = await installCoverFixture(page, { rejected: true, drift });
      const result = await f.upload(coverInput('single'), () => false);
      expect(result.status).toBe(
        drift && drift !== 'body' ? 'blocked' : 'recoverable_failure',
      );
      if (result.status === 'recoverable_failure') {
        expect(result.reason).toBe('UPLOAD_REJECTED');
        expect(result.safeEditorProof).toMatchObject({
          generation: 'generation-1',
          contextKey: 'article-context-1',
          modalClosed: true,
          uploadsSettled: true,
        });
      }
    },
  );
}
test('production SINGLE candidate exists; TRIPLE is refused with zero page access', async () => {
  let reads = 0;
  const pages = createJudongchePages({
    current: () => {
      reads++;
      throw Error('must not access');
    },
    generation: () => {
      reads++;
      return 'production';
    },
    open: async () => {
      throw Error('no');
    },
    close: async () => {},
  });
  expect(pages.localCoverUpload).toBe('supported');
  expect(typeof pages.uploadLocalCover).toBe('function');
  expect(
    await pages.uploadLocalCover!(coverInput('triple'), () => false),
  ).toEqual({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
  expect(reads).toBe(0);
});

test('disabled library option exits safely without confirmation', async ({
  page,
}) => {
  const f = await installCoverFixture(page, { disabled: true });
  const result = await f.upload(coverInput('single'), () => false);
  expect(result.status).toBe('recoverable_failure');
  if (result.status === 'recoverable_failure')
    expect(result.reason).toBe('LIBRARY_OPTION_UNVERIFIED');
  expect(await f.actions()).not.toContain('confirm:true');
});
test('already unchecked and duplicate byte digests retain three distinct positions', async ({
  page,
}) => {
  const f = await installCoverFixture(page, { unchecked: true });
  const result = await f.upload(coverInput('triple', true), () => false);
  expect(result.status).toBe('completed');
  if (result.status === 'completed') {
    expect(result.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(new Set(result.items.map((i) => i.resourceKey)).size).toBe(1);
  }
  expect(await f.actions()).not.toContain('library:false');
});
for (const fault of [
  'association',
  'order',
  'loaded',
  'mode',
  'pending',
  'unknown',
] as const) {
  test(
    'synthetic uploaded observation fault blocks: ' + fault,
    async ({ page }) => {
      const f = await installCoverFixture(page);
      const inspect = f.driver.inspect;
      f.driver.inspect = async () => {
        const o = await inspect();
        if (o.result === 'complete') {
          if (fault === 'association') o.items[0].sha256 = 'f'.repeat(64);
          if (fault === 'order') o.items.reverse();
          if (fault === 'loaded') o.items[0].loaded = false;
          if (fault === 'mode') o.mode = 'single';
          if (fault === 'pending') o.settlement = 'pending';
          if (fault === 'unknown') o.editor.known = false;
        }
        return o;
      };
      const result = await f.upload(coverInput('triple'), () => false);
      if (['association', 'order', 'loaded'].includes(fault)) {
        expect(result).toMatchObject({
          status: 'recoverable_failure',
          reason: 'UPLOAD_INCOMPLETE',
          items: [],
          safeEditorProof: { modalClosed: true, uploadsSettled: true },
        });
        const actions = await f.actions();
        expect(actions.filter((a) => a === 'cancel')).toHaveLength(1);
        expect(actions.some((a) => a.startsWith('confirm:'))).toBe(false);
      } else {
        expect(result).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
        expect((await f.actions()).some((a) => a.startsWith('confirm:'))).toBe(
          false,
        );
      }
    },
  );
}
test('upload timeout is unknown, never cancellation or recoverable failure', async ({
  page,
}) => {
  const f = await installCoverFixture(page);
  f.driver.waitForUpload = async () => {
    throw Error('synthetic timeout');
  };
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await f.actions()).not.toContain('cancel');
});
test('unclosed cancellation modal blocks fallback', async ({ page }) => {
  const f = await installCoverFixture(page, {
    rejected: true,
    modalStays: true,
  });
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
});
for (const stage of [
  'before',
  'upload',
  'uncheck',
  'confirm',
  'cancel',
] as const) {
  test('stop checkpoint: ' + stage, async ({ page }) => {
    const f = await installCoverFixture(page, { rejected: stage === 'cancel' });
    let stopped = stage === 'before';
    if (stage !== 'before') {
      const action = stage === 'uncheck' ? 'uncheckLibrary' : stage;
      const original = f.driver[action];
      f.driver[action] = async (...args: never[]) => {
        await (original as (...args: never[]) => Promise<void>)(...args);
        stopped = true;
      };
    }
    expect(await f.upload(coverInput('single'), () => stopped)).toEqual({
      status: 'blocked',
      reason: 'STOP_REQUESTED',
    });
    const actions = await f.actions();
    if (stage === 'before') expect(actions).toEqual([]);
    if (stage === 'upload' || stage === 'uncheck')
      expect(actions.some((a) => a.startsWith('confirm:'))).toBe(false);
  });
}
test('invalid count, swapped positions, mutated bytes and reused assets produce zero effects', async ({
  page,
}) => {
  const f = await installCoverFixture(page);
  const cases = [
    coverInput('triple'),
    coverInput('triple'),
    coverInput('single'),
    coverInput('triple'),
  ];
  cases[0].files.pop();
  cases[1].files.reverse();
  cases[2].files[0].bytes[0] = 0;
  cases[3].files[1].assetKey = cases[3].files[0].assetKey;
  for (const input of cases)
    expect(await f.upload(input, () => false)).toEqual({
      status: 'blocked',
      reason: 'INPUT_UNSUPPORTED',
    });
  expect(await f.actions()).toEqual([]);
});

test('unknown completion result cannot become ordinary partial failure', async ({
  page,
}) => {
  const f = await installCoverFixture(page);
  const inspect = f.driver.inspect;
  f.driver.inspect = async () => {
    const o = await inspect();
    if (o.result === 'complete') {
      o.result = null;
      o.items = [];
    }
    return o;
  };
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await f.actions()).not.toContain('cancel');
});

for (const fault of ['mode', 'result'] as const) {
  test(
    'mode or completion drift after checkbox readback blocks before confirm: ' +
      fault,
    async ({ page }) => {
      const f = await installCoverFixture(page);
      let unchecked = false;
      const uncheck = f.driver.uncheckLibrary;
      f.driver.uncheckLibrary = async () => {
        await uncheck();
        unchecked = true;
      };
      const inspect = f.driver.inspect;
      f.driver.inspect = async () => {
        const o = await inspect();
        if (unchecked) {
          if (fault === 'mode') o.mode = 'triple';
          else o.result = 'rejected';
        }
        return o;
      };
      expect((await f.upload(coverInput('single'), () => false)).status).toBe(
        'blocked',
      );
      expect((await f.actions()).some((a) => a.startsWith('confirm:'))).toBe(
        false,
      );
    },
  );
}

test('mode readback after opening must match before any upload', async ({
  page,
}) => {
  const f = await installCoverFixture(page);
  const open = f.driver.open;
  f.driver.open = async () => open('triple');
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(
    (await f.actions()).filter((a) => a.startsWith('upload:')),
  ).toHaveLength(0);
});

for (const reason of [
  'LOGIN_REQUIRED',
  'VERIFICATION_REQUIRED',
  'STORE_CHANGED',
] as const) {
  test(
    'existing safety guard rejects cover operations: ' + reason,
    async ({ page }) => {
      const f = await installCoverFixture(page);
      f.driver.guard = async () => {
        throw new JudongchePageError(reason);
      };
      expect(await f.upload(coverInput('single'), () => false)).toEqual({
        status: 'blocked',
        reason,
      });
      expect(await f.actions()).toEqual([]);
    },
  );
}
test('overlapping calls never start another upload', async ({ page }) => {
  const f = await installCoverFixture(page);
  const original = f.driver.waitForUpload;
  let release!: () => void;
  let reached!: () => void;
  const atWait = new Promise<void>((r) => (reached = r));
  const hold = new Promise<void>((r) => (release = r));
  f.driver.waitForUpload = async () => {
    reached();
    await hold;
    return await original();
  };
  const first = f.upload(coverInput('single'), () => false);
  await atWait;
  expect(await f.upload(coverInput('single'), () => false)).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  release();
  expect((await first).status).toBe('completed');
  expect(
    (await f.actions()).filter((a) => a.startsWith('upload:')),
  ).toHaveLength(1);
});

// T5 composition: body/task identity is the deterministic orchestration fixture;
// cover input/dialog/checkbox/cancellation uses the wholly synthetic browser DOM.
// The driver's synthetic title/body/store are bound to that same test article.
for (const scenario of ['complete', 'partial', 'late'] as const) {
  test('T5 controlled once-save composition: ' + scenario, async ({ page }) => {
    const f = await installCoverFixture(page, {
      partial: scenario !== 'complete',
      late: scenario === 'late',
    });
    const observed = await f.driver.inspect();
    const baseline = makeDraftTask();
    const h = coverDraftHarness('triple', {
      store: observed.editor.store!,
      snapshot: {
        ...baseline.snapshot,
        article: {
          ...baseline.snapshot.article,
          title: observed.editor.title,
          body: [{ type: 'paragraph', text: '合成正文保持不变' }],
          assets: [],
        },
      },
    });
    h.observed.contextKey = observed.editor.contextKey!;
    h.pages.uploadLocalCover = f.upload;
    const session = { ...coverSession, generation: () => observed.generation };
    h.pages.probe = async () => ({
      status: 'ready',
      store: h.task.store,
      generation: observed.generation,
    });
    const inspect = h.pages.inspectDraft;
    h.pages.inspectDraft = async (remote) => {
      const result = (await inspect(remote))!;
      const current = await f.driver.inspect();
      result.localCover = {
        known: true,
        mode: current.mode,
        items: current.items.map(({ position, resourceKey, loaded }) => ({
          position,
          resourceKey,
          loaded,
        })),
        pendingUploads: current.settlement !== 'settled',
      };
      return result;
    };
    const result = await createAdapterWithPages(session, h.pages).execute(
      h.task,
      h.hooks,
    );
    expect({
      result,
      calls: h.calls,
      report: h.durable().coverPlan?.report,
    }).toMatchObject({
      result: { status: scenario === 'complete' ? 'verified' : 'blocked' },
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(
      scenario === 'complete' ? 1 : 0,
    );
    expect(
      (await f.actions()).filter((a) => a.startsWith('upload:')),
    ).toHaveLength(scenario === 'partial' ? 2 : 1);
    if (scenario === 'complete')
      expect(h.durable().coverPlan?.report.phase).toBe('confirmed');
    if (scenario === 'partial')
      expect(h.durable().coverPlan?.report).toMatchObject({
        phase: 'failed',
        reason: 'COVER_UPLOAD_FAILED',
        requestedMode: 'triple',
        expectedCount: 3,
      });
    if (scenario === 'late')
      expect(h.durable().coverPlan?.report).toMatchObject({
        phase: 'needs_human',
        reason: 'PAGE_UNVERIFIED',
      });
    expect(await page.locator('#body').innerHTML()).toBe(
      '<p>合成正文保持不变</p>',
    );
  });
}

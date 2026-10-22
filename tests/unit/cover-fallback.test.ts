import { JudongcheCoverRequiredError } from '../../src/infrastructure/platforms/judongche/production-state';
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { coverDraftHarness, coverSession } from '../fixtures/cover-draft';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/production-state';
import { reduceTask } from '../../src/domain/draft-task';
const execute = (h: ReturnType<typeof coverDraftHarness>) =>
  createAdapterWithPages(coverSession, h.pages).execute(h.task, h.hooks);
it('completed upload stays pending until loaded unique reopen, then body and cover settle', async () => {
  const h = coverDraftHarness('triple');
  const inspect = h.pages.inspectDraft;
  h.pages.inspectDraft = async (r) => {
    expect(h.durable().coverPlan?.report.phase).toBe('pending');
    return inspect(r);
  };
  const result = await execute(h);
  expect(result.status).toBe('verified');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'confirmed',
    expectedCount: 3,
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  expect(h.calls.indexOf('report:confirmed')).toBeGreaterThan(
    h.calls.indexOf('reopen'),
  );
});
it('recoverable_failure_saves_once and retains partial triple warning without downgrade', async () => {
  const h = coverDraftHarness('triple');
  h.pages.uploadLocalCover = async (input) => ({
    status: 'recoverable_failure',
    reason: 'UPLOAD_INCOMPLETE',
    items: input.files.slice(0, 2).map(({ position, assetKey, sha256 }) => ({
      position,
      assetKey,
      sha256,
      resourceKey: sha256,
    })),
    safeEditorProof: {
      generation: 'fixture',
      contextKey: h.observed.contextKey!,
      storeKey: h.task.store.storeKey,
      bodyDigest: createHash('sha256')
        .update(
          JSON.stringify({
            title: h.observed.title,
            blocks: h.observed.blocks,
          }),
        )
        .digest('hex'),
      modalClosed: true,
      uploadsSettled: true,
    },
  });
  const result = await execute(h);
  expect(result.status).toBe('verified');
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'failed',
    reason: 'UPLOAD_INCOMPLETE',
    requestedMode: 'triple',
    expectedCount: 3,
  });
  expect(h.durable().coverPlan?.report.confirmedItems).toHaveLength(2);
  if (result.status === 'verified')
    expect(
      reduceTask(
        h.durable(),
        { type: 'settle', state: 'draft_saved', reason: null },
        h.durable().updatedAt,
      ).state,
    ).toBe('draft_saved');
});
it('cover_mismatch_body_verified retains body success and warning without second save', async () => {
  const h = coverDraftHarness();
  const inspect = h.pages.inspectDraft;
  h.pages.inspectDraft = async (r) => ({
    ...(await inspect(r))!,
    localCover: {
      known: true,
      mode: 'single',
      items: [],
      pendingUploads: false,
    },
  });
  expect((await execute(h)).status).toBe('verified');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'failed',
    reason: 'COVER_MISMATCH',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});
it('exact IMAGE_UNAVAILABLE falls back to body once while unknown asset errors pause', async () => {
  const h = coverDraftHarness();
  h.hooks.readCoverImage = async () => {
    throw { code: 'IMAGE_UNAVAILABLE' };
  };
  expect((await execute(h)).status).toBe('verified');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'failed',
    reason: 'IMAGE_UNAVAILABLE',
  });
  expect(h.calls).not.toContain('upload-cover');
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});
it.each(['unknown', 'stop', 'pending', 'body', 'proof'] as const)(
  'unknown_upload_or_stop_saves_zero: %s',
  async (fault) => {
    const h = coverDraftHarness();
    h.pages.uploadLocalCover = async () => {
      if (fault === 'stop') h.stop();
      if (fault === 'pending') h.observed.localCover!.pendingUploads = true;
      if (fault === 'body') h.observed.title = 'changed';
      if (fault === 'unknown')
        return { status: 'blocked', reason: 'PAGE_CHANGED' };
      return {
        status: 'recoverable_failure',
        reason: 'UPLOAD_REJECTED',
        items: [],
        safeEditorProof: {
          generation: fault === 'proof' ? 'foreign' : 'fixture',
          contextKey: h.observed.contextKey!,
          storeKey: h.task.store.storeKey,
          bodyDigest: createHash('sha256')
            .update(
              JSON.stringify({
                title: h.observed.title,
                blocks: h.observed.blocks,
              }),
            )
            .digest('hex'),
          modalClosed: true,
          uploadsSettled: true,
        },
      };
    };
    expect((await execute(h)).status).toBe('blocked');
    expect(h.calls).not.toContain('save');
  },
);
it('unknown local-byte error never saves', async () => {
  const h = coverDraftHarness();
  h.hooks.readCoverImage = async () => {
    throw Error('corrupt storage');
  };
  expect((await execute(h)).status).toBe('blocked');
  expect(h.calls).not.toContain('save');
});
it('cover_required_rejection records explicit warning without retry', async () => {
  const h = coverDraftHarness('none');
  h.pages.saveOnce = async () => {
    h.calls.push('save');
    throw new JudongcheCoverRequiredError({
      explicitRejection: true,
      remoteRecordAbsent: true,
      noPendingSave: true,
      autosaveExcluded: true,
    });
  };
  expect(await execute(h)).toMatchObject({
    status: 'blocked',
    reason: 'COVER_REQUIRED',
  });
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'failed',
    reason: 'COVER_REQUIRED',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});
it('ambiguous_save_never_replays across fresh adapter instances', async () => {
  const h = coverDraftHarness();
  h.pages.saveOnce = async () => {
    h.calls.push('save');
    throw Error('lost response');
  };
  expect(await execute(h)).toMatchObject({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(
    await createAdapterWithPages(coverSession, h.pages).execute(
      h.durable(),
      h.hooks,
    ),
  ).toMatchObject({ status: 'blocked', reason: 'RESULT_AMBIGUOUS' });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});
it('explicit none is guarded no-upload and once-only body save', async () => {
  const h = coverDraftHarness('none');
  Object.defineProperty(h.pages, 'localCoverUpload', {
    value: 'unsupported',
    configurable: true,
  });
  delete h.pages.uploadLocalCover;
  expect((await execute(h)).status).toBe('verified');
  expect(h.calls).not.toContain('upload-cover');
  expect(h.calls).not.toContain('read-cover');
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

it('fresh optimized guard checks body again after save checkpoint', async () => {
  const h = coverDraftHarness('none');
  Object.defineProperty(h.pages, 'manualReview', { value: true });
  h.pages.checkWritingContext = async () => {};
  const checkpoint = h.hooks.checkpoint;
  h.hooks.checkpoint = async (stage) => {
    await checkpoint(stage);
    if (stage === 'save') h.observed.title = 'manual drift';
  };
  expect((await execute(h)).status).toBe('blocked');
  expect(h.calls).not.toContain('save');
});
it('blocked reopened body keeps its independent unsafe cover report', async () => {
  const h = coverDraftHarness();
  const inspect = h.pages.inspectDraft;
  h.pages.inspectDraft = async (r) => ({
    ...(await inspect(r))!,
    known: false,
  });
  const result = await execute(h);
  expect(result.status).toBe('blocked');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'needs_human',
    reason: 'PAGE_UNVERIFIED',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

it.each(['record', 'body', 'url'] as const)(
  'cover confirmation requires unique reopened identity and matching body: %s',
  async (fault) => {
    const h = coverDraftHarness();
    const inspect = h.pages.inspectDraft;
    h.pages.inspectDraft = async (r) => {
      const value = (await inspect(r))!;
      if (fault === 'record') value.remote = { ...r, recordKey: 'foreign' };
      if (fault === 'body') value.title = 'foreign article';
      if (fault === 'url') value.editorUrl = 'https://foreign.invalid/editor';
      return value;
    };
    expect((await execute(h)).status).toBe('blocked');
    expect(h.durable().coverPlan?.report).toMatchObject({
      phase: 'needs_human',
      reason: 'PAGE_UNVERIFIED',
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);

it.each(['flag', 'method', 'unsupported'] as const)(
  'configured cover preflight blocks %s before every page/body effect',
  async (missing) => {
    const h = coverDraftHarness('triple');
    if (missing === 'flag')
      delete (h.pages as { localCoverUpload?: string }).localCoverUpload;
    if (missing === 'method') delete h.pages.uploadLocalCover;
    if (missing === 'unsupported')
      Object.defineProperty(h.pages, 'localCoverUpload', {
        value: 'unsupported',
        configurable: true,
      });
    expect(await execute(h)).toMatchObject({
      status: 'blocked',
      reason: 'INPUT_UNSUPPORTED',
    });
    expect(h.calls).toEqual([]);
    expect(h.durable().possibleRemoteEffect).toBe(false);
  },
);
it.each(['missing', 'unknown'] as const)(
  'missing local-only %s evidence preserves verified body with warning',
  async (fault) => {
    const h = coverDraftHarness();
    const inspect = h.pages.inspectDraft;
    h.pages.inspectDraft = async (r) => {
      const value = (await inspect(r))!;
      if (fault === 'missing') delete value.localCover;
      else
        value.localCover = {
          known: false,
          mode: null,
          items: [],
          pendingUploads: false,
        };
      return value;
    };
    expect((await execute(h)).status).toBe('verified');
    expect(h.durable().coverPlan?.report).toMatchObject({
      phase: 'needs_human',
      reason: 'PAGE_UNVERIFIED',
    });
  },
);
it('reopened positively pending cover blocks body success', async () => {
  const h = coverDraftHarness();
  const inspect = h.pages.inspectDraft;
  h.pages.inspectDraft = async (r) => {
    const value = (await inspect(r))!;
    value.localCover!.pendingUploads = true;
    return value;
  };
  expect((await execute(h)).status).toBe('blocked');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'needs_human',
    reason: 'PAGE_UNVERIFIED',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

it('unproved cover-required rejection remains ambiguous with warning and zero replay', async () => {
  const h = coverDraftHarness();
  h.pages.saveOnce = async () => {
    h.calls.push('save');
    throw new JudongchePageError('COVER_REQUIRED');
  };
  expect(await execute(h)).toMatchObject({
    status: 'blocked',
    reason: 'RESULT_AMBIGUOUS',
  });
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'failed',
    reason: 'COVER_REQUIRED',
  });
  expect(h.durable().coverPlan?.report.confirmedItems).toHaveLength(1);
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

it.each(['absent-proof', 'record-created'] as const)(
  'dedicated rejection cannot prove no save for %s',
  async (fault) => {
    const h = coverDraftHarness();
    const save = h.pages.saveOnce;
    h.pages.saveOnce = async () => {
      if (fault === 'record-created') await save();
      else h.calls.push('save');
      throw new JudongcheCoverRequiredError(
        fault === 'absent-proof'
          ? undefined
          : {
              explicitRejection: true,
              remoteRecordAbsent: true,
              noPendingSave: true,
              autosaveExcluded: true,
            },
      );
    };
    expect(await execute(h)).toMatchObject({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(h.durable().coverPlan?.report).toMatchObject({
      phase: 'failed',
      reason: 'COVER_REQUIRED',
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  },
);

it('no-save proof from a changed browser generation stays ambiguous', async () => {
  const h = coverDraftHarness();
  let generation = 'fixture';
  h.pages.probe = async () => ({
    status: 'ready',
    store: h.task.store,
    generation,
  });
  h.pages.saveOnce = async () => {
    h.calls.push('save');
    generation = 'changed';
    throw new JudongcheCoverRequiredError({
      explicitRejection: true,
      remoteRecordAbsent: true,
      noPendingSave: true,
      autosaveExcluded: true,
    });
  };
  expect(
    await createAdapterWithPages(
      { ...coverSession, generation: () => generation },
      h.pages,
    ).execute(h.task, h.hooks),
  ).toMatchObject({ status: 'blocked', reason: 'RESULT_AMBIGUOUS' });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

it('missing reopened editor evidence persists an independent page warning before blocked settlement', async () => {
  const h = coverDraftHarness();
  h.pages.inspectDraft = async () => undefined;
  expect((await execute(h)).status).toBe('blocked');
  expect(h.durable().coverPlan?.report).toMatchObject({
    phase: 'needs_human',
    reason: 'PAGE_UNVERIFIED',
  });
  expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
});

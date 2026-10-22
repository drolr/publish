import { coverDraftHarness } from '../fixtures/cover-draft';
import { verifyLocalCover } from '../../src/infrastructure/platforms/judongche/content-evidence';
import { describe, it, expect } from 'vitest';
import { makeDraftTask } from '../fixtures/draft-task';
import {
  verifyEvidence,
  unknownEditorEvidence,
} from '../../src/infrastructure/platforms/judongche/content-evidence';

describe('complete draft evidence', () => {
  const task = makeDraftTask({ possibleRemoteEffect: true, state: 'running' });
  task.evidence = {
    remote: {
      recordKey: 'opaque',
      editUrl:
        'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=opaque',
    },
    images: [],
    cover: null,
  };
  const observed = {
    ...unknownEditorEvidence(),
    known: true,
    store: task.store,
    remote: task.evidence.remote,
    isDraft: true,
    title: task.snapshot.article.title,
    blocks: task.snapshot.article.body.filter(
      (block) => block.type === 'paragraph',
    ),
    cover: task.evidence.cover,
    coverLoaded: false,
    pendingUploads: false,
    contextKey: 'synthetic-context',
    editorUrl: task.evidence.remote!.editUrl,
  };
  it('requires a complete matching reopened draft', () => {
    expect(verifyEvidence(task, observed)).toBe(true);
    expect(verifyEvidence(task, { ...observed, isDraft: false })).toBe(false);
    expect(verifyEvidence(task, { ...observed, pendingUploads: true })).toBe(
      false,
    );
    expect(verifyEvidence(task, { ...observed, coverLoaded: false })).toBe(
      true,
    );
    expect(verifyEvidence(task, { ...observed, known: false })).toBe(false);
    expect(
      verifyEvidence(task, {
        ...observed,
        remote: { ...task.evidence.remote!, recordKey: 'same-title-other' },
      }),
    ).toBe(false);
    expect(verifyEvidence(task, { ...observed, blocks: [] })).toBe(false);
    expect(
      verifyEvidence(task, {
        ...observed,
        cover: { source: 'store-material-first', resourceKey: 'b'.repeat(64) },
      }),
    ).toBe(true);
  });
});
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { draftHarness } from '../fixtures/draft-adapter';
import type { BrowserSession } from '../../src/infrastructure/automation/browser-session';
const session = {
  open: async () => {
    throw Error('unexpected open');
  },
  close: async () => {},
  current: () => undefined,
  generation: () => 'fixture',
} satisfies BrowserSession;
describe('ordered draft orchestration', () => {
  it('persists duplicate uploads independently then saves once and reopens the bound record', async () => {
    const h = draftHarness();
    h.pages.chooseFirstCover = async () => {
      throw Error('cover selection is outside this draft path');
    };
    const adapter = createAdapterWithPages(session, h.pages);
    const result = await adapter.execute(h.task, h.hooks);
    expect(result.status).toBe('verified');
    expect(h.calls).toEqual([
      'checkpoint:editor',
      'enter',
      'checkpoint:body',
      'title',
      'checkpoint:body',
      'paragraph:A\nline',
      'read',
      'checkpoint:body',
      'image',
      'evidence',
      'read',
      'checkpoint:body',
      'image',
      'evidence',
      'checkpoint:body',
      'paragraph:B',
      'checkpoint:save',
      'save',
      'evidence',
      'verify',
      'locate',
      'reopen',
    ]);
    expect(h.durable().evidence.images.map((x) => x.bodyIndex)).toEqual([1, 2]);
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
    expect(h.calls).not.toContain('cover');
  });
  it.each(['checkpoint', 'readImage', 'evidence'] as const)(
    'honors stop during awaited %s before the next action',
    async (hook) => {
      const h = draftHarness();
      const original = h.hooks[hook];
      if (hook === 'checkpoint')
        h.hooks.checkpoint = async (stage) => {
          await (original as typeof h.hooks.checkpoint)(stage);
          h.stop();
        };
      if (hook === 'readImage')
        h.hooks.readImage = async (key) => {
          const value = await (original as typeof h.hooks.readImage)(key);
          h.stop();
          return value;
        };
      if (hook === 'evidence')
        h.hooks.evidence = async (value) => {
          await (original as typeof h.hooks.evidence)(value);
          h.stop();
        };
      expect(
        await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks),
      ).toEqual({ status: 'blocked', reason: 'STOP_REQUESTED' });
      expect(h.calls).not.toContain('save');
      expect(h.calls.filter((x) => x === 'image').length).toBe(
        hook === 'evidence' ? 1 : 0,
      );
    },
  );
  it.each([
    'empty-resource',
    'pending',
    'edit',
    'store',
    'dialog',
    'save-lost',
  ])('blocks later effects for %s', async (fault) => {
    const h = draftHarness();
    if (fault === 'empty-resource')
      h.pages.appendImage = async () => {
        h.calls.push('image');
        return '';
      };
    if (
      fault === 'pending' ||
      fault === 'edit' ||
      fault === 'store' ||
      fault === 'dialog'
    ) {
      const append = h.pages.appendParagraph;
      h.pages.appendParagraph = async (text) => {
        await append(text);
        if (fault === 'pending') h.observed.pendingUploads = true;
        if (fault === 'edit') h.observed.title = 'manual';
        if (fault === 'store')
          h.observed.store = { ...h.task.store, storeKey: '2'.repeat(64) };
        if (fault === 'dialog') h.observed.known = false;
      };
    }
    if (fault === 'save-lost')
      h.pages.saveOnce = async () => {
        h.calls.push('save');
        throw Error('timeout');
      };
    expect(
      (await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks))
        .status,
    ).toBe('blocked');
    expect(h.calls.filter((x) => x === 'save').length).toBe(
      fault === 'save-lost' ? 1 : 0,
    );
    expect(h.calls).not.toContain('locate');
  });
});

describe('read-only and drift safety', () => {
  it('reconcile succeeds with every write method throwing and never scans without a remote', async () => {
    const h = draftHarness();
    const adapter = createAdapterWithPages(session, h.pages);
    expect((await adapter.execute(h.task, h.hooks)).status).toBe('verified');
    for (const name of [
      'enterNewEditor',
      'fillTitle',
      'appendParagraph',
      'appendImage',
      'chooseFirstCover',
      'saveOnce',
    ] as const)
      h.pages[name] = async () => {
        throw Error('write called');
      };
    expect((await adapter.reconcile(h.durable())).status).toBe('verified');
    h.calls.length = 0;
    expect(await adapter.reconcile(h.task)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(h.calls).toEqual([]);
  });
  it.each(['url', 'record', 'image-transform', 'unloaded', 'order'] as const)(
    'rejects %s evidence',
    async (fault) => {
      const h = draftHarness();
      const original = h.pages.inspectDraft;
      if (fault === 'url') {
        const append = h.pages.appendParagraph;
        h.pages.appendParagraph = async (text) => {
          await append(text);
          h.observed.editorUrl += '?foreign';
        };
      } else
        h.pages.inspectDraft = async (remote) => {
          const value = (await original(remote))!;
          if (fault === 'record')
            value.remote = { ...remote, recordKey: 'same-title' };
          if (fault === 'image-transform')
            value.blocks[1] = {
              type: 'image',
              resourceKey: 'd'.repeat(64),
              loaded: true,
            };
          if (fault === 'unloaded')
            value.blocks[1] = {
              type: 'image',
              resourceKey: '1'.repeat(64),
              loaded: false,
            };
          if (fault === 'order') value.blocks.reverse();
          return value;
        };
      expect(
        (
          await createAdapterWithPages(session, h.pages).execute(
            h.task,
            h.hooks,
          )
        ).status,
      ).toBe('blocked');
      if (fault === 'url') expect(h.calls).not.toContain('save');
    },
  );
  it('keeps evidence from a finished upload when stop arrives during that upload', async () => {
    const h = draftHarness();
    const append = h.pages.appendImage;
    h.pages.appendImage = async (bytes, mime) => {
      const key = await append(bytes, mime);
      h.stop();
      return key;
    };
    expect(
      await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks),
    ).toEqual({ status: 'blocked', reason: 'STOP_REQUESTED' });
    expect(h.durable().evidence.images).toHaveLength(1);
    expect(h.calls.filter((x) => x === 'image')).toHaveLength(1);
  });
});

it('does not continue on a foreign remote association in the edited prefix', async () => {
  const h = draftHarness();
  const append = h.pages.appendParagraph;
  h.pages.appendParagraph = async (text) => {
    await append(text);
    h.observed.remote = {
      recordKey: 'foreign',
      editUrl:
        'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=foreign',
    };
  };
  expect(
    (await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks))
      .status,
  ).toBe('blocked');
  expect(h.calls).not.toContain('image');
  expect(h.calls).not.toContain('save');
});
it('does not treat a platform-provided cover as a body draft gate', async () => {
  const h = draftHarness();
  const append = h.pages.appendParagraph;
  h.pages.appendParagraph = async (text) => {
    await append(text);
    h.observed.cover = {
      resourceKey: 'e'.repeat(64),
      source: 'store-material-first',
    };
  };
  expect(
    (await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks))
      .status,
  ).toBe('verified');
  expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
  expect(h.calls).not.toContain('cover');
});

it('persists a known save association even when stop arrives during save', async () => {
  const h = draftHarness();
  const save = h.pages.saveOnce;
  h.pages.saveOnce = async () => {
    await save();
    h.stop();
  };
  expect(
    await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks),
  ).toEqual({ status: 'blocked', reason: 'STOP_REQUESTED' });
  expect(h.durable().evidence.remote?.recordKey).toBe('opaque-synthetic');
  expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
});
it.each(['checkpoint', 'evidence'] as const)(
  'cannot continue after %s persistence failure',
  async (hook) => {
    const h = draftHarness();
    h.hooks[hook] = async () => {
      throw Error('persistence unavailable');
    };
    expect(
      (await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks))
        .status,
    ).toBe('blocked');
    expect(h.calls).not.toContain('save');
    expect(h.calls.filter((x) => x === 'image').length).toBe(
      hook === 'evidence' ? 1 : 0,
    );
  },
);

it('new explicit none does not inherit the historical material-cover requirement', () => {
  const h = coverDraftHarness('none');
  h.task.coverPolicy = 'store-material-first';
  const remote = {
    recordKey: 'bound',
    editUrl: 'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=bound',
  };
  h.task.evidence = {
    remote,
    cover: null,
    images: [
      {
        bodyIndex: 1,
        imageId: 'X',
        assetKey: h.task.snapshot.article.assets[0].assetKey,
        resourceKey: 'a'.repeat(64),
      },
      {
        bodyIndex: 2,
        imageId: 'X',
        assetKey: h.task.snapshot.article.assets[0].assetKey,
        resourceKey: 'b'.repeat(64),
      },
    ],
  };
  const observed = {
    ...h.observed,
    title: h.task.snapshot.article.title,
    remote,
    editorUrl: remote.editUrl,
    isDraft: true,
    blocks: [
      { type: 'paragraph' as const, text: 'A\nline' },
      { type: 'image' as const, resourceKey: 'a'.repeat(64), loaded: true },
      { type: 'image' as const, resourceKey: 'b'.repeat(64), loaded: true },
      { type: 'paragraph' as const, text: 'B' },
    ],
  };
  expect(verifyEvidence(h.task, observed)).toBe(true);
  expect(verifyLocalCover(h.task, observed)).toMatchObject({
    phase: 'not_configured',
    requestedMode: 'none',
    reason: null,
  });
  const reopened = {
    ...observed,
    localCover: {
      known: false,
      mode: null,
      items: [],
      pendingUploads: true,
    },
  };
  // Production may auto-populate three covers on reopen; none tasks do not
  // consume this independent, unsupported cover observation.
  expect(verifyEvidence(h.task, reopened)).toBe(true);
  expect(verifyLocalCover(h.task, reopened)).toMatchObject({
    phase: 'not_configured',
    requestedMode: 'none',
    reason: null,
  });
  expect(verifyEvidence(h.task, { ...reopened, pendingUploads: true })).toBe(
    false,
  );
  expect(verifyEvidence(h.task, { ...reopened, blocks: [] })).toBe(false);
});

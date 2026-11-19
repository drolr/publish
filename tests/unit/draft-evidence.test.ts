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

import {
  richDraftHarness,
  richCapabilities,
  richBody,
} from '../fixtures/rich-draft';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/page-contract';
import {
  appendRichTextBlock,
  type RichTextUiPort,
} from '../../src/infrastructure/platforms/judongche/production-rich-text';
import {
  editorBodyDigest,
  type RichEditorEvidence,
} from '../../src/infrastructure/platforms/judongche/rich-content-evidence';
import { verifyAcknowledgedTitleEdit } from '../../src/infrastructure/platforms/judongche/content-evidence';
const firstRun = (e: RichEditorEvidence) => {
  const b = e.rich.blocks[0];
  if (!b || b.type !== 'paragraph') throw Error('fixture paragraph');
  return b.content[0];
};
describe('controlled V2 rich semantics', () => {
  it('writes exact blocks, saves once, and verifies the same semantics after reopen', async () => {
    const h = richDraftHarness();
    const a = createAdapterWithPages(session, h.pages, richCapabilities);
    expect((await a.execute(h.task, h.hooks)).status).toBe('verified');
    expect(h.calls.filter((x) => x === 'save')).toHaveLength(1);
    expect(await a.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
  });
  it.each([
    'whole-bold',
    'missing-mark',
    'heading',
    'hand-number',
    'start',
    'quote',
    'empty',
    'unknown',
    'unknown-node',
    'unknown-store',
  ])(
    'operating admission permits semantic drift while preserving store identity: %s',
    async (fault) => {
      const h = richDraftHarness();
      const read = h.pages.inspectRichEditor;
      h.pages.inspectRichEditor = async () => {
        const value = await read();
        const b = value.rich.blocks;
        if (b.length === richBody.blocks.length) {
          if (fault === 'whole-bold' && b[0].type === 'paragraph')
            b[0].content[1].marks = ['bold'];
          if (fault === 'missing-mark')
            firstRun(value).marks = ['bold', 'italic'];
          if (fault === 'heading' && b[2].type === 'heading')
            b[2] = { ...b[2], type: 'paragraph' };
          if (fault === 'hand-number')
            b[3] = {
              type: 'paragraph',
              content: [{ type: 'text', text: '3. Item', marks: [] }],
            };
          if (
            fault === 'start' &&
            b[3].type === 'list' &&
            b[3].kind === 'ordered'
          )
            b[3].start = 4;
          if (fault === 'quote' && b[4].type === 'blockquote')
            b[4] = b[4].paragraphs[0];
          if (fault === 'empty') b.push({ type: 'paragraph', content: [] });
          if (fault === 'unknown') value.rich.formatKnown = false;
          if (fault === 'unknown-node')
            Reflect.set(b[0], 'type', 'unrecognized');
          if (fault === 'unknown-store') value.store = null;
        }
        return value;
      };
      const outcome = await createAdapterWithPages(
        session,
        h.pages,
        richCapabilities,
      ).execute(h.task, h.hooks);
      if (fault === 'unknown-store')
        expect(outcome).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
      else expect(outcome.status).toBe('verified');
      expect(h.calls.filter((x) => x === 'save')).toHaveLength(
        fault === 'unknown-store' ? 0 : 1,
      );
      expect(h.calls.filter((x) => x === 'enter')).toHaveLength(1);
    },
  );
  it('accepts adjacent inline splits and mark order only', async () => {
    const h = richDraftHarness();
    const read = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const v = await read();
      const b = v.rich.blocks[0];
      if (b?.type === 'paragraph')
        b.content.splice(
          0,
          1,
          { type: 'text', text: 'A', marks: ['underline', 'italic', 'bold'] },
          { type: 'text', text: 'B', marks: ['bold', 'italic', 'underline'] },
        );
      return v;
    };
    expect(
      (
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks)
      ).status,
    ).toBe('verified');
  });
  it.each([false, true])(
    'rechecks after save checkpoint (operator=%s)',
    async (operator) => {
      const h = richDraftHarness();
      const checkpoint = h.hooks.checkpoint;
      h.hooks.checkpoint = async (stage) => {
        await checkpoint(stage);
        if (stage === 'save') firstRun(h.observed).marks = [];
      };
      if (operator) {
        h.hooks.batchSubmissionReview = 'operator';
        Object.assign(h.pages, {
          batchSubmissionReview: 'operator',
          saveForOperatorReview: async () => {
            h.calls.push('save');
            return {
              observation: 'acknowledged',
              attemptedAt: new Date().toISOString(),
            };
          },
          returnHomeAfterSubmission: async () => {},
        });
      }
      expect(
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks),
      ).toMatchObject(
        operator
          ? { status: 'submission_recorded' }
          : { status: 'blocked', reason: 'CONTENT_MISMATCH' },
      );
      expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
    },
  );
  it.each([
    'appendTextBlock',
    'inspectRichEditor',
    'inspectRichDraft',
    'reviewRichSavedDraft',
  ] as const)(
    'denies missing %s without fallback or effects',
    async (method) => {
      const h = richDraftHarness();
      if (method === 'reviewRichSavedDraft') {
        Object.assign(h.pages, {
          manualReview: true,
          automaticDraftReview: true,
        });
      }
      Reflect.deleteProperty(h.pages, method);
      expect(
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks),
      ).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
      expect(h.calls).toEqual([]);
    },
  );
  it('validates immutable V2 digest before browser effects', async () => {
    const h = richDraftHarness();
    h.task.snapshot.digest = '0'.repeat(64);
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toEqual({ status: 'blocked', reason: 'INPUT_UNSUPPORTED' });
    expect(h.calls).toEqual([]);
  });
  it('keeps every production V2 task closed without injected evidence', async () => {
    const h = richDraftHarness();
    expect(
      await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks),
    ).toEqual({ status: 'blocked', reason: 'FORMAT_UNSUPPORTED' });
    expect(h.calls).toEqual([]);
  });
  it('rejects a non-default ordered start before any block write', async () => {
    const h = richDraftHarness({
      version: 2,
      blocks: [
        {
          type: 'list',
          kind: 'ordered',
          start: 2,
          items: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Item', marks: [] }],
            },
          ],
        },
      ],
    });
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toEqual({ status: 'blocked', reason: 'FORMAT_UNSUPPORTED' });
    expect(h.calls).toEqual([]);
  });
  it('cover proof changes on format-only mutations, preserving empty layout and ordered start', () => {
    const h = richDraftHarness();
    h.observed.rich.blocks = richBody.blocks.map((block) => {
      if (block.type === 'image')
        throw Error('Text-only fixture cannot synthesize resource evidence');
      return structuredClone(block);
    });
    const before = editorBodyDigest(h.observed);
    firstRun(h.observed).marks = [];
    expect(editorBodyDigest(h.observed)).not.toBe(before);
    h.observed.rich.blocks = richBody.blocks.map((block) => {
      if (block.type === 'image')
        throw Error('Text-only fixture cannot synthesize resource evidence');
      return structuredClone(block);
    });
    h.observed.rich.formatKnown = false;
    expect(() => editorBodyDigest(h.observed)).toThrow(
      'Unknown rich editor semantics',
    );
  });
  it('reuses exact rich semantics for manual review, acknowledged title edit and local cover', async () => {
    const h = richDraftHarness();
    Object.assign(h.pages, { manualReview: true, automaticDraftReview: true });
    h.pages.reviewRichSavedDraft = async () => ({
      ...structuredClone(h.observed),
      isDraft: true,
    });
    expect(
      (
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks)
      ).status,
    ).toBe('verified');
    const task = {
      ...h.durable(),
      state: 'needs_human' as const,
      holdsPlatform: true,
    };
    const observed = {
      ...structuredClone(h.observed),
      isDraft: true,
      title: 'Acknowledged title',
    };
    const edit = {
      taskId: task.taskId,
      snapshotDigest: task.snapshot.digest,
      storeKey: task.store.storeKey,
      recordKey: '123',
      originalTitle: task.snapshot.article.title,
      editedTitle: observed.title,
    };
    task.evidence.remote = {
      recordKey: '123',
      editUrl: 'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=123',
    };
    observed.remote = task.evidence.remote;
    observed.editorUrl = task.evidence.remote.editUrl;
    expect(verifyAcknowledgedTitleEdit(task, observed, edit)).toBe(true);
    firstRun(observed).marks = [];
    expect(verifyAcknowledgedTitleEdit(task, observed, edit)).toBe(false);
  });
});
function actionPort(
  onAction: (name: string) => void = () => {},
): RichTextUiPort & { calls: string[] } {
  const calls: string[] = [];
  const record = async (name: string) => {
    calls.push(name);
    onAction(name);
  };
  return {
    calls,
    guard: async () => {},
    resetFormat: () => record('reset'),
    selectBlock: (kind, start) => record(kind + ':' + (start ?? '')),
    setMark: (mark, active) => record(mark + ':' + active),
    typeText: (text) => record('text:' + text),
    softBreak: () => record('soft'),
    nextTextLeaf: () => record('next'),
    exitBlock: () => record('exit'),
  };
}
describe('normal UI rich action checkpoints', () => {
  it('sets exact combined marks, preserves soft breaks and exits/reset containers', async () => {
    const port = actionPort();
    await appendRichTextBlock(
      port,
      richBody
        .blocks[0] as import('../../src/contracts/rich-text-body').RichTextBlock,
      () => false,
    );
    expect(port.calls).toEqual([
      'reset',
      'paragraph:',
      'bold:true',
      'italic:true',
      'underline:true',
      'text:AB',
      'bold:false',
      'italic:false',
      'underline:false',
      'soft',
      'text:B',
      'exit',
      'reset',
    ]);
  });
  it.each([
    'reset',
    'ordered_list:3',
    'bold:false',
    'italic:false',
    'underline:false',
    'text:Item',
    'next',
    'exit',
  ])('honors stop directly after %s', async (point) => {
    let stopped = false;
    const p = actionPort((name) => {
      if (name === point) stopped = true;
    });
    await expect(
      appendRichTextBlock(
        p,
        {
          type: 'list',
          kind: 'ordered',
          start: 3,
          items: Array.from({ length: 100 }, () => ({
            type: 'paragraph',
            content: [{ type: 'text', text: 'Item', marks: [] }],
          })),
        },
        () => stopped,
      ),
    ).rejects.toMatchObject({ reason: 'STOP_REQUESTED' });
    expect(p.calls.at(-1)).toBe(point);
  });
  it.each(['LOGIN_REQUIRED', 'PAGE_CHANGED'] as const)(
    'stops on %s during format operation',
    async (reason) => {
      const p = actionPort();
      p.guard = async () => {
        if (p.calls.includes('italic:true'))
          throw new JudongchePageError(reason);
      };
      await expect(
        appendRichTextBlock(
          p,
          richBody
            .blocks[0] as import('../../src/contracts/rich-text-body').RichTextBlock,
          () => false,
        ),
      ).rejects.toMatchObject({ reason });
      expect(p.calls).not.toContain('text:AB');
    },
  );
});

describe('rich image coordinates and cover semantics', () => {
  const body: import('../../src/contracts/rich-text-body').PersistedEditorBodyV2 =
    {
      version: 2,
      blocks: [
        { type: 'paragraph', content: [] },
        {
          type: 'list',
          kind: 'ordered',
          start: 1,
          items: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'List', marks: ['bold'] }],
            },
          ],
        },
        { type: 'image', imageId: 'X' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'After image', marks: ['italic'] }],
        },
        { type: 'image', imageId: 'X' },
      ],
    };
  it('uses top-level image positions across lists, empty paragraphs and repeated assets', async () => {
    const h = richDraftHarness(body);
    const result = await createAdapterWithPages(
      session,
      h.pages,
      richCapabilities,
    ).execute(h.task, h.hooks);
    expect(result.status).toBe('verified');
    expect(h.durable().evidence.images.map((i) => i.bodyIndex)).toEqual([2, 4]);
    expect(h.durable().evidence.images.map((i) => i.resourceKey)).toEqual([
      '0'.repeat(64),
      '1'.repeat(64),
    ]);
  });
  it('persists completed upload association before observing stop and never starts the next block', async () => {
    const h = richDraftHarness(body);
    const append = h.pages.appendImage;
    h.pages.appendImage = async (...args) => {
      const resource = await append(...args);
      h.stop();
      return resource;
    };
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toEqual({ status: 'blocked', reason: 'STOP_REQUESTED' });
    expect(h.durable().evidence.images).toHaveLength(1);
    expect(h.durable().evidence.images[0].bodyIndex).toBe(2);
    expect(h.calls).not.toContain('save');
  });
  it('will not accept the right resource at the wrong rich image position', async () => {
    const h = richDraftHarness(body);
    const read = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const v = await read();
      if (v.rich.blocks.length === 5) {
        const i = v.rich.blocks[2];
        if (i.type === 'image') i.resourceKey = '1'.repeat(64);
      }
      return v;
    };
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toEqual({ status: 'blocked', reason: 'CONTENT_MISMATCH' });
    expect(h.calls).not.toContain('save');
  });
  it.each(['completed', 'recoverable_failure'] as const)(
    'same-text cover mutation permits one save before explicit strict review: %s',
    async (status) => {
      const legacy = coverDraftHarness();
      const h = richDraftHarness(richBody, legacy.task.coverPlan);
      h.hooks.readCoverImage = legacy.hooks.readCoverImage;
      Object.assign(h.pages, { localCoverUpload: 'supported' });
      h.observed.localCover = {
        known: true,
        mode: 'none',
        items: [],
        pendingUploads: false,
      };
      h.pages.uploadLocalCover = async (input) => {
        firstRun(h.observed).marks = [];
        const items = input.files.map((f) => ({
          position: f.position,
          assetKey: f.assetKey,
          sha256: f.sha256,
          resourceKey: f.sha256,
        }));
        return status === 'completed'
          ? { status, items, libraryUnchecked: true }
          : {
              status,
              items,
              reason: 'UPLOAD_REJECTED',
              safeEditorProof: {
                generation: 'fixture',
                contextKey: h.observed.contextKey!,
                storeKey: h.task.store.storeKey,
                editorUrl: h.observed.editorUrl!,
                modalClosed: true,
                uploadsSettled: true,
              },
            };
      };
      expect(
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks),
      ).toEqual({ status: 'blocked', reason: 'CONTENT_MISMATCH' });
      expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
    },
  );
});

describe('rich layout normalization limits', () => {
  it('allows newline encoding equivalence without dropping a soft break', async () => {
    const h = richDraftHarness();
    const read = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const v = await read();
      const p = v.rich.blocks[0];
      if (p?.type === 'paragraph') p.content[1].text = '\r\nB';
      return v;
    };
    expect(
      (
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks)
      ).status,
    ).toBe('verified');
  });
  it('does not use trailing empty-paragraph projection as operating admission for plain V2', async () => {
    const h = richDraftHarness({
      version: 2,
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Plain', marks: [] }],
        },
        { type: 'paragraph', content: [] },
      ],
    });
    const read = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const v = await read();
      if (v.rich.blocks.length === 2) v.rich.blocks.pop();
      return v;
    };
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toMatchObject({ status: 'verified' });
    expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
  });
});

describe('rich single-save uncertainty', () => {
  it('an ambiguous save cannot be retried by repeating execute', async () => {
    const h = richDraftHarness();
    h.pages.saveOnce = async () => {
      h.calls.push('save');
      throw Error('synthetic response lost');
    };
    const adapter = createAdapterWithPages(session, h.pages, richCapabilities);
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  });
  it('post-save format drift uses the same comparator without another save', async () => {
    const h = richDraftHarness(),
      save = h.pages.saveOnce;
    h.pages.saveOnce = async () => {
      await save();
      firstRun(h.observed).marks = [];
    };
    const adapter = createAdapterWithPages(session, h.pages, richCapabilities);
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'CONTENT_MISMATCH',
    });
    expect(await adapter.execute(h.task, h.hooks)).toEqual({
      status: 'blocked',
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
  });
});

describe('rich read-only unknown provenance', () => {
  it.each(['missing-method', 'missing-context', 'drift'])(
    'never falls back to V1 for %s review',
    async (fault) => {
      const h = richDraftHarness();
      Object.assign(h.pages, { manualReview: true });
      const adapter = createAdapterWithPages(
        session,
        h.pages,
        richCapabilities,
      );
      expect(await adapter.execute(h.task, h.hooks)).toEqual({
        status: 'blocked',
        reason: 'MANUAL_REVIEW_REQUIRED',
      });
      h.pages.reviewSavedDraft = async () => {
        throw Error('V2 legacy review forbidden');
      };
      if (fault !== 'missing-method')
        h.pages.reviewRichSavedDraft = async () => {
          const observed: RichEditorEvidence = {
            ...structuredClone(h.observed),
            isDraft: true,
          };
          if (fault === 'missing-context') observed.contextKey = null;
          else firstRun(observed).marks = [];
          return observed;
        };
      const task = {
        ...h.durable(),
        state: 'needs_human' as const,
        reason: 'MANUAL_REVIEW_REQUIRED' as const,
      };
      expect(await adapter.reconcile(task)).toMatchObject({
        status: 'blocked',
        reason: fault === 'drift' ? 'CONTENT_MISMATCH' : 'PAGE_CHANGED',
      });
      expect(h.calls.filter((c) => c === 'save')).toHaveLength(1);
    },
  );
});

describe('manual-review draft closure', () => {
  const closeable = (task: ReturnType<typeof draftHarness>['task']) => ({
    ...task,
    state: 'needs_human' as const,
    stage: 'settled' as const,
    holdsPlatform: true,
    saveAttempted: false,
    possibleRemoteEffect: true,
    reason: 'PAGE_CHANGED' as const,
    evidence: { remote: null, images: [], cover: null },
  });
  const readyProbe =
    (task: ReturnType<typeof draftHarness>['task']) => async () => ({
      status: 'ready' as const,
      store: task.store,
      generation: 'fixture',
    });
  it('closes from the local record without querying the draft box', async () => {
    const h = draftHarness();
    const task = closeable(h.task);
    const asked: string[] = [];
    Object.assign(h.pages, {
      manualReview: true,
      probe: readyProbe(task),
      inspectDraftAbsence: async (title: string) => {
        asked.push(title);
        return true;
      },
    });
    expect(
      await createAdapterWithPages(session, h.pages).checkAbsence(task),
    ).toMatchObject({ status: 'absent' });
    expect(asked).toEqual([]);
  });
  it('still builds closure proof when the platform has no absence query', async () => {
    const h = draftHarness();
    const task = closeable(h.task);
    Object.assign(h.pages, {
      manualReview: true,
      probe: readyProbe(task),
      inspectDraftAbsence: undefined,
    });
    expect(
      await createAdapterWithPages(session, h.pages).checkAbsence(task),
    ).toMatchObject({ status: 'absent' });
  });
});

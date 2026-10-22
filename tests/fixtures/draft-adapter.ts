import type { ExecutionHooks } from '../../src/domain/ports/draft-task';
import { reduceTask } from '../../src/domain/draft-task';
import type { JudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { unknownEditorEvidence } from '../../src/infrastructure/platforms/judongche/content-evidence';
import { makeDraftTask } from './draft-task';

export function draftHarness(
  coverPlan?: import('../../src/contracts/cover-task').CoverPlan,
  overrides: Partial<import('../../src/contracts/draft-task').DraftTask> = {},
) {
  const task = makeDraftTask();
  if (coverPlan) task.coverPlan = coverPlan;
  const assetKey = '55555555-5555-4555-8555-555555555555';
  task.snapshot.article.body = [
    { type: 'paragraph', text: 'A\nline' },
    { type: 'image', image_id: 'X' },
    { type: 'image', image_id: 'X' },
    { type: 'paragraph', text: 'B' },
  ];
  task.snapshot.article.assets = [
    {
      assetKey,
      imageId: 'X',
      relativePath: `${task.articleKey}/${assetKey}.png`,
      mime: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    },
  ];
  Object.assign(task, overrides);
  let durable = reduceTask(task, { type: 'begin' }, task.updatedAt);
  const input = structuredClone(durable);
  const observed = {
    ...unknownEditorEvidence(),
    known: true,
    store: task.store,
    pendingUploads: false,
    contextKey: 'fixture-new-context',
    editorUrl: 'https://www.autoengine.com/jdc/dealer/info/Article',
  };
  const calls: string[] = [];
  let stopped = false;
  const remote = {
    recordKey: 'opaque-synthetic',
    editUrl: observed.editorUrl + '?pgc_id=opaque-synthetic',
  };
  const hooks: ExecutionHooks = {
    coverReport: async (report) => {
      calls.push('report:' + report.phase);
      durable = reduceTask(
        durable,
        { type: 'cover_report', report },
        report.updatedAt,
      );
    },
    readCoverImage: async () => {
      if (!coverPlan) throw Error('legacy cover image denied');
      calls.push('read-cover');
      return new Uint8Array([1]);
    },
    checkpoint: async (stage) => {
      calls.push('checkpoint:' + stage);
      durable = reduceTask(
        durable,
        stage === 'save'
          ? { type: 'before-save' }
          : { type: 'before-effect', stage },
        new Date().toISOString(),
      );
    },
    evidence: async (evidence) => {
      calls.push('evidence');
      durable = reduceTask(
        durable,
        { type: 'evidence', evidence },
        new Date().toISOString(),
      );
    },
    verifying: async () => {
      calls.push('verify');
      durable = reduceTask(
        durable,
        { type: 'verify' },
        new Date().toISOString(),
      );
    },
    stopped: () => stopped,
    readImage: async () => {
      calls.push('read');
      return new Uint8Array([1]);
    },
  };
  const pages: JudongchePages = {
    probe: async () => ({
      status: 'ready',
      store: observed.store!,
      generation: 'fixture',
    }),
    inspectEditor: async () => structuredClone(observed),
    enterNewEditor: async () => {
      calls.push('enter');
    },
    fillTitle: async (text) => {
      calls.push('title');
      observed.title = text;
    },
    appendParagraph: async (text) => {
      calls.push('paragraph:' + text);
      observed.blocks.push({ type: 'paragraph', text });
    },
    appendImage: async () => {
      calls.push('image');
      const resourceKey = String(observed.blocks.length).repeat(64);
      observed.blocks.push({ type: 'image', resourceKey, loaded: true });
      return resourceKey;
    },
    chooseFirstCover: async () => {
      calls.push('cover');
      observed.cover = {
        resourceKey: 'c'.repeat(64),
        source: 'store-material-first',
      };
      observed.coverLoaded = true;
      return observed.cover;
    },
    saveOnce: async () => {
      calls.push('save');
      observed.remote = remote;
      observed.editorUrl = remote.editUrl;
    },
    locateDraft: async (ref) => {
      calls.push('locate');
      return ref.recordKey === remote.recordKey ? remote : undefined;
    },
    inspectDraft: async () => {
      calls.push('reopen');
      return { ...structuredClone(observed), isDraft: true };
    },
  };
  return {
    task: input,
    pages,
    hooks,
    observed,
    calls,
    durable: () => durable,
    stop: () => {
      stopped = true;
    },
  };
}

import { expect, it, vi } from 'vitest';
import { createImportController } from '../../src/application/import-controller';
import type { ImportResult } from '../../src/application/article-import';
import { ImportFailure } from '../../src/domain/import-error';
import type { StoredArticle } from '../../src/domain/ports/article-import';

const jobId = 'cf88b7c0-8521-4b66-8e2b-9b73ad37c853';
const secondId = '70f104f1-409d-45f2-ab25-c09ccdb8c04b';
it('runtime stop waits for picker settlement and permits a later explicit import', async () => {
  const { controller, picker, choose, importArticle } = setup();
  controller.start();
  await flush();
  controller.requestStop();
  expect(choose.mock.calls[0][0].aborted).toBe(true);
  expect(controller.isActive()).toBe(true);
  expect(controller.start().status).toBe('busy');
  picker.resolve(selected);
  await flush();
  expect(importArticle).not.toHaveBeenCalled();
  expect(controller.isActive()).toBe(false);
  expect(controller.start().status).toBe('started');
  controller.requestStop();
  await flush();
});
const selected = { input: {}, capability: { kind: 'local-root' as const } };
it('keeps the shared write gate blocked after an ambiguous import result', async () => {
  const { controller, picker, imported, choose } = setup();
  expect(controller.isBlocked()).toBe(false);
  controller.start();
  picker.resolve(selected);
  await flush();
  imported.resolve({
    status: 'failed',
    code: 'RECOVERY_REQUIRED',
    message: 'safe',
  });
  await flush();
  expect(controller.isActive()).toBe(false);
  expect(controller.isBlocked()).toBe(true);
  expect(controller.start()).toEqual({ status: 'unavailable' });
  expect(choose).toHaveBeenCalledTimes(1);
});
const article: StoredArticle = {
  articleKey: secondId,
  importId: jobId,
  externalId: 'a',
  title: '标题',
  body: [{ type: 'paragraph', text: '正文' }],
  assets: [],
  contentDeclaration: 'original',
  createdAt: '2026-09-16T00:00:00.000Z',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function setup() {
  const picker = deferred<typeof selected | undefined>();
  const imported = deferred<ImportResult>();
  const choose = vi.fn((signal: AbortSignal) => {
    void signal;
    return picker.promise;
  });
  const importArticle = vi.fn(
    (_input: unknown, options: { signal?: AbortSignal } = {}) => {
      void options;
      return imported.promise;
    },
  );
  const controller = createImportController({
    choose,
    importArticle,
    newId: () => jobId,
  });
  return { controller, choose, importArticle, picker, imported };
}
it('occupies selection synchronously and refuses queued starts', async () => {
  const { controller, choose, picker } = setup();
  expect(controller.snapshot()).toEqual({ state: 'idle', revision: 0 });
  expect(controller.start()).toEqual({ status: 'started', jobId });
  expect(controller.start()).toEqual({ status: 'busy', jobId });
  await flush();
  expect(choose).toHaveBeenCalledTimes(1);
  expect(controller.snapshot()).toEqual({
    state: 'selecting',
    jobId,
    revision: 1,
  });
  picker.resolve(undefined);
  await flush();
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'cancelled' },
  });
  expect(controller.isActive()).toBe(false);
});
it('starts a new operation after settlement and ignores the previous job ID', async () => {
  const picker = deferred<typeof selected | undefined>();
  let nextId = jobId;
  const controller = createImportController({
    choose: () => picker.promise,
    importArticle: async () => ({ status: 'cancelled' }),
    newId: () => nextId,
  });
  controller.start();
  picker.resolve(undefined);
  await flush();
  const revision = controller.snapshot().revision;
  nextId = secondId;
  expect(controller.start()).toEqual({ status: 'started', jobId: secondId });
  expect(controller.cancel(jobId)).toEqual({
    state: 'selecting',
    jobId: secondId,
    revision: revision + 1,
  });
  await flush();
  expect(controller.isActive()).toBe(false);
});
it('shutdown before picker startup never opens the picker', async () => {
  const { controller, choose } = setup();
  controller.start();
  await controller.stopAndWait();
  expect(choose).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'cancelled' },
  });
});
it('unexpected import rejection releases the slot and is a safe storage failure', async () => {
  const controller = createImportController({
    choose: async () => selected,
    importArticle: async () => {
      throw new Error('C:/secret');
    },
    newId: () => jobId,
  });
  controller.start();
  await flush();
  expect(controller.isActive()).toBe(false);
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'failed', code: 'STORAGE_UNAVAILABLE' },
  });
  expect(JSON.stringify(controller.snapshot())).not.toContain('secret');
});
it('cancelled selection never starts import and waits for picker settlement', async () => {
  const { controller, picker, importArticle, choose } = setup();
  controller.start();
  await flush();
  expect(controller.cancel(jobId).state).toBe('stopping');
  expect(choose.mock.calls[0][0].aborted).toBe(true);
  expect(controller.isActive()).toBe(true);
  picker.resolve(selected);
  await flush();
  expect(importArticle).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'cancelled' },
  });
});
it('old cancellation is ignored and repeated cancellation keeps revision stable', async () => {
  const { controller, picker, importArticle, imported } = setup();
  controller.start();
  picker.resolve(selected);
  await flush();
  const before = controller.snapshot();
  expect(before.state).toBe('importing');
  expect(controller.cancel(secondId)).toEqual(before);
  const stopping = controller.cancel(jobId);
  expect(controller.cancel(jobId)).toEqual(stopping);
  expect(importArticle.mock.calls[0][1]?.signal?.aborted).toBe(true);
  imported.resolve({ status: 'cancelled' });
  await flush();
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'cancelled' },
  });
});
it.each(['imported', 'already_exists'] as const)(
  'preserves committed %s after late cancel and strips internal article fields',
  async (status) => {
    const { controller, picker, imported } = setup();
    controller.start();
    picker.resolve(selected);
    await flush();
    controller.cancel(jobId);
    imported.resolve(
      status === 'imported'
        ? { status, article, warnings: [] }
        : { status, article },
    );
    await flush();
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      state: 'finished',
      result: { status, articleKey: secondId, title: '标题' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('importId');
    expect(controller.cancel(jobId)).toEqual(snapshot);
  },
);
it('snapshots cannot mutate current state or nested issues; issue positions use business language', async () => {
  const { controller, picker, imported } = setup();
  controller.start();
  picker.resolve(selected);
  await flush();
  imported.resolve({
    status: 'invalid',
    issues: Array.from({ length: 55 }, (_, i) => ({
      code: 'INVALID_STRUCTURE',
      message: 'C:/secret/token',
      path: [i === 0 ? 'images' : 'body', i, 'C:/secret'],
    })),
  });
  await flush();
  const snapshot = controller.snapshot();
  if (snapshot.state !== 'finished' || snapshot.result.status !== 'invalid')
    throw new Error('Expected invalid');
  expect(snapshot.result.issues).toHaveLength(50);
  expect(snapshot.result.issues[0].position).toBe('第 1 张图片');
  expect(snapshot.result.issues[1].position).toBe('第 2 个内容块');
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  snapshot.result.issues[0].message = 'mutated';
  snapshot.revision = 999;
  expect(JSON.stringify(controller.snapshot())).not.toContain('mutated');
  expect(controller.snapshot().revision).toBeLessThan(999);
});
it('shutdown waits for settlement and permanently refuses new starts', async () => {
  const { controller, picker, imported } = setup();
  controller.start();
  picker.resolve(selected);
  await flush();
  let ended = false;
  const stop = controller.stopAndWait().then(() => {
    ended = true;
  });
  const duplicateStop = controller.stopAndWait();
  await flush();
  expect(ended).toBe(false);
  expect(controller.start()).toEqual({ status: 'unavailable' });
  imported.resolve({
    status: 'failed',
    code: 'RECOVERY_REQUIRED',
    message: 'C:/secret',
  });
  await Promise.all([stop, duplicateStop]);
  expect(controller.isActive()).toBe(false);
  expect(controller.start()).toEqual({ status: 'unavailable' });
  expect(controller.snapshot()).toMatchObject({
    state: 'finished',
    result: { status: 'failed', code: 'RECOVERY_REQUIRED' },
  });
  expect(JSON.stringify(controller.snapshot())).not.toContain('secret');
});
it.each([new ImportFailure('FILE_TOO_LARGE'), new Error('C:/secret')])(
  'sanitizes picker errors',
  async (error) => {
    const controller = createImportController({
      choose: async () => {
        throw error;
      },
      importArticle: async () => ({ status: 'cancelled' }),
      newId: () => jobId,
    });
    controller.start();
    await flush();
    expect(controller.snapshot()).toMatchObject({
      state: 'finished',
      result: {
        status: 'failed',
        code:
          error instanceof ImportFailure
            ? 'FILE_TOO_LARGE'
            : 'FILE_UNAVAILABLE',
      },
    });
    expect(JSON.stringify(controller.snapshot())).not.toContain('secret');
  },
);

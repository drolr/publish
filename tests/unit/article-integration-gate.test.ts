import { afterEach, expect, it, vi } from 'vitest';
import { createLibraryWriteGate } from '../../src/desktop/main/library-write-gate';
import { createImportController } from '../../src/application/import-controller';
import {
  createDraftHarness,
  type DraftHarness,
} from '../fixtures/draft-harness';
const harnesses: DraftHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
it.each(['running', 'unknown'] as const)(
  'blocks JSON and declaration writers while platform is %s',
  async (state) => {
    const h = await createDraftHarness();
    harnesses.push(h);
    if (state === 'unknown')
      h.control.afterCheckpoint = async () => {
        throw new Error('page changed');
      };
    await h.api.startDraft(h.preparationId);
    if (state === 'unknown') {
      h.releaseExecute();
      await vi.waitFor(() => expect(h.api.isActive()).toBe(false));
      expect(h.api.isBlocked()).toBe(true);
    }
    const imports = createImportController({
      newId: () => '11111111-1111-4111-8111-111111111111',
      choose: async () => undefined,
      importArticle: async () => ({ status: 'cancelled' }),
    });
    const gate = createLibraryWriteGate({
      available: () => true,
      isClosing: () => false,
      imports,
      draft: h.api,
    });
    expect(gate.state()).not.toBe('ready');
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
    expect(imports.snapshot().state).toBe('idle');
    h.releaseExecute();
  },
);

import { manualFixture, deferred, flush } from '../helpers/manual-desktop';
it.each(['resolve', 'reject'] as const)(
  'cannot start a platform task during or after failed %s manual cleanup',
  async (outcome) => {
    const h = await createDraftHarness();
    harnesses.push(h);
    const cleanup = deferred<void>();
    const { manual, edit } = manualFixture({
      releaseImages: async () => {
        await cleanup.promise;
        if (outcome === 'reject') throw Error('cleanup failed');
      },
    });
    const gate = createLibraryWriteGate({
      available: () => true,
      isClosing: () => false,
      manual,
    });
    Object.defineProperty(h.control, 'gate', { get: () => gate.state() });
    const state = await edit();
    manual.saveManualArticle(state.sessionId, state.revision);
    await flush();
    expect(manual.isActive()).toBe(true);
    expect((await h.api.startDraft(h.preparationId)).status).toBe('blocked');
    expect(h.calls).not.toContain('execute');
    cleanup.resolve();
    await flush();
    expect((await h.api.startDraft(h.preparationId)).status).toBe(
      outcome === 'resolve' ? 'ok' : 'blocked',
    );
    if (outcome === 'reject') {
      expect(manual.isBlocked()).toBe(true);
      expect(h.calls).not.toContain('execute');
    }
    h.releaseExecute();
  },
);

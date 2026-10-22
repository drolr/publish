import { expect, it, vi } from 'vitest';
import { draftChannels, type DraftApi } from '../../src/contracts/draft-task';
const h = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: h.expose },
  ipcRenderer: { invoke: h.invoke },
}));
it('exposes a frozen allowlist, validates every draft argument before invoke and sanitizes responses', async () => {
  await import('../../src/desktop/preload/index');
  expect(h.expose).toHaveBeenCalledOnce();
  const [name, api] = h.expose.mock.calls[0] as [
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>>,
  ];
  expect(name).toBe('desktopApi');
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.keys(api).sort()).toEqual(
    [
      'batch',
      'requestStopAll',
      'getOperationControlState',
      'getArticleCover',
      'copyCoverImage',
      'beginCoverEdit',
      'getCoverEditState',
      'setCoverDraft',
      'pickCoverImages',
      'getCoverImage',
      'saveCoverEdit',
      'getCoverSaveResult',
      'closeCoverEdit',
      'deleteArticle',
      'getArticleDeletionResult',
      'openManualArticle',
      'applyManualEdit',
      'spliceManualPaste',
      'insertManualImage',
      'commitManualDocument',
      'closeManualEditor',
      'copyManualSelection',
      'getManualSaveResult',
      'respondManualClose',
      'onManualCloseRequest',
      'beginManualArticle',
      'cancelArticleImport',
      'cancelManualOperation',
      'checkDraftSession',
      'closeDraftSession',
      'confirmTaskClosure',
      'discardManualArticle',
      'getAppStatus',
      'getArticleDeclarations',
      'getArticleImage',
      'getArticlePreview',
      'getDraftState',
      'getImportStatus',
      'getManualArticleState',
      'getManualImage',
      'listArticles',
      'openDraftSession',
      'openSavedDraft',
      'pickManualImage',
      'prepareDraft',
      'prepareTaskClosure',
      'reconcileDraft',
      'retryManualPasteImage',
      'saveManualArticle',
      'setArticleDeclarations',
      'startArticleImport',
      'startDraft',
      'startManualPaste',
      'stopDraft',
      'updateManualDraft',
    ].sort(),
  );
  const id = '00000000-0000-4000-8000-000000000001';
  const view = {
    session: {
      status: 'closed',
      bindingToken: null,
      storeName: null,
      reason: null,
    },
    preparation: null,
    task: null,
  };
  const args: Record<keyof DraftApi, unknown[]> = {
    openDraftSession: [],
    checkDraftSession: [],
    closeDraftSession: [],
    prepareDraft: [id, id],
    startDraft: [id],
    getDraftState: [],
    stopDraft: [id],
    reconcileDraft: [id],
    prepareTaskClosure: [id],
    confirmTaskClosure: [id],
    openSavedDraft: [id],
  };
  for (const method of Object.keys(draftChannels) as (keyof DraftApi)[]) {
    h.invoke.mockClear();
    await expect(
      api[method](...args[method], 'https://example.invalid'),
    ).rejects.toThrow('Request rejected');
    expect(h.invoke).not.toHaveBeenCalled();
    const reply =
      method === 'getDraftState'
        ? view
        : method === 'prepareDraft'
          ? { status: 'blocked', reason: 'PAGE_CHANGED' }
          : { status: 'ok', view };
    h.invoke.mockResolvedValueOnce(reply);
    expect(await api[method](...args[method])).toEqual(reply);
    expect(h.invoke).toHaveBeenCalledWith(
      draftChannels[method],
      ...args[method],
    );
    h.invoke.mockResolvedValueOnce({
      ...reply,
      profileDirectory: 'C:/private/profile',
    });
    await expect(api[method](...args[method])).rejects.toThrow(
      'Request unavailable',
    );
    h.invoke.mockRejectedValueOnce(new Error('token and private path'));
    await expect(api[method](...args[method])).rejects.toThrow(
      'Request unavailable',
    );
  }
  h.invoke.mockResolvedValueOnce({ status: 'blocked', reason: 'PAGE_CHANGED' });
  await api.prepareDraft(id, id, 'new_attempt');
  expect(h.invoke).toHaveBeenLastCalledWith(
    draftChannels.prepareDraft,
    id,
    id,
    'new_attempt',
  );
  await expect(api.prepareDraft(id, id, 'retry')).rejects.toThrow(
    'Request rejected',
  );
});

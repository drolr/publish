import type { createManualArticleController } from '../../application/manual-article';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  manualChannels,
  manualRequests,
  manualResponses,
  type ManualArticleApi,
} from '../../contracts/manual-article';
import { isTrustedSender } from './ipc-policy';
export function registerManualHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: ManualArticleApi,
): void {
  const methods = Object.keys(manualChannels) as (keyof ManualArticleApi)[];
  for (const method of methods) {
    const channel = manualChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !manualRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return manualResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods) ipcMain.removeHandler(manualChannels[method]);
  });
}

// Keep the composition-root fallback and all nineteen typed bindings together.
export function createManualDesktopApi(
  manual: ReturnType<typeof createManualArticleController> | undefined,
): ManualArticleApi {
  const unavailable = () =>
    ({
      status: 'unavailable',
      snapshot: { state: 'unavailable', revision: 0 },
    }) as const;
  return {
    openManualArticle: async (...args) =>
      manual?.openManualArticle(...args) ?? unavailable(),
    applyManualEdit: async (...args) =>
      manual?.applyManualEdit(...args) ?? unavailable(),
    spliceManualPaste: async (...args) =>
      manual?.spliceManualPaste(...args) ?? unavailable(),
    insertManualImage: async (...args) =>
      manual?.insertManualImage(...args) ?? unavailable(),
    commitManualDocument: async (...args) =>
      manual?.commitManualDocument(...args) ?? unavailable(),
    closeManualEditor: async (...args) =>
      manual?.closeManualEditor(...args) ?? unavailable(),
    copyManualSelection: async (...args) =>
      manual?.copyManualSelection(...args) ?? unavailable(),
    getManualSaveResult: async (sessionId, operationId) =>
      manual?.getManualSaveResult(sessionId, operationId) ?? {
        status: 'unavailable',
        operationId,
      },
    respondManualClose: async (...args) =>
      manual?.respondManualClose(...args) ?? unavailable(),
    startManualPaste: async (command, input) =>
      manual?.startManualPaste(command, input) ?? unavailable(),
    retryManualPasteImage: async (command, candidateId) =>
      manual?.retryManualPasteImage(command, candidateId) ?? unavailable(),
    beginManualArticle: async () =>
      manual?.beginManualArticle() ?? unavailable(),
    getManualArticleState: async () =>
      manual?.getManualArticleState() ?? { state: 'unavailable', revision: 0 },
    updateManualDraft: async (id, revision, draft) =>
      manual?.updateManualDraft(id, revision, draft) ?? unavailable(),
    pickManualImage: async (id, revision) =>
      manual?.pickManualImage(id, revision) ?? unavailable(),
    getManualImage: async (id, token) =>
      manual?.getManualImage(id, token) ?? { status: 'unavailable' },
    saveManualArticle: async (id, revision) =>
      manual?.saveManualArticle(id, revision) ?? unavailable(),
    cancelManualOperation: async (id, jobId) =>
      manual?.cancelManualOperation(id, jobId) ?? unavailable(),
    discardManualArticle: async (id, revision) =>
      manual?.discardManualArticle(id, revision) ?? unavailable(),
  };
}

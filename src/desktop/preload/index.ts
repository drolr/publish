import {
  OPEN_UPLOAD_SETTINGS,
  UploadWaitSettingsSchema,
  waitSettingsChannels,
  waitSettingsRequests,
} from '../../contracts/upload-wait-settings';
import {
  browserHealthChannels,
  browserHealthRequestSchemas,
  browserHealthResponseSchemas,
  type BrowserHealthApi,
} from '../../contracts/browser-health';
import {
  batchChannels,
  batchRequests,
  batchResponses,
  type BatchApi,
} from '../../contracts/draft-batch';
import {
  operationControlChannels,
  OperationControlRequestSchema,
  OperationControlViewSchema,
  type OperationControlApi,
} from '../../contracts/operation-control';
import {
  articleCoverChannels,
  articleCoverRequests,
  articleCoverResponses,
  type ArticleCoverApi,
} from '../../contracts/article-cover';
import {
  articleDeletionChannels,
  articleDeletionRequests,
  articleDeletionResponses,
  type ArticleDeletionApi,
} from '../../contracts/article-delete';
import { contextBridge, ipcRenderer } from 'electron';
import {
  manualCloseChannels,
  ManualCloseRequestSchema,
  ManualCloseReadySchema,
  type ManualCloseRequest,
} from '../../contracts/editor-close';
import {
  draftChannels,
  draftRequests,
  draftResponses,
  type DraftApi,
} from '../../contracts/draft-task';
import {
  manualChannels,
  manualRequests,
  manualResponses,
  type ManualArticleApi,
} from '../../contracts/manual-article';
import {
  APP_STATUS_CHANNEL,
  AppStatusSchema,
  NoArgumentsSchema,
  type DesktopApi,
} from '../../contracts/app-status';
import {
  libraryChannels,
  libraryRequests,
  libraryResponses,
  type ArticleLibraryApi,
} from '../../contracts/article-library';
async function invokeOperationControl(
  method: keyof OperationControlApi,
  args: unknown[],
) {
  if (!OperationControlRequestSchema.safeParse(args).success)
    throw Error('Request rejected');
  try {
    return OperationControlViewSchema.parse(
      await ipcRenderer.invoke(operationControlChannels[method], ...args),
    );
  } catch {
    throw Error('Request unavailable');
  }
}
async function invoke<K extends keyof ArticleLibraryApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<ArticleLibraryApi[K]>>> {
  libraryRequests[method].parse(args);
  return libraryResponses[method].parse(
    await ipcRenderer.invoke(libraryChannels[method], ...args),
  ) as Awaited<ReturnType<ArticleLibraryApi[K]>>;
}
async function invokeManual<K extends keyof ManualArticleApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<ManualArticleApi[K]>>> {
  if (!manualRequests[method].safeParse(args).success)
    throw new Error('Request rejected');
  try {
    return manualResponses[method].parse(
      await ipcRenderer.invoke(manualChannels[method], ...args),
    ) as Awaited<ReturnType<ManualArticleApi[K]>>;
  } catch {
    throw new Error('Request unavailable');
  }
}
async function invokeDraft<K extends keyof DraftApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<DraftApi[K]>>> {
  if (!draftRequests[method].safeParse(args).success)
    throw new Error('Request rejected');
  try {
    return draftResponses[method].parse(
      await ipcRenderer.invoke(draftChannels[method], ...args),
    ) as Awaited<ReturnType<DraftApi[K]>>;
  } catch {
    throw new Error('Request unavailable');
  }
}
async function invokeDeletion<K extends keyof ArticleDeletionApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<ArticleDeletionApi[K]>>> {
  if (!articleDeletionRequests[method].safeParse(args).success)
    throw new Error('Request rejected');
  try {
    return articleDeletionResponses[method].parse(
      await ipcRenderer.invoke(articleDeletionChannels[method], ...args),
    ) as Awaited<ReturnType<ArticleDeletionApi[K]>>;
  } catch {
    throw new Error('Request unavailable');
  }
}
async function invokeCover<K extends keyof ArticleCoverApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<ArticleCoverApi[K]>>> {
  if (!articleCoverRequests[method].safeParse(args).success)
    throw Error('Request rejected');
  try {
    return articleCoverResponses[method].parse(
      await ipcRenderer.invoke(articleCoverChannels[method], ...args),
    ) as Awaited<ReturnType<ArticleCoverApi[K]>>;
  } catch {
    throw Error('Request unavailable');
  }
}
async function invokeBatch<K extends keyof BatchApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<BatchApi[K]>>> {
  if (!batchRequests[method].safeParse(args).success)
    throw new Error('Request rejected');
  try {
    return batchResponses[method].parse(
      await ipcRenderer.invoke(batchChannels[method], ...args),
    ) as Awaited<ReturnType<BatchApi[K]>>;
  } catch {
    throw new Error('Request unavailable');
  }
}
async function invokeBrowserHealth<K extends keyof BrowserHealthApi>(
  method: K,
  args: unknown[],
): Promise<Awaited<ReturnType<BrowserHealthApi[K]>>> {
  if (!browserHealthRequestSchemas[method].safeParse(args).success)
    throw Error('Request rejected');
  try {
    return browserHealthResponseSchemas[method].parse(
      await ipcRenderer.invoke(browserHealthChannels[method], ...args),
    ) as Awaited<ReturnType<BrowserHealthApi[K]>>;
  } catch {
    throw Error('Request unavailable');
  }
}
async function invokeWaitSettings(
  method: keyof typeof waitSettingsChannels,
  args: unknown[],
) {
  if (!waitSettingsRequests[method].safeParse(args).success)
    throw Error('Request rejected');
  return UploadWaitSettingsSchema.parse(
    await ipcRenderer.invoke(waitSettingsChannels[method], ...args),
  );
}
const api: DesktopApi = Object.freeze({
  onOpenUploadSettings(listener: () => void) {
    if (typeof listener !== 'function') throw Error('Request rejected');
    const callback = (event: { sender: unknown }, ...args: unknown[]) => {
      if (event.sender === ipcRenderer && args.length === 0) listener();
    };
    ipcRenderer.on(OPEN_UPLOAD_SETTINGS, callback);
    return () => ipcRenderer.removeListener(OPEN_UPLOAD_SETTINGS, callback);
  },
  getUploadWaitSettings: (...args: unknown[]) =>
    invokeWaitSettings('getUploadWaitSettings', args),
  saveUploadWaitSettings: (...args: unknown[]) =>
    invokeWaitSettings('saveUploadWaitSettings', args),
  getBrowserHealth: (...args: unknown[]) =>
    invokeBrowserHealth('getBrowserHealth', args),
  checkBrowserHealth: (...args: unknown[]) =>
    invokeBrowserHealth('checkBrowserHealth', args),
  openBrowserUpdate: (...args: unknown[]) =>
    invokeBrowserHealth('openBrowserUpdate', args),
  batch: Object.freeze({
    skipCurrentAndContinue: (...args: unknown[]) =>
      invokeBatch('skipCurrentAndContinue', args),
    prepare: (...args: unknown[]) => invokeBatch('prepare', args),
    start: (...args: unknown[]) => invokeBatch('start', args),
    stop: (...args: unknown[]) => invokeBatch('stop', args),
    finish: (...args: unknown[]) => invokeBatch('finish', args),
    archiveFinishedBatch: (...args: unknown[]) =>
      invokeBatch('archiveFinishedBatch', args),
    getCurrent: (...args: unknown[]) => invokeBatch('getCurrent', args),
  }),
  getArticleCover: (...args: unknown[]) => invokeCover('getArticleCover', args),
  requestStopAll: (...args: unknown[]) =>
    invokeOperationControl('requestStopAll', args),
  getOperationControlState: (...args: unknown[]) =>
    invokeOperationControl('getOperationControlState', args),
  beginCoverEdit: (...args: unknown[]) => invokeCover('beginCoverEdit', args),
  getCoverEditState: (...args: unknown[]) =>
    invokeCover('getCoverEditState', args),
  setCoverDraft: (...args: unknown[]) => invokeCover('setCoverDraft', args),
  pickCoverImages: (...args: unknown[]) => invokeCover('pickCoverImages', args),
  copyCoverImage: (...args: unknown[]) => invokeCover('copyCoverImage', args),
  getCoverImage: (...args: unknown[]) => invokeCover('getCoverImage', args),
  saveCoverEdit: (...args: unknown[]) => invokeCover('saveCoverEdit', args),
  getCoverSaveResult: (...args: unknown[]) =>
    invokeCover('getCoverSaveResult', args),
  closeCoverEdit: (...args: unknown[]) => invokeCover('closeCoverEdit', args),
  deleteArticle: (...args: unknown[]) => invokeDeletion('deleteArticle', args),
  getArticleDeletionResult: (...args: unknown[]) =>
    invokeDeletion('getArticleDeletionResult', args),
  pickManualCoverImage: (...args: unknown[]) =>
    invokeManual('pickManualCoverImage', args),
  setManualCoverMode: (...args: unknown[]) =>
    invokeManual('setManualCoverMode', args),
  getManualCoverImage: (...args: unknown[]) =>
    invokeManual('getManualCoverImage', args),
  reconcileManualCoverSave: (...args: unknown[]) =>
    invokeManual('reconcileManualCoverSave', args),
  openManualArticle: (...args: unknown[]) =>
    invokeManual('openManualArticle', args),
  applyManualEdit: (...args: unknown[]) =>
    invokeManual('applyManualEdit', args),
  spliceManualPaste: (...args: unknown[]) =>
    invokeManual('spliceManualPaste', args),
  insertManualImage: (...args: unknown[]) =>
    invokeManual('insertManualImage', args),
  commitManualDocument: (...args: unknown[]) =>
    invokeManual('commitManualDocument', args),
  closeManualEditor: (...args: unknown[]) =>
    invokeManual('closeManualEditor', args),
  copyManualSelection: (...args: unknown[]) =>
    invokeManual('copyManualSelection', args),
  getManualSaveResult: (...args: unknown[]) =>
    invokeManual('getManualSaveResult', args),
  respondManualClose: (...args: unknown[]) =>
    invokeManual('respondManualClose', args),
  onManualCloseRequest(listener: (request: ManualCloseRequest) => void) {
    if (typeof listener !== 'function') throw new Error('Request rejected');
    const callback = (event: { sender: unknown }, value: unknown) => {
      if (event.sender !== ipcRenderer) return;
      const parsed = ManualCloseRequestSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(manualCloseChannels.request, callback);
    ipcRenderer.send(
      manualCloseChannels.ready,
      ...ManualCloseReadySchema.parse([]),
    );
    return () =>
      ipcRenderer.removeListener(manualCloseChannels.request, callback);
  },
  startManualPaste: (...args: unknown[]) =>
    invokeManual('startManualPaste', args),
  retryManualPasteImage: (...args: unknown[]) =>
    invokeManual('retryManualPasteImage', args),
  openDraftSession: (...args: unknown[]) =>
    invokeDraft('openDraftSession', args),
  checkDraftSession: (...args: unknown[]) =>
    invokeDraft('checkDraftSession', args),
  closeDraftSession: (...args: unknown[]) =>
    invokeDraft('closeDraftSession', args),
  prepareDraft: (...args: unknown[]) => invokeDraft('prepareDraft', args),
  startDraft: (...args: unknown[]) => invokeDraft('startDraft', args),
  getDraftState: (...args: unknown[]) => invokeDraft('getDraftState', args),
  stopDraft: (...args: unknown[]) => invokeDraft('stopDraft', args),
  reconcileDraft: (...args: unknown[]) => invokeDraft('reconcileDraft', args),
  finishHandledTask: (...args: unknown[]) =>
    invokeDraft('finishHandledTask', args),
  prepareTaskClosure: (...args: unknown[]) =>
    invokeDraft('prepareTaskClosure', args),
  confirmTaskClosure: (...args: unknown[]) =>
    invokeDraft('confirmTaskClosure', args),
  openSavedDraft: (...args: unknown[]) => invokeDraft('openSavedDraft', args),
  beginManualArticle: (...args: unknown[]) =>
    invokeManual('beginManualArticle', args),
  getManualArticleState: (...args: unknown[]) =>
    invokeManual('getManualArticleState', args),
  updateManualDraft: (...args: unknown[]) =>
    invokeManual('updateManualDraft', args),
  pickManualImage: (...args: unknown[]) =>
    invokeManual('pickManualImage', args),
  getManualImage: (...args: unknown[]) => invokeManual('getManualImage', args),
  saveManualArticle: (...args: unknown[]) =>
    invokeManual('saveManualArticle', args),
  cancelManualOperation: (...args: unknown[]) =>
    invokeManual('cancelManualOperation', args),
  discardManualArticle: (...args: unknown[]) =>
    invokeManual('discardManualArticle', args),
  getArticleDeclarations: (...args: unknown[]) =>
    invoke('getArticleDeclarations', args),
  setArticleDeclarations: (...args: unknown[]) =>
    invoke('setArticleDeclarations', args),
  startArticleImport: (...args: unknown[]) =>
    invoke('startArticleImport', args),
  getImportStatus: (...args: unknown[]) => invoke('getImportStatus', args),
  cancelArticleImport: (...args: unknown[]) =>
    invoke('cancelArticleImport', args),
  listArticles: (...args: unknown[]) => invoke('listArticles', args),
  getArticlePreview: (...args: unknown[]) => invoke('getArticlePreview', args),
  getArticleImage: (...args: unknown[]) => invoke('getArticleImage', args),
  async getAppStatus(...args: unknown[]) {
    NoArgumentsSchema.parse(args);
    return AppStatusSchema.parse(await ipcRenderer.invoke(APP_STATUS_CHANNEL));
  },
});
contextBridge.exposeInMainWorld('desktopApi', api);

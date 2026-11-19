import { registerUploadWaitSettings } from './upload-wait-settings';
import { parseUploadWaits } from '../../infrastructure/platforms/judongche/upload-waits';
import { createCoverSaveService } from '../../application/cover-save';
import { createBrowserHealthController } from '../../application/browser-health-controller';
import { registerBrowserHealthHandlers } from './browser-health-ipc';
import type { BrowserHealthView } from '../../contracts/browser-health';
import {
  createBatchController,
  type BatchController,
} from '../../application/batch-controller';
import { openDraftBatchRepository } from '../../infrastructure/persistence/draft-batch-repository';
import { registerBatchHandlers } from './batch-ipc';
import type { BatchCommandResult } from '../../contracts/draft-batch';
import { createArticleCoverController } from '../../application/article-cover';
import { registerArticleCoverHandlers } from './article-cover-ipc';
import { registerOperationControlHandlers } from './operation-control-ipc';
import { createOperationControl } from '../../application/operation-control';
import type { OperationOwnerState } from '../../contracts/operation-control';
import { createCoverFilePicker } from './article-cover-picker';
import type {
  ArticleCoverApi,
  CoverSaveCommand,
} from '../../contracts/article-cover';
import { createCoverRecovery } from '../../application/cover-recovery';
import { createCoverAssetStore } from '../../infrastructure/assets/cover-asset-store';
import { createArticleDeletion } from '../../application/article-delete';
import { registerArticleDeletionHandlers } from './article-delete-ipc';
import { app, BrowserWindow, dialog, clipboard, ClipboardItem } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync as readArchiveBytes } from 'original-fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createDraftController,
  type DraftController,
} from '../../application/draft-controller';
import { createDraftPreparation } from '../../application/draft-preparation';
import { createDraftSnapshotPort } from '../../infrastructure/assets/draft-snapshot';
import { openDraftTaskRepository } from '../../infrastructure/persistence/draft-task-repository';
import { createBrowserSession } from '../../infrastructure/automation/browser-session';
import { createJudongcheAdapter } from '../../infrastructure/platforms/judongche/draft-adapter';
import { createRuntimeIdentity, writeProbeLog } from './probe-log';
import type {
  DraftCommandResult,
  DraftView,
  ReasonCode,
} from '../../contracts/draft-task';
import { registerDraftHandlers } from './draft-ipc';
import type { BaselineStore } from '../../domain/ports/baseline-store';
import { getAppStatus } from '../../application/get-app-status';
import { createArticleImportService } from '../../application/article-import';
import { openArticleRepository } from '../../infrastructure/persistence/article-repository';
import { createAssetStore } from '../../infrastructure/assets/asset-store';
import { readLocalImage } from '../../infrastructure/assets/local-reader';
import { readRemoteImage } from '../../infrastructure/assets/remote-reader';
import { verifyImageRuntime } from '../../infrastructure/assets/runtime-health';
import { ImportFailure } from '../../domain/import-error';
import { createWindow } from './window';
import { registerStatusHandler } from './ipc';
import { registerLibraryHandlers } from './library-ipc';
import { protectShutdown, confirmManualShutdown } from './shutdown';
import { createImportController } from '../../application/import-controller';
import { createArticleLibrary } from '../../application/article-library';
import { readArticleFile } from '../../infrastructure/assets/article-file';
import { createArticleDeclarations } from '../../application/article-declaration';
import { createManualArticleController } from '../../application/manual-article';
import { createArticleRevisionService } from '../../application/article-revision';
import { createRevisionAssetStore } from '../../infrastructure/assets/revision-asset-store';
import {
  createManualClipboard,
  createClipboardFragmentPort,
} from '../../infrastructure/content/manual-clipboard';
import { registerManualCloseHandlers } from './manual-close-ipc';
import { createManualTempStore } from '../../infrastructure/assets/manual-temp-store';
import { createManualImageSource } from '../../infrastructure/assets/manual-image-source';
import { createWebPasteImageReader } from '../../infrastructure/assets/web-paste-image-reader';
import { createRichWebPasteConverter } from '../../infrastructure/content/web-paste-converter';
import { registerManualHandlers, createManualDesktopApi } from './manual-ipc';
import {
  createLibraryWriteGate,
  createArticleWriteRecovery,
} from './library-write-gate';
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
let store: BaselineStore | undefined;
// Standard launch-time data location; never exposed through the renderer bridge.
const userDataDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (userDataDirectory && isAbsolute(userDataDirectory))
  app.setPath('userData', userDataDirectory);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});
if (primaryInstance)
  void app.whenReady().then(async () => {
    const runtimeIdentity = createRuntimeIdentity(
      {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        asarPath: app.getAppPath(),
      },
      readArchiveBytes,
    );
    let repository: ReturnType<typeof openArticleRepository> | undefined;
    let service: ReturnType<typeof createArticleImportService> | undefined;
    let library: ReturnType<typeof createArticleLibrary> | undefined;
    let recovery: ReturnType<typeof createArticleWriteRecovery> | undefined;
    let revisions: ReturnType<typeof createArticleRevisionService> | undefined;
    const manualTemp = createManualTempStore(app.getPath('userData'));
    const assets = createAssetStore(join(app.getPath('userData'), 'assets'));
    const manualImages = createManualImageSource(manualTemp, assets);
    const manualClipboard = createManualClipboard(
      manualImages,
      createClipboardFragmentPort({
        write: ({ text, html }) =>
          clipboard.write([
            new ClipboardItem({ 'text/plain': text, 'text/html': html }),
          ]),
        readBack: async () => {
          const items = await clipboard.read();
          if (
            items.length !== 1 ||
            !items[0].types.includes('text/html') ||
            !items[0].types.includes('text/plain')
          )
            return { text: '', html: '' };
          const text = await items[0].getType('text/plain'),
            html = await items[0].getType('text/html');
          if (
            !(text instanceof Blob) ||
            !(html instanceof Blob) ||
            text.size + html.size > 2 * 1024 * 1024
          )
            return { text: '', html: '' };
          return { text: await text.text(), html: await html.text() };
        },
      }),
    );
    let tasks: ReturnType<typeof openDraftTaskRepository> | undefined;
    let snapshots: ReturnType<typeof createDraftSnapshotPort> | undefined;
    let draft: DraftController | undefined;
    let batch: BatchController | undefined;
    let batches: ReturnType<typeof openDraftBatchRepository> | undefined;
    // Main owns only lifecycle capabilities; browser handles stay in infrastructure.
    let browser: { close(): Promise<void>; isOccupied(): boolean } | undefined;
    let health: ReturnType<typeof createBrowserHealthController> | undefined;
    try {
      const data = join(app.getPath('userData'), 'data');
      mkdirSync(data, { recursive: true });
      const migrations = app.isPackaged
        ? join(process.resourcesPath, 'migrations')
        : join(app.getAppPath(), 'src/infrastructure/persistence/migrations');
      repository = openArticleRepository(join(data, 'app.sqlite'), migrations);
      tasks = openDraftTaskRepository(join(data, 'app.sqlite'), migrations);
      tasks.recover(new Date().toISOString());
      batches = openDraftBatchRepository(join(data, 'app.sqlite'), migrations);
      batches.recover(new Date().toISOString());
      snapshots = createDraftSnapshotPort(assets, {
        repository,
        assets: createCoverAssetStore(app.getPath('userData'), repository),
      });
      service = createArticleImportService(
        repository,
        assets,
        {
          read: (source, capability, signal) => {
            if (capability?.kind === 'manual-images') {
              if (source.type !== 'local')
                throw new ImportFailure('SOURCE_NOT_ALLOWED');
              return manualImages.readCapability(
                capability,
                source.path,
                signal,
              );
            }
            if (source.type === 'remote')
              return readRemoteImage(source.url, signal);
            if (!capability) throw new ImportFailure('SOURCE_NOT_ALLOWED');
            return readLocalImage(capability, source.path, signal);
          },
        },
        manualImages,
      );
      revisions = createArticleRevisionService(
        repository,
        createRevisionAssetStore(
          join(app.getPath('userData'), 'assets'),
          repository,
          manualImages,
        ),
        service.importEditedArticle,
      );
      await verifyImageRuntime();
      recovery = createArticleWriteRecovery(
        service,
        manualTemp,
        revisions,
        createCoverRecovery(
          repository,
          createCoverAssetStore(app.getPath('userData'), repository),
        ),
      );
      if (!(await recovery.recover()))
        throw new ImportFailure('RECOVERY_REQUIRED');
      store = repository;
      library = createArticleLibrary(repository, assets, repository);
    } catch {
      try {
        batches?.close();
        tasks?.close();
      } finally {
        repository?.close();
      }
      batches = undefined;
      tasks = undefined;
      repository = undefined;
      store = undefined;
      service = undefined;
      library = undefined;
      console.error('INITIALIZATION_FAILED');
    }
    const window = createWindow(
      MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      MAIN_WINDOW_WEBPACK_ENTRY,
    );
    const getUploadWaitSettings = registerUploadWaitSettings(
      window,
      MAIN_WINDOW_WEBPACK_ENTRY,
      app.getPath('userData'),
      app.isPackaged ? dirname(app.getPath('exe')) : undefined,
      () => {
        void dialog.showMessageBox(window, {
          type: 'warning',
          message: '已使用默认等待时间。可在左上角 Settings中重新保存。',
        });
      },
    );
    const controller =
      store && service
        ? createImportController({
            newId: randomUUID,
            importArticle: service.importArticle,
            choose: async (signal) => {
              if (signal.aborted) return undefined;
              const selected = await dialog.showOpenDialog(window, {
                title: '导入文章',
                properties: ['openFile'],
                filters: [{ name: '文章包', extensions: ['json'] }],
              });
              if (
                signal.aborted ||
                selected.canceled ||
                selected.filePaths.length !== 1
              )
                return undefined;
              return readArticleFile(selected.filePaths[0], signal);
            },
          })
        : undefined;
    let isClosing = () => false;
    let operationsStopping = () => false;
    let unresolvedStop = () => false;
    let flushingRestart = false;
    let cover: ReturnType<typeof createArticleCoverController> | undefined;
    let completingCoverClose = false;
    // Durable occupancy survives a browser/controller construction failure.
    const isBatchBlocked = () => {
      try {
        if (!batches) return true;
        if (batch) return batch.isActive() || batch.isBlocked();
        const current = batches.getCurrent();
        return !!current && !['completed', 'stopped'].includes(current.state);
      } catch {
        return true;
      }
    };
    const isDraftBlocked = () => {
      try {
        return (
          isBatchBlocked() || (draft ? draft.isBlocked() : !!tasks?.occupied())
        );
      } catch {
        return true;
      }
    };
    const manualGate = (closing: boolean, stopFlush = false) =>
      !store ||
      !recovery?.isReady() ||
      !revisions?.isReady() ||
      !manualClipboard.isReady() ||
      closing ||
      cover?.isBlocked() ||
      controller?.isBlocked()
        ? ('unavailable' as const)
        : isDraftBlocked() ||
            (operationsStopping() && !stopFlush) ||
            cover?.hasSession() ||
            cover?.isActive() ||
            controller?.isActive() ||
            draft?.isActive()
          ? ('busy' as const)
          : ('ready' as const);
    const coverPicker = createCoverFilePicker(async (count, signal) => {
      if (signal.aborted) return undefined;
      const selected = await dialog.showOpenDialog(window, {
        title: '选择封面图片',
        properties:
          count === 1 ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [{ name: '封面图片', extensions: ['jpg', 'jpeg', 'png'] }],
      });
      if (signal.aborted || selected.canceled) return undefined;
      return selected.filePaths;
    });
    const coverAssets = repository
      ? createCoverAssetStore(app.getPath('userData'), repository)
      : undefined;
    const coverWriter =
      repository && coverAssets
        ? createCoverSaveService(repository, coverAssets)
        : undefined;
    const manual =
      store && service && repository
        ? createManualArticleController({
            documents: {
              covers:
                coverWriter && coverAssets
                  ? {
                      picker: coverPicker,
                      loadCover: (key) => repository!.loadCover(key),
                      readImage: (config, assetKey) =>
                        coverAssets.readCoverAsset(config, assetKey),
                      save: coverWriter.save,
                      getSaveResult: coverWriter.getSaveResult,
                    }
                  : undefined,
              createEditorCompatibilityLease: (...args) =>
                repository!.createEditorCompatibilityLease(...args),
              releaseEditorCompatibilityLease: (lease) =>
                repository!.releaseEditorCompatibilityLease(lease),
              loadEditableArticle: (articleKey) =>
                repository!.loadEditableArticle(articleKey),
              storedImages: manualImages,
              saveRevision: (input, signal) =>
                revisions!.saveRevision(input, signal),
              getSaveResult: (operationId) =>
                revisions!.getSaveResult(operationId),
              clipboard: manualClipboard,
              digest: (value) =>
                createHash('sha256')
                  .update(JSON.stringify(value))
                  .digest('hex'),
              respondClose: (...args) =>
                closeProtocol?.respond(...args) ?? false,
            },
            newId: randomUUID,
            converter: createRichWebPasteConverter(
              app.isPackaged
                ? join(process.resourcesPath, 'web-paste-worker.cjs')
                : join(
                    app.getAppPath(),
                    '.cache/web-paste-worker/web-paste-worker.cjs',
                  ),
            ),
            pasteImages: createWebPasteImageReader(manualImages),
            fingerprint: (input) =>
              createHash('sha256')
                .update(
                  JSON.stringify(
                    'html' in input
                      ? ['paste', input.html, input.plain]
                      : ['retry', input.candidateId],
                  ),
                )
                .digest('hex'),
            externalExists: (id) => !!repository!.findExternal(id),
            gate: () => manualGate(isClosing()),
            editGate: () =>
              manualGate(
                isClosing() && !closeProtocol?.isPending(),
                flushingRestart && !!closeProtocol?.isPending(),
              ),
            flushForRestart: async () => {
              // Absence of the ready latch cannot prove renderer-only input safe.
              if (!closeProtocol?.enabled()) return false;
              flushingRestart = true;
              try {
                return (await closeProtocol.requestFlush()) === true;
              } finally {
                flushingRestart = false;
              }
            },
            closeGate: () => manualGate(false),
            chooseImage: async (sessionId, signal) => {
              if (signal.aborted) return undefined;
              const selected = await dialog.showOpenDialog(window, {
                title: '添加图片',
                properties: ['openFile'],
                filters: [
                  {
                    name: '正文图片',
                    extensions: ['jpg', 'jpeg', 'png', 'webp'],
                  },
                ],
              });
              if (
                signal.aborted ||
                selected.canceled ||
                selected.filePaths.length !== 1
              )
                return undefined;
              return manualImages.authorize(
                sessionId,
                selected.filePaths[0],
                signal,
              );
            },
            readImage: (sessionId, token, signal) =>
              manualImages.read(sessionId, token, signal),
            retainImages: (sessionId, tokens, options) =>
              manualImages.retain(sessionId, tokens, options),
            releaseImages: (sessionId) => manualImages.release(sessionId),
            save: (input, sessionId, signal) =>
              service!.importArticle(input, {
                capability: manualImages.capability(sessionId),
                signal,
              }),
          })
        : undefined;
    if (repository && recovery?.isReady()) {
      cover = createArticleCoverController({
        repository,
        assets: createCoverAssetStore(app.getPath('userData'), repository),
        picker: coverPicker,
        gate: () =>
          !store ||
          !recovery?.isReady() ||
          !revisions?.isReady() ||
          !manualClipboard.isReady() ||
          (isClosing() && !completingCoverClose) ||
          controller?.isBlocked() ||
          manual?.isBlocked() ||
          isDraftBlocked()
            ? 'unavailable'
            : operationsStopping() ||
                manual?.hasSession() ||
                manual?.isActive() ||
                controller?.isActive() ||
                draft?.isActive()
              ? 'busy'
              : 'ready',
        newId: randomUUID,
        now: () => new Date().toISOString(),
        digest: (value) =>
          createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      });
      await cover.recover();
    }
    if (store && repository && tasks && snapshots && batches) {
      try {
        const root = resolve(app.getPath('userData'));
        const profile = resolve(root, 'profiles', 'judongche');
        const contained = relative(root, profile);
        if (!contained || contained.startsWith('..') || isAbsolute(contained))
          throw new Error('BROWSER_UNAVAILABLE');
        let browserOperationEpoch = 0;
        const session = createBrowserSession(profile, {
          temporaryRoot: resolve(root, 'browser-health'),
          onBusinessDisconnect: (check, closeRequested) => {
            const task = tasks?.occupied();
            writeProbeLog(
              root,
              { operation: 'business-browser', check, closeRequested },
              task ? { taskId: task.taskId } : null,
              runtimeIdentity,
            );
          },
          operationEpoch: () => browserOperationEpoch,
        });
        browser = session;
        const invalidateOperation = () => {
          browserOperationEpoch++;
          session.invalidateHealth();
        };
        health = createBrowserHealthController({
          runtime: session,
          operationEpoch: () => browserOperationEpoch,
          invalidateOperation,
          admission: (): BrowserHealthView['reason'] => {
            try {
              if (
                isClosing() ||
                operationsStopping() ||
                unresolvedStop() ||
                !store ||
                !recovery?.isReady() ||
                !revisions?.isReady() ||
                !manualClipboard.isReady() ||
                !draft ||
                draft.isActive() ||
                draft.isBlocked() ||
                isBatchBlocked() ||
                controller?.isActive() ||
                controller?.isBlocked() ||
                manual?.hasSession() ||
                manual?.isActive() ||
                manual?.isBlocked() ||
                cover?.hasSession() ||
                cover?.isActive() ||
                cover?.isBlocked()
              )
                return 'task_busy';
              return session.hasBusinessSession() ? 'business_open' : null;
            } catch {
              return 'task_busy';
            }
          },
        });
        const platform = createJudongcheAdapter(
          session,
          (event) => {
            if (event.coverClick) {
              writeProbeLog(
                root,
                event,
                { taskId: event.coverClick.taskId },
                runtimeIdentity,
              );
              return;
            }
            const task =
              tasks!.occupied() ??
              (event.check === 'editor-page-crashed'
                ? undefined
                : tasks!.latest());
            const taskState = task
              ? {
                  taskId: task.taskId,
                  state: task.state,
                  stage: task.stage,
                  saveAttempted: task.saveAttempted,
                  possibleRemoteEffect: task.possibleRemoteEffect,
                  holdsPlatform: task.holdsPlatform,
                  reason: task.reason,
                  imageEvidenceCount: task.evidence.images.length,
                  hasRemoteRef: !!task.evidence.remote,
                }
              : null;
            writeProbeLog(root, event, taskState, runtimeIdentity);
          },
          {
            get uploadWaits() {
              return parseUploadWaits(getUploadWaitSettings());
            },
            manualReview: true,
            automaticDraftReview: false,
            batchSubmissionReview: 'operator',
          },
        );
        const preparation = createDraftPreparation({
          contentCapabilities: () => platform.contentCapabilities(),
          repository,
          covers: repository,
          tasks,
          snapshots,
          newId: randomUUID,
        });
        const platformGate = () =>
          !store ||
          !recovery?.isReady() ||
          !revisions?.isReady() ||
          !manualClipboard.isReady() ||
          isClosing() ||
          controller?.isBlocked() ||
          manual?.isBlocked() ||
          cover?.isBlocked()
            ? 'unavailable'
            : session.isOccupied() ||
                unresolvedStop() ||
                cover?.hasSession() ||
                cover?.isActive() ||
                controller?.isActive() ||
                manual?.hasSession() ||
                manual?.isActive()
              ? 'busy'
              : 'ready';
        draft = createDraftController({
          invalidateBrowserHealth: invalidateOperation,
          tasks,
          snapshots,
          preparation,
          platform,
          newId: randomUUID,
          now: () => new Date().toISOString(),
          gate: platformGate,
        });
        batch = createBatchController({
          repository: batches,
          draft,
          preparation,
          articles: repository,
          snapshots,
          newId: randomUUID,
          now: () => new Date().toISOString(),
          gate: platformGate,
        });
      } catch {
        console.error('PLATFORM_INITIALIZATION_FAILED');
      }
    }
    const ownerState = (
      owner:
        | { isActive(): boolean; isBlocked(): boolean; hasSession?(): boolean }
        | undefined,
    ): OperationOwnerState =>
      !owner
        ? 'needs_review'
        : owner.isActive()
          ? 'active'
          : owner.isBlocked() || owner.hasSession?.()
            ? 'needs_review'
            : 'idle';
    const operations = createOperationControl({
      draft: {
        requestStop: () => {
          batch?.requestStop();
          draft?.requestStop();
        },
        settle: async () => {
          if (batch) await batch.stopForRestart();
          else if (draft) await draft.stopForRestart();
          else throw Error('Platform unavailable');
        },
        state: () =>
          batch?.isActive() || draft?.isActive()
            ? 'active'
            : !batch || isDraftBlocked()
              ? 'needs_review'
              : ownerState(draft),
      },
      manual: {
        requestStop: () => manual?.requestStop(),
        settle: async () => {
          if (!manual) throw Error('Manual unavailable');
          await manual.stopForRestart();
        },
        state: () => ownerState(manual),
      },
      cover: {
        requestStop: () => cover?.requestStop(),
        settle: async () => {
          if (!cover) throw Error('Cover unavailable');
          await cover.stopForRestart();
        },
        state: () => ownerState(cover),
      },
      import: {
        requestStop: () => controller?.requestStop(),
        state: () => ownerState(controller),
      },
    });
    operationsStopping = operations.isStopping;
    unresolvedStop = operations.hasUnresolvedStop;
    registerOperationControlHandlers(
      window,
      MAIN_WINDOW_WEBPACK_ENTRY,
      operations,
    );
    const closeProtocol = registerManualCloseHandlers(
      window,
      MAIN_WINDOW_WEBPACK_ENTRY,
      () =>
        manual?.getManualArticleState() ?? {
          state: 'unavailable',
          revision: 0,
        },
      randomUUID,
    );
    isClosing = protectShutdown(
      app,
      window,
      {
        isActive: () =>
          !!(
            cover?.isActive() ||
            controller?.isActive() ||
            manual?.isActive() ||
            draft?.isActive() ||
            batch?.isActive()
          ),
        stopAndWait: async () => {
          batch?.requestStop();
          await Promise.all([
            batch?.stopAndWait(),
            cover?.stopAndWait(),
            draft?.stopAndWait(),
            controller?.stopAndWait(),
            manual?.stopAndWait(),
          ]);
          await manualClipboard.drain();
          await browser?.close();
        },
      },
      () => {
        try {
          batches?.close();
          tasks?.close();
        } finally {
          store?.close();
        }
        health?.dispose();
        tasks = undefined;
        store = undefined;
        library = undefined;
      },
      async () => {
        if (cover?.hasSession()) {
          let state = await cover.getCoverEditState();
          if (state.status === 'saving') {
            await cover.waitForSettlement();
            state = await cover.getCoverEditState();
          }
          if (cover.isBlocked()) return false;
          if ('sessionId' in state) {
            if (state.dirty || state.status === 'selecting') {
              const answer = await dialog.showMessageBox(window, {
                type: 'question',
                title: '关闭应用',
                message: '封面修改尚未保存。',
                detail:
                  '选择保存封面、放弃本次封面修改或继续编辑。正在选择的图片会先结算；保存结果不明时应用保持打开。',
                buttons: ['继续编辑', '保存封面并关闭', '放弃封面并关闭'],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              });
              if (answer.response === 0) return false;
              if (answer.response === 1) {
                await cover.waitForSettlement();
                const current = await cover.getCoverEditState();
                if (
                  !('sessionId' in current) ||
                  current.status !== 'open' ||
                  cover.isBlocked()
                )
                  return false;
                completingCoverClose = true;
                try {
                  const saved = await cover.saveCoverEdit({
                    sessionId: current.sessionId,
                    expectedDraftRevision: current.draftRevision,
                    operationId: randomUUID(),
                  });
                  if (saved.status !== 'committed') return false;
                } finally {
                  completingCoverClose = false;
                }
              }
            }
            const closed = await cover.closeCoverEdit(state.sessionId);
            if ('sessionId' in closed || cover.isBlocked()) return false;
          }
        }
        const flushResult = await closeProtocol!.requestFlush();
        if (flushResult === false) return false;
        if (typeof flushResult === 'object') {
          const safeBlockedDiscard = () => {
            if (
              !closeProtocol.isCurrentBlocked(flushResult) ||
              !manual ||
              manual.isActive() ||
              manual.isBlocked() ||
              controller?.isActive() ||
              controller?.isBlocked() ||
              draft?.isActive() ||
              isDraftBlocked() ||
              !recovery?.isReady() ||
              !revisions?.isReady() ||
              !manualClipboard.isReady()
            )
              return false;
            const current = manual.getManualArticleState();
            if (
              !('sessionId' in current) ||
              current.state !== 'editing' ||
              current.sessionId !== flushResult.sessionId ||
              current.documentRevision !== flushResult.documentRevision
            )
              return false;
            if (current.target.kind === 'existing') {
              const formal = repository?.loadEditableArticle(
                current.target.articleKey,
              );
              if (
                !formal ||
                formal.article.externalId !== current.target.externalId ||
                formal.article.importId !== current.target.importId ||
                formal.articleRevision !== current.target.baseArticleRevision
              )
                return false;
            }
            return true;
          };
          if (!safeBlockedDiscard()) {
            closeProtocol.retireBlocked();
            return false;
          }
          const answer = await dialog.showMessageBox(window, {
            type: 'question',
            title: '关闭应用',
            message: '当前输入尚未确认，请修改后继续或放弃本次编辑。',
            detail: '已保存的文章保留；放弃后当前未保存输入无法恢复。',
            buttons: ['继续编辑', '放弃并关闭'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (answer.response !== 1 || !safeBlockedDiscard()) {
            closeProtocol.retireBlocked();
            return false;
          }
          closeProtocol.retireBlocked();
          const result = await manual!.confirmManualEditorClose('discard');
          await manual!.waitForSettlement();
          return (
            result.status === 'ok' &&
            !manual!.hasSession() &&
            !manual!.isBlocked() &&
            !!revisions?.isReady() &&
            manualClipboard.isReady()
          );
        }
        if (closeProtocol!.enabled() && manual) {
          {
            if (
              manual.isActive() ||
              (manual.isBlocked() && !manual.canDiscardVerifiedConflict()) ||
              !revisions?.isReady() ||
              !manualClipboard.isReady()
            )
              return false;
            if (manual.canDiscardVerifiedConflict()) {
              const answer = await dialog.showMessageBox(window, {
                type: 'question',
                title: '关闭应用',
                message: '文章已由其他操作更新，当前编辑内容已保留。',
                detail: '是否放弃当前本地编辑内容并关闭？正式文章不会修改。',
                buttons: ['继续查看', '放弃并关闭'],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              });
              if (answer.response !== 1) return false;
              const result = await manual.confirmManualEditorClose('discard');
              return (
                result.status === 'ok' &&
                !manual.hasSession() &&
                !manual.isBlocked()
              );
            }
            const state = manual.getManualArticleState();
            if (!('sessionId' in state) || !manual.hasUnsavedChanges())
              return true;
            const answer = await dialog.showMessageBox(window, {
              type: 'question',
              title: '关闭应用',
              message: '当前修改尚未保存。',
              buttons: ['继续编辑', '保存并关闭', '放弃并关闭'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (answer.response === 0) return false;
            const confirmed = manual.getManualArticleState();
            if (!('sessionId' in confirmed)) return false;
            const result = await manual.confirmManualEditorClose(
              answer.response === 1 ? 'save' : 'discard',
            );
            if (result.status !== 'ok' && result.status !== 'started')
              return false;
            await manual.waitForSettlement();
            return (
              !manual.hasSession() &&
              !manual.isBlocked() &&
              !!revisions?.isReady()
            );
          }
        }
        return confirmManualShutdown(manual, async () => {
          const answer = await dialog.showMessageBox(window, {
            type: 'question',
            title: '关闭应用',
            message: '未保存的录入内容将在关闭后丢失。',
            detail:
              '是否放弃本次录入并关闭应用？正在进行的保存会先安全停止；已经保存的文章会保留。',
            buttons: ['继续录入', '放弃并关闭'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return answer.response === 1;
        });
      },
    );
    const libraryWriteGate = createLibraryWriteGate({
      available: () =>
        !!store &&
        !!recovery?.isReady() &&
        !!revisions?.isReady() &&
        manualClipboard.isReady(),
      isClosing: () => isClosing() || operationsStopping(),
      imports: controller,
      manual,
      cover,
      draft: {
        isActive: () => !!(draft?.isActive() || batch?.isActive()),
        isBlocked: isDraftBlocked,
      },
    });
    const deletion = repository
      ? createArticleDeletion({
          repository,
          gate: libraryWriteGate.state,
          now: () => new Date().toISOString(),
        })
      : undefined;
    const coverUnavailable = async () => ({
      status: 'unavailable' as const,
      notice: 'blocked' as const,
    });
    const coverApi: ArticleCoverApi = {
      getArticleCover: (key) =>
        cover?.getArticleCover(key) ??
        Promise.resolve({ status: 'unavailable' }),
      beginCoverEdit: (key) =>
        isClosing()
          ? coverUnavailable()
          : (cover?.beginCoverEdit(key) ?? coverUnavailable()),
      getCoverEditState: () => cover?.getCoverEditState() ?? coverUnavailable(),
      setCoverDraft: (command, draft) =>
        isClosing()
          ? coverUnavailable()
          : (cover?.setCoverDraft(command, draft) ?? coverUnavailable()),
      pickCoverImages: (command, slots) =>
        isClosing()
          ? coverUnavailable()
          : (cover?.pickCoverImages(command, slots) ?? coverUnavailable()),
      copyCoverImage: (command, source) =>
        isClosing()
          ? coverUnavailable()
          : (cover?.copyCoverImage(command, source) ?? coverUnavailable()),
      getCoverImage: (request) =>
        isClosing()
          ? Promise.resolve({ status: 'unavailable' })
          : (cover?.getCoverImage(request) ??
            Promise.resolve({ status: 'unavailable' })),
      saveCoverEdit: (command: CoverSaveCommand) =>
        isClosing()
          ? Promise.resolve({
              status: 'unavailable',
              operationId: command.operationId,
            })
          : (cover?.saveCoverEdit(command) ??
            Promise.resolve({
              status: 'unavailable',
              operationId: command.operationId,
            })),
      getCoverSaveResult: (id) =>
        cover?.getCoverSaveResult(id) ??
        Promise.resolve({ status: 'unavailable', operationId: id }),
      closeCoverEdit: (id) =>
        isClosing()
          ? coverUnavailable()
          : (cover?.closeCoverEdit(id) ?? coverUnavailable()),
    };
    registerArticleCoverHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, coverApi);
    registerArticleDeletionHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, {
      deleteArticle: async (command) =>
        deletion?.deleteArticle(command) ?? {
          status: 'unavailable',
          operationId: command.operationId,
        },
      getArticleDeletionResult: async (operationId) =>
        deletion?.getArticleDeletionResult(operationId) ?? {
          status: 'unavailable',
          operationId,
        },
    });
    const declarations =
      store && repository
        ? createArticleDeclarations(repository, libraryWriteGate.state)
        : undefined;
    registerLibraryHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, {
      getArticleDeclarations: async (keys) =>
        declarations?.getArticleDeclarations(keys) ?? { status: 'unavailable' },
      setArticleDeclarations: async (change) =>
        declarations?.setArticleDeclarations(change) ?? {
          status: 'unavailable',
        },
      startArticleImport: async () => libraryWriteGate.startImport(),
      getImportStatus: async () =>
        controller?.snapshot() ?? { state: 'idle', revision: 0 },
      cancelArticleImport: async (jobId) =>
        controller?.cancel(jobId) ?? { state: 'idle', revision: 0 },
      listArticles: async (cursor) =>
        library?.listArticles(cursor) ?? { status: 'unavailable' },
      getArticlePreview: async (articleKey) =>
        library?.getArticlePreview(articleKey) ?? { status: 'unavailable' },
      getArticleImage: async (articleKey, assetKey) =>
        library?.getArticleImage(articleKey, assetKey) ?? {
          status: 'unavailable',
        },
    });
    registerManualHandlers(
      window,
      MAIN_WINDOW_WEBPACK_ENTRY,
      createManualDesktopApi(manual),
    );
    const draftReason = (): ReasonCode | undefined =>
      isClosing()
        ? 'STOP_REQUESTED'
        : !store
          ? 'STORAGE_UNAVAILABLE'
          : !draft
            ? 'BROWSER_UNAVAILABLE'
            : undefined;
    const draftView = async (): Promise<DraftView> =>
      draft?.getDraftState() ?? {
        session: {
          status: 'blocked',
          bindingToken: null,
          storeName: null,
          reason: draftReason() ?? 'BROWSER_UNAVAILABLE',
        },
        preparation: null,
        task: null,
      };
    const draftCommand = async (
      run: () => Promise<DraftCommandResult>,
      requiresBrowserAdmission: boolean,
      allowBatch = false,
    ): Promise<DraftCommandResult> => {
      const reason =
        draftReason() ??
        (requiresBrowserAdmission && browser?.isOccupied()
          ? 'PLATFORM_BUSY'
          : undefined) ??
        (!allowBatch && isBatchBlocked() ? 'PLATFORM_BUSY' : undefined);
      // Admission must be checked before any await, including view projection.
      return reason
        ? { status: 'blocked', reason, view: await draftView() }
        : run();
    };
    registerDraftHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, {
      getDraftState: draftView,
      finishHandledTask: (input) =>
        draftCommand(() => draft!.finishHandledTask(input), true),
      openDraftSession: () =>
        draftCommand(() => draft!.openDraftSession(), true),
      checkDraftSession: () =>
        draftCommand(() => draft!.checkDraftSession(), true),
      closeDraftSession: () =>
        draftCommand(() => draft!.closeDraftSession(), false),
      prepareDraft: async (articleKey, bindingToken) => {
        const reason =
          draftReason() ??
          (browser?.isOccupied() || isBatchBlocked()
            ? 'PLATFORM_BUSY'
            : undefined);
        return reason
          ? { status: 'blocked', reason }
          : draft!.prepareDraft(articleKey, bindingToken);
      },
      startDraft: (id) => draftCommand(() => draft!.startDraft(id), true),
      stopDraft: (id) => draftCommand(() => draft!.stopDraft(id), false, true),
      reconcileDraft: (id) =>
        draftCommand(() => draft!.reconcileDraft(id), true),
      prepareTaskClosure: (id) =>
        draftCommand(() => draft!.prepareTaskClosure(id), true),
      confirmTaskClosure: (token) =>
        draftCommand(() => draft!.confirmTaskClosure(token), true),
      openSavedDraft: (id) =>
        draftCommand(() => draft!.openSavedDraft(id), true),
    });
    const batchUnavailable = async (): Promise<BatchCommandResult> => ({
      status: 'blocked',
      reason: isClosing() ? 'STOP_REQUESTED' : 'STORAGE_UNAVAILABLE',
      view: null,
    });
    registerBatchHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, {
      prepare: (input) =>
        !isClosing() && batch && !browser?.isOccupied()
          ? batch.prepare(input)
          : Promise.resolve({
              status: 'blocked',
              reason: isClosing()
                ? 'STOP_REQUESTED'
                : browser?.isOccupied()
                  ? 'PLATFORM_BUSY'
                  : 'STORAGE_UNAVAILABLE',
            }),
      start: (input) =>
        browser?.isOccupied()
          ? Promise.resolve({
              status: 'blocked',
              reason: 'PLATFORM_BUSY',
              view: null,
            })
          : !isClosing() && batch
            ? batch.start(input)
            : batchUnavailable(),
      skipCurrentAndContinue: (input) =>
        !isClosing() && batch && !browser?.isOccupied()
          ? batch.skipCurrentAndContinue(input)
          : browser?.isOccupied()
            ? Promise.resolve({
                status: 'blocked',
                reason: 'PLATFORM_BUSY',
                view: null,
              })
            : batchUnavailable(),
      stop: (input) => (batch ? batch.stop(input) : batchUnavailable()),
      finish: (input) =>
        !isClosing() && batch ? batch.finish(input) : batchUnavailable(),
      archiveFinishedBatch: (input) =>
        !isClosing() && batch
          ? batch.archiveFinishedBatch(input)
          : batchUnavailable(),
      getCurrent: () =>
        batch
          ? batch.getCurrent()
          : Promise.resolve(batches?.getCurrent() ?? null),
    });
    const unavailableHealth: BrowserHealthView = {
      status: 'unavailable',
      version: null,
      stage: null,
      reason: 'task_busy',
    };
    registerBrowserHealthHandlers(window, MAIN_WINDOW_WEBPACK_ENTRY, {
      getBrowserHealth: () =>
        health?.getBrowserHealth() ?? Promise.resolve(unavailableHealth),
      checkBrowserHealth: () =>
        health?.checkBrowserHealth() ??
        Promise.resolve({ status: 'blocked', view: unavailableHealth }),
      openBrowserUpdate: () =>
        health?.openBrowserUpdate() ??
        Promise.resolve({ status: 'blocked', view: unavailableHealth }),
    });
    window.once('closed', () => health?.dispose());
    registerStatusHandler(window, MAIN_WINDOW_WEBPACK_ENTRY, () =>
      getAppStatus(store, app.getVersion()),
    );
    void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY).catch(() => {
      console.error('WINDOW_LOAD_FAILED');
      app.quit();
    });
  });
app.on('window-all-closed', () => app.quit());

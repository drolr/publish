import type {
  BrowserHealthApi,
  BrowserHealthView,
} from '../../src/contracts/browser-health';
import type { BatchApi } from '../../src/contracts/draft-batch';
import type {
  StoredCoverConfiguration,
  ArticleCoverApi,
} from '../../src/contracts/article-cover';
import type {
  ArticleDeletionApi,
  DeleteArticleCommand,
} from '../../src/contracts/article-delete';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve, join } from 'node:path';
import type { DraftApi } from '../../src/contracts/draft-task';
import type { OperationControlApi } from '../../src/contracts/operation-control';
import type { ArticleLibraryApi } from '../../src/contracts/article-library';
import type { ManualArticleApi } from '../../src/contracts/manual-article';
import type { SnapshotPort } from '../../src/domain/ports/draft-task';
import type { ArticleCoverRepository } from '../../src/domain/ports/article-cover';
import { coverConfigurationDigest } from '../../src/infrastructure/persistence/article-cover-repository';
const h = vi.hoisted(() => ({
  healthApi: undefined as BrowserHealthApi | undefined,
  healthListener: undefined as ((view: BrowserHealthView) => void) | undefined,
  browserOccupied: false,
  businessOpen: false,
  browserEpoch: undefined as (() => number) | undefined,
  invalidateHealth: vi.fn(),
  healthCheck: vi.fn(async () => ({
    status: 'ok' as const,
    view: {
      status: 'passed' as const,
      version: '153.0.0.0',
      reason: null,
      stage: null,
    },
  })),
  batchApi: undefined as BatchApi | undefined,
  batchActive: false,
  batchBlocked: false,
  batchGate: undefined as (() => string) | undefined,
  operations: undefined as OperationControlApi | undefined,
  runtimeStops: vi.fn(),
  taskSnapshots: undefined as SnapshotPort | undefined,
  preparationCovers: undefined as
    Pick<ArticleCoverRepository, 'loadCover'> | undefined,
  coverApi: undefined as ArticleCoverApi | undefined,
  coverStoredConfiguration: undefined as StoredCoverConfiguration | undefined,
  closeFlushDrain: undefined as (() => Promise<void>) | undefined,
  coverRead: vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1])),
  closeAnswer: 1,
  closeBlocked: false,
  closeUnknown: false,
  closeStale: false,
  closeStaleAfterPrompt: false,
  closeState: { state: 'idle', revision: 0 } as Record<string, unknown>,
  formalEditable: {
    articleRevision: 2,
    article: { externalId: 'external', importId: 'import' },
  },
  primary: true,
  databaseFails: false,
  recoverFails: false,
  coverRecoveryFails: false,
  browserFails: false,
  persistedHold: false,
  draftActive: false,
  draftBlocked: false,
  manualActive: false,
  manualBlocked: false,
  importActive: false,
  manualSession: false,
  revisionReady: true,
  clipboardReady: true,
  imageRegistry: {},
  importerRegistry: undefined as unknown,
  revisionRegistry: undefined as unknown,
  order: [] as string[],
  draftApi: undefined as DraftApi | undefined,
  libraryApi: undefined as ArticleLibraryApi | undefined,
  deletionApi: undefined as ArticleDeletionApi | undefined,
  deleteArticle: vi.fn((command: DeleteArticleCommand) => ({
    status: 'deleted' as const,
    operationId: command.operationId,
    articleKey: command.articleKey,
    articleRevision: 2,
  })),
  readDeletionResult: vi.fn((operationId: string) => ({
    status: 'not_started' as const,
    operationId,
  })),
  manualApi: undefined as ManualArticleApi | undefined,
  draftGate: undefined as (() => string) | undefined,
  manualGate: undefined as (() => string) | undefined,
  manualEditGate: undefined as (() => string) | undefined,
  restartFlush: undefined as (() => Promise<boolean>) | undefined,
  flushPending: false,
  declarationGate: undefined as (() => string) | undefined,
  drain: undefined as (() => Promise<void>) | undefined,
  browserDrain: undefined as (() => Promise<void>) | undefined,
  manualDrain: undefined as (() => Promise<void>) | undefined,
  profile: '',
  app: undefined as unknown as EventEmitter & {
    quit: ReturnType<typeof vi.fn>;
    getPath: ReturnType<typeof vi.fn>;
    setPath: ReturnType<typeof vi.fn>;
    whenReady: ReturnType<typeof vi.fn>;
  },
  window: undefined as unknown as EventEmitter & {
    loadURL: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  },
  repoClose: vi.fn(),
  taskClose: vi.fn(),
  recover: vi.fn(),
  open: vi.fn(),
  start: vi.fn(),
  skipRecovery: vi.fn(async () => ({ status: 'ok', view: null })),
  finishHandled: vi.fn(async () => ({ status: 'ok', view: null })),
  prepare: vi.fn(),
  stop: vi.fn(),
  importStart: vi.fn(),
  browserClose: vi.fn(),
}));
vi.mock('electron', () => ({
  get app() {
    return h.app;
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {
    showMessageBox: async () => {
      if (h.closeStaleAfterPrompt) h.closeStale = true;
      return { response: h.closeAnswer };
    },
  },
}));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
// Electron supplies this built-in; this Node-only composition uses dev mode.
vi.mock('original-fs', () => ({
  readFileSync: () => {
    throw Error('development composition must not read an ASAR');
  },
}));
vi.mock('../../src/desktop/main/window', () => ({
  createWindow: () => h.window,
}));
vi.mock('../../src/desktop/main/upload-wait-settings', () => ({
  registerUploadWaitSettings: () => () => ({
    编辑页等待秒数: 30,
    正文光标点击秒数: 3,
    图片按钮和选文件秒数: 5,
    正文图片预览秒数: 30,
    图片插入和弹窗关闭秒数: 10,
    封面上传完成秒数: 90,
  }),
}));
vi.mock('../../src/desktop/main/browser-health-ipc', () => ({
  registerBrowserHealthHandlers: (
    _w: unknown,
    _u: unknown,
    api: BrowserHealthApi,
  ) => {
    h.healthApi = api;
  },
}));
vi.mock('../../src/desktop/main/ipc', () => ({
  registerStatusHandler: vi.fn(),
}));
vi.mock('../../src/desktop/main/operation-control-ipc', () => ({
  registerOperationControlHandlers: (
    _w: unknown,
    _u: unknown,
    api: OperationControlApi,
  ) => {
    h.operations = api;
  },
}));
vi.mock('../../src/desktop/main/article-cover-ipc', () => ({
  registerArticleCoverHandlers: (
    _w: unknown,
    _u: unknown,
    api: ArticleCoverApi,
  ) => {
    h.coverApi = api;
  },
}));
vi.mock('../../src/desktop/main/article-delete-ipc', () => ({
  registerArticleDeletionHandlers: (
    _w: unknown,
    _u: unknown,
    api: ArticleDeletionApi,
  ) => {
    h.deletionApi = api;
  },
}));
vi.mock('../../src/desktop/main/library-ipc', () => ({
  registerLibraryHandlers: (
    _w: unknown,
    _u: unknown,
    api: ArticleLibraryApi,
  ) => {
    h.libraryApi = api;
  },
}));
vi.mock('../../src/desktop/main/manual-ipc', async (original) => ({
  ...(await original<typeof import('../../src/desktop/main/manual-ipc')>()),
  registerManualHandlers: (_w: unknown, _u: unknown, api: ManualArticleApi) => {
    h.manualApi = api;
  },
}));
vi.mock('../../src/desktop/main/manual-close-ipc', () => ({
  registerManualCloseHandlers: () => ({
    enabled: () => h.closeBlocked,
    isPending: () => h.flushPending,
    requestFlush: async () => {
      h.flushPending = true;
      await h.closeFlushDrain?.();
      h.flushPending = false;
      return h.closeBlocked
        ? {
            requestId: 'request',
            sessionId: 'session',
            documentRevision: 4,
            status: 'blocked',
          }
        : true;
    },
    isCurrentBlocked: () => !h.closeStale,
    retireBlocked: vi.fn(),
    respond: () => false,
  }),
}));
vi.mock('../../src/infrastructure/assets/cover-asset-store', () => ({
  createCoverAssetStore: () => ({
    prepareCoverFiles: async () => [],
    readCoverAsset: h.coverRead,
    verifyCoverVersion: async () => {},
    cleanupOwnedUnreferenced: async () => {},
  }),
}));
vi.mock('../../src/infrastructure/assets/revision-asset-store', () => ({
  createRevisionAssetStore: (
    _directory: unknown,
    _repo: unknown,
    registry: unknown,
  ) => {
    h.revisionRegistry = registry;
    return {};
  },
}));
vi.mock('../../src/application/article-revision', () => ({
  createArticleRevisionService: () => ({
    recover: async () => true,
    isReady: () => h.revisionReady,
  }),
}));
vi.mock(
  '../../src/infrastructure/content/manual-clipboard',
  async (original) => {
    const real =
      await original<
        typeof import('../../src/infrastructure/content/manual-clipboard')
      >();
    return {
      ...real,
      createManualClipboard: (
        ...args: Parameters<typeof real.createManualClipboard>
      ) => ({
        ...real.createManualClipboard(...args),
        isReady: () => h.clipboardReady,
      }),
    };
  },
);
vi.mock('../../src/desktop/main/draft-ipc', () => ({
  registerDraftHandlers: (_w: unknown, _u: unknown, api: DraftApi) => {
    h.draftApi = api;
  },
}));
vi.mock('../../src/infrastructure/persistence/article-repository', () => ({
  openArticleRepository: () => ({
    close: h.repoClose,
    deleteArticle: h.deleteArticle,
    readDeletionResult: h.readDeletionResult,
    listCoverOperations: () => {
      if (h.coverRecoveryFails) throw Error('unknown cover storage');
      return [];
    },
    readCoverSaveResult: (operationId: string) => ({
      status: 'not_started',
      operationId,
    }),
    loadArchivedCoverVersion: () => h.coverStoredConfiguration,
    loadCover: (articleKey: string) =>
      h.coverStoredConfiguration ?? {
        articleKey,
        coverRevision: 0,
        mode: 'none',
        assets: [],
        configurationDigest: 'a'.repeat(64),
        saveOperationId: null,
        committedAt: null,
      },
    findExternalState: vi.fn(),
    findExternal: vi.fn(),
    loadEditableArticle: () => h.formalEditable,
  }),
}));
vi.mock('../../src/infrastructure/persistence/draft-task-repository', () => ({
  openDraftTaskRepository: () => {
    if (h.databaseFails) throw Error('private DB');
    return {
      close: h.taskClose,
      recover: h.recover,
      occupied: () => (h.persistedHold ? {} : undefined),
    };
  },
}));
vi.mock('../../src/infrastructure/assets/asset-store', () => ({
  createAssetStore: () => ({}),
}));
vi.mock('../../src/infrastructure/assets/runtime-health', () => ({
  verifyImageRuntime: async () => undefined,
}));
vi.mock('../../src/infrastructure/assets/manual-temp-store', () => ({
  createManualTempStore: () => ({ recover: async () => true }),
}));
vi.mock('../../src/infrastructure/assets/manual-image-source', () => ({
  createManualImageSource: () => h.imageRegistry,
}));
vi.mock('../../src/application/article-import', () => ({
  createArticleImportService: (
    _repo: unknown,
    _assets: unknown,
    _reader: unknown,
    registry: unknown,
  ) => {
    h.importerRegistry = registry;
    return { recover: async () => true };
  },
}));
vi.mock('../../src/application/article-library', () => ({
  createArticleLibrary: () => ({
    listArticles: async () => ({
      status: 'ok',
      page: {
        items: [],
        totalCount: 0,
        membershipRevision: 0,
        pageNumber: 1,
        totalPages: 1,
      },
    }),
  }),
}));
vi.mock('../../src/application/import-controller', () => ({
  createImportController: () => ({
    requestStop: () => h.runtimeStops('import'),
    isActive: () => h.importActive,
    isBlocked: () => false,
    start: h.importStart,
    stopAndWait: async () => {
      h.order.push('import-drained');
    },
  }),
}));
vi.mock('../../src/application/manual-article', () => ({
  createManualArticleController: (deps: {
    gate: () => string;
    editGate: () => string;
    flushForRestart: () => Promise<boolean>;
  }) => {
    h.manualGate = deps.gate;
    h.manualEditGate = deps.editGate;
    h.restartFlush = deps.flushForRestart;
    return {
      requestStop: () => h.runtimeStops('manual'),
      isActive: () => h.manualActive,
      isBlocked: () => h.manualBlocked || h.closeUnknown,
      canDiscardVerifiedConflict: () => false,
      getManualArticleState: () => h.closeState,
      confirmManualEditorClose: async (choice: string) => {
        h.order.push('manual-close-' + choice);
        h.manualSession = false;
        h.closeState = { state: 'idle', revision: 2 };
        return { status: 'ok' };
      },
      waitForSettlement: async () => undefined,
      hasSession: () => h.manualSession,
      stopForRestart: async () => {
        await h.manualDrain?.();
        h.order.push('manual-restart-drained');
      },
      beginManualArticle: async () => ({ status: deps.gate() }),
      stopAndWait: async () => {
        await h.manualDrain?.();
        h.order.push('manual-drained');
      },
    };
  },
}));
vi.mock('../../src/application/article-declaration', () => ({
  createArticleDeclarations: (_r: unknown, gate: () => string) => {
    h.declarationGate = gate;
    return {};
  },
}));
vi.mock('../../src/infrastructure/assets/draft-snapshot', async (original) => {
  const real =
    await original<
      typeof import('../../src/infrastructure/assets/draft-snapshot')
    >();
  return {
    createDraftSnapshotPort: (
      ...args: Parameters<typeof real.createDraftSnapshotPort>
    ) => {
      const port = real.createDraftSnapshotPort(...args);
      h.taskSnapshots = port;
      return port;
    },
  };
});
vi.mock('../../src/application/draft-preparation', () => ({
  createDraftPreparation: (deps: {
    covers: Pick<ArticleCoverRepository, 'loadCover'>;
  }) => {
    h.preparationCovers = deps.covers;
    return {};
  },
}));
vi.mock('../../src/infrastructure/automation/browser-session', () => ({
  createBrowserSession: (
    profile: string,
    options: { operationEpoch: () => number },
  ) => {
    h.browserEpoch = options.operationEpoch;
    h.profile = profile;
    h.order.push('browser-created');
    if (h.browserFails) throw Error('private browser');
    return {
      close: h.browserClose,
      open: h.open,
      isOccupied: () => h.browserOccupied,
      hasBusinessSession: () => h.businessOpen,
      invalidateHealth: h.invalidateHealth,
      checkHealth: h.healthCheck,
      openUpdate: async () => {
        h.browserOccupied = true;
        const view = {
          status: 'update_open' as const,
          version: null,
          stage: null,
          reason: null,
        };
        h.healthListener?.(view);
        return { status: 'ok' as const, view };
      },
      subscribeHealth: (fn: (v: BrowserHealthView) => void) => {
        h.healthListener = fn;
        return () => {
          h.healthListener = undefined;
        };
      },
    };
  },
}));
vi.mock('../../src/infrastructure/platforms/judongche/draft-adapter', () => ({
  createJudongcheAdapter: () => ({}),
}));
vi.mock('../../src/application/draft-controller', () => ({
  createDraftController: (deps: { gate: () => string }) => {
    h.draftGate = deps.gate;
    return {
      requestStop: () => h.runtimeStops('draft'),
      isActive: () => h.draftActive,
      isBlocked: () => h.draftBlocked || h.persistedHold,
      startDraft: h.start,
      finishHandledTask: h.finishHandled,
      prepareDraft: h.prepare,
      openDraftSession: h.open,
      stopAndWait: h.stop,
      getDraftState: async () => ({
        session: {
          status: 'closed',
          reason: null,
          storeName: null,
          bindingToken: null,
        },
        preparation: null,
        task: null,
      }),
    };
  },
}));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.assign(h, {
    healthApi: undefined,
    healthListener: undefined,
    browserOccupied: false,
    businessOpen: false,
    browserEpoch: undefined,
    batchApi: undefined,
    batchActive: false,
    batchBlocked: false,
    batchGate: undefined,
    operations: undefined,
    taskSnapshots: undefined,
    preparationCovers: undefined,
    coverStoredConfiguration: undefined,
    closeFlushDrain: undefined,
    flushPending: false,
    closeAnswer: 1,
    closeBlocked: false,
    closeUnknown: false,
    closeStale: false,
    closeStaleAfterPrompt: false,
    closeState: { state: 'idle', revision: 0 },
    formalEditable: {
      articleRevision: 2,
      article: { externalId: 'external', importId: 'import' },
    },
    primary: true,
    databaseFails: false,
    coverRecoveryFails: false,
    coverApi: undefined,
    recoverFails: false,
    browserFails: false,
    persistedHold: false,
    draftActive: false,
    draftBlocked: false,
    manualActive: false,
    manualBlocked: false,
    importActive: false,
    manualSession: false,
    revisionReady: true,
    clipboardReady: true,
    importerRegistry: undefined,
    revisionRegistry: undefined,
    order: [],
    draftApi: undefined,
    libraryApi: undefined,
    deletionApi: undefined,
    manualApi: undefined,
    draftGate: undefined,
    manualGate: undefined,
    declarationGate: undefined,
    drain: undefined,
    browserDrain: undefined,
    manualDrain: undefined,
    profile: '',
  });
  h.app = Object.assign(new EventEmitter(), {
    quit: vi.fn(),
    getPath: vi.fn(() => resolve('synthetic-user-data')),
    setPath: vi.fn(),
    getAppPath: () => resolve('.'),
    getVersion: () => '0.1.0',
    whenReady: vi.fn(async () => undefined),
    requestSingleInstanceLock: () => h.primary,
    commandLine: { getSwitchValue: () => '' },
    isPackaged: false,
  });
  h.window = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(async () => undefined),
    destroy: vi.fn(),
  });
  h.recover.mockImplementation(() => {
    h.order.push('recovered');
    if (h.recoverFails) throw Error('private recovery');
  });
  h.repoClose.mockImplementation(() => {
    h.order.push('article-close');
  });
  h.taskClose.mockImplementation(() => {
    h.order.push('task-close');
  });
  h.stop.mockImplementation(async () => {
    h.order.push('draft-stop');
    await h.drain?.();
    h.order.push('draft-drained');
  });
  h.browserClose.mockImplementation(async () => {
    h.order.push('browser-close');
    await h.browserDrain?.();
    h.order.push('browser-closed');
  });
  vi.stubGlobal('MAIN_WINDOW_WEBPACK_ENTRY', 'file:///synthetic/index.html');
  vi.stubGlobal('MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY', 'synthetic-preload');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function boot() {
  await import('../../src/desktop/main/index');
  await tick();
}
it('runtime stop is composed outside busy admission and does not shut down controllers', async () => {
  await boot();
  h.draftActive = true;
  h.manualActive = true;
  expect(h.draftGate?.()).toBe('busy');
  expect((await h.operations!.requestStopAll()).phase).toBe('stopping');
  expect(h.runtimeStops.mock.calls.map((call) => call[0]).sort()).toEqual([
    'batch',
    'draft',
    'import',
    'manual',
  ]);
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.browserClose).not.toHaveBeenCalled();
  h.draftActive = false;
  h.manualActive = false;
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'stopped',
    ),
  );
  expect(h.draftGate?.()).toBe('ready');
});
it.each(['revisionReady', 'clipboardReady'] as const)(
  'a committed cleanup/owned retirement failure closes local and platform gates: %s',
  async (key) => {
    await boot();
    expect(h.importerRegistry).toBe(h.imageRegistry);
    expect(h.revisionRegistry).toBe(h.imageRegistry);
    h[key] = false;
    expect(h.manualGate!()).toBe('unavailable');
    expect(h.declarationGate!()).toBe('unavailable');
    expect(await h.libraryApi!.startArticleImport()).toEqual({
      status: 'unavailable',
    });
    expect(h.draftGate!()).toBe('unavailable');
  },
);
it('recovers both local services before platform composition without opening the browser on boot or reload', async () => {
  await boot();
  expect(h.order.slice(0, 2)).toEqual(['recovered', 'browser-created']);
  expect(h.draftApi).toBeDefined();
  expect(h.profile).toBe(
    join(resolve('synthetic-user-data'), 'profiles', 'judongche'),
  );
  expect(h.app.setPath).not.toHaveBeenCalled();
  h.window.emit('did-finish-load');
  await h.draftApi!.getDraftState();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});
it('second instance never opens database, profile or window', async () => {
  h.primary = false;
  await boot();
  expect(h.app.whenReady).not.toHaveBeenCalled();
  expect(h.order).toEqual([]);
  expect(h.app.quit).toHaveBeenCalledOnce();
});
it.each(['databaseFails', 'recoverFails'] as const)(
  'protects local initialization and closes both acquired owners on %s',
  async (flag) => {
    h[flag] = true;
    await boot();
    expect(await h.libraryApi!.listArticles()).toEqual({
      status: 'unavailable',
    });
    expect(h.repoClose).toHaveBeenCalledOnce();
    expect(h.profile).toBe('');
    if (flag === 'recoverFails') expect(h.taskClose).toHaveBeenCalledOnce();
    expect(await h.draftApi!.openDraftSession()).toMatchObject({
      status: 'blocked',
      reason: 'STORAGE_UNAVAILABLE',
    });
  },
);
it('keeps local articles and editing available when browser initialization fails', async () => {
  h.browserFails = true;
  await boot();
  expect(await h.libraryApi!.listArticles()).toMatchObject({ status: 'ok' });
  expect(h.manualGate!()).toBe('ready');
  expect(await h.draftApi!.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'BROWSER_UNAVAILABLE',
  });
  expect(h.repoClose).not.toHaveBeenCalled();
});
it('gates local writes while draft is active and rechecks external local gates', async () => {
  await boot();
  h.draftActive = true;
  await h.libraryApi!.startArticleImport();
  expect(h.importStart).not.toHaveBeenCalled();
  expect(h.manualGate!()).toBe('busy');
  expect(h.declarationGate!()).toBe('busy');
  h.draftActive = false;
  expect(h.manualGate!()).toBe('ready');
  expect(h.declarationGate!()).toBe('ready');
  expect(h.draftGate!()).toBe('ready');
  h.importActive = true;
  expect(h.draftGate!()).toBe('busy');
  h.importActive = false;
  h.manualSession = true;
  expect(h.draftGate!()).toBe('busy');
});
it('closes admission synchronously, drains draft and local work, then browser, then both repositories once', async () => {
  await boot();
  let drain!: () => void;
  h.drain = () =>
    new Promise<void>((resolve) => {
      drain = resolve;
    });
  let manual!: () => void;
  h.manualDrain = () =>
    new Promise<void>((resolve) => {
      manual = resolve;
    });
  let browser!: () => void;
  h.browserDrain = () =>
    new Promise<void>((resolve) => {
      browser = resolve;
    });
  h.window.emit('close', { preventDefault: vi.fn() });
  h.app.emit('before-quit', { preventDefault: vi.fn() });
  const id = '00000000-0000-4000-8000-000000000001';
  expect(await h.draftApi!.prepareDraft(id, id)).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(await h.draftApi!.startDraft(id)).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(await h.draftApi!.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(h.start).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.repoClose).not.toHaveBeenCalled();
  expect(h.browserClose).not.toHaveBeenCalled();
  drain();
  await tick();
  expect(h.browserClose).not.toHaveBeenCalled();
  expect(h.repoClose).not.toHaveBeenCalled();
  manual();
  await tick();
  expect(h.browserClose).toHaveBeenCalledOnce();
  expect(h.taskClose).not.toHaveBeenCalled();
  browser();
  await tick();
  expect(h.order.indexOf('browser-close')).toBeGreaterThan(
    h.order.indexOf('draft-drained'),
  );
  expect(h.order.indexOf('browser-close')).toBeGreaterThan(
    h.order.indexOf('manual-drained'),
  );
  expect(h.order.indexOf('browser-close')).toBeGreaterThan(
    h.order.indexOf('import-drained'),
  );
  expect(h.order.indexOf('task-close')).toBeGreaterThan(
    h.order.indexOf('browser-closed'),
  );
  expect(h.repoClose).toHaveBeenCalledOnce();
  expect(h.taskClose).toHaveBeenCalledOnce();
  expect(h.stop).toHaveBeenCalledOnce();
});
it('keeps repositories open and admission closed if browser disposal fails', async () => {
  await boot();
  h.browserClose.mockRejectedValueOnce(new Error('private profile'));
  h.window.emit('close', { preventDefault: vi.fn() });
  await tick();
  expect(h.taskClose).not.toHaveBeenCalled();
  expect(h.repoClose).not.toHaveBeenCalled();
  expect(h.window.destroy).not.toHaveBeenCalled();
  expect(await h.draftApi!.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'STOP_REQUESTED',
  });
  expect(h.open).not.toHaveBeenCalled();
});

it('blocks every local writer for an idle but unresolved platform task', async () => {
  await boot();
  h.draftBlocked = true;
  expect(h.manualGate!()).toBe('busy');
  expect(h.declarationGate!()).toBe('unavailable');
  expect(await h.libraryApi!.startArticleImport()).toEqual({
    status: 'unavailable',
  });
  expect(h.importStart).not.toHaveBeenCalled();
});
it.each(['manualActive', 'manualBlocked'] as const)(
  'blocks platform start during %s even after the editor session finishes',
  async (flag) => {
    await boot();
    h[flag] = true;
    expect(h.draftGate!()).toBe(
      flag === 'manualBlocked' ? 'unavailable' : 'busy',
    );
    expect(h.declarationGate!()).toBe(
      flag === 'manualBlocked' ? 'unavailable' : 'busy',
    );
    expect(await h.libraryApi!.startArticleImport()).toEqual({
      status: 'unavailable',
    });
    expect(h.importStart).not.toHaveBeenCalled();
  },
);

it('keeps an unresolved persisted task locked even if browser initialization fails', async () => {
  h.browserFails = true;
  h.persistedHold = true;
  await boot();
  expect(h.manualGate!()).toBe('busy');
  expect(h.declarationGate!()).toBe('unavailable');
  expect(await h.libraryApi!.startArticleImport()).toEqual({
    status: 'unavailable',
  });
  expect(h.importStart).not.toHaveBeenCalled();
});
it('native known invalid settled input permits explicit discard before resource drain', async () => {
  await boot();
  h.closeBlocked = true;
  h.manualSession = true;
  h.closeState = {
    state: 'editing',
    sessionId: 'session',
    documentRevision: 4,
    dirty: false,
    target: { kind: 'new' },
  };
  const preventDefault = vi.fn();
  h.window.emit('close', { preventDefault });
  await tick();
  await tick();
  expect(h.order).toContain('manual-close-discard');
  expect(h.order.indexOf('manual-close-discard')).toBeLessThan(
    h.order.indexOf('manual-drained'),
  );
  expect(h.window.destroy).toHaveBeenCalledOnce();
});
it.each([
  'closeUnknown',
  'closeStale',
  'closeStaleAfterPrompt',
  'manualActive',
  'draftActive',
  'importActive',
  'revisionReady',
  'clipboardReady',
  'persistedHold',
] as const)('native invalid discard remains blocked by %s', async (key) => {
  await boot();
  h.closeBlocked = true;
  h.manualSession = true;
  h.closeState = {
    state: 'editing',
    sessionId: 'session',
    documentRevision: 4,
    dirty: false,
    target: { kind: 'new' },
  };
  h[key] = key === 'revisionReady' || key === 'clipboardReady' ? false : true;
  h.window.emit('close', { preventDefault: vi.fn() });
  await tick();
  await tick();
  expect(h.order).not.toContain('manual-close-discard');
  expect(h.window.destroy).not.toHaveBeenCalled();
  expect(h.repoClose).not.toHaveBeenCalled();
});
it('native settled invalid input in an existing article closes only at its actual formal revision', async () => {
  await boot();
  h.closeBlocked = true;
  h.manualSession = true;
  h.closeState = {
    state: 'editing',
    sessionId: 'session',
    documentRevision: 4,
    dirty: false,
    target: {
      kind: 'existing',
      articleKey: 'article',
      externalId: 'external',
      importId: 'import',
      baseArticleRevision: 2,
    },
  };
  h.window.emit('close', { preventDefault: vi.fn() });
  await tick();
  await tick();
  expect(h.order).toContain('manual-close-discard');
  expect(h.window.destroy).toHaveBeenCalledOnce();
});
it('native invalid local discard refuses a changed formal article revision', async () => {
  await boot();
  h.closeBlocked = true;
  h.manualSession = true;
  h.closeState = {
    state: 'editing',
    sessionId: 'session',
    documentRevision: 4,
    dirty: false,
    target: {
      kind: 'existing',
      articleKey: 'article',
      externalId: 'external',
      importId: 'import',
      baseArticleRevision: 2,
    },
  };
  h.formalEditable.articleRevision = 3;
  h.window.emit('close', { preventDefault: vi.fn() });
  await tick();
  await tick();
  expect(h.order).not.toContain('manual-close-discard');
  expect(h.window.destroy).not.toHaveBeenCalled();
});

it.each([
  'manualSession',
  'manualActive',
  'manualBlocked',
  'draftActive',
  'draftBlocked',
  'importActive',
  'revisionReady',
  'clipboardReady',
] as const)(
  'main deletion uses the trusted common write gate: %s',
  async (flag) => {
    await boot();
    h[flag] = flag !== 'revisionReady' && flag !== 'clipboardReady';
    const operationId = '00000000-0000-4000-8000-000000000001';
    const command = {
      operationId,
      articleKey: '00000000-0000-4000-8000-000000000002',
      expectedArticleRevision: 1,
    };
    expect(await h.deletionApi!.deleteArticle(command)).toEqual({
      status: [
        'manualSession',
        'manualActive',
        'draftActive',
        'importActive',
      ].includes(flag)
        ? 'blocked'
        : 'unavailable',
      operationId,
    });
    expect(h.deleteArticle).not.toHaveBeenCalled();
    expect(await h.deletionApi!.getArticleDeletionResult(operationId)).toEqual({
      status: 'not_started',
      operationId,
    });
    expect(h.readDeletionResult).toHaveBeenCalledWith(operationId);
  },
);
it('main deletion rejects a persisted platform hold even if browser initialization fails', async () => {
  h.browserFails = true;
  h.persistedHold = true;
  await boot();
  const operationId = '00000000-0000-4000-8000-000000000001';
  expect(
    await h.deletionApi!.deleteArticle({
      operationId,
      articleKey: '00000000-0000-4000-8000-000000000002',
      expectedArticleRevision: 1,
    }),
  ).toEqual({ status: 'unavailable', operationId });
  expect(h.deleteArticle).not.toHaveBeenCalled();
});

it('cover recovery read uncertainty closes all normal writers before browser construction', async () => {
  h.coverRecoveryFails = true;
  await boot();
  expect(await h.libraryApi!.listArticles()).toEqual({ status: 'unavailable' });
  expect(await h.libraryApi!.startArticleImport()).toEqual({
    status: 'unavailable',
  });
  expect(h.order).not.toContain('browser-created');
  expect(h.taskClose).toHaveBeenCalledOnce();
  expect(h.repoClose).toHaveBeenCalledOnce();
});

it('cover admission preserves an open/unsaved body session and all existing stop/status/closure methods', async () => {
  await boot();
  h.manualSession = true;
  expect(
    await h.coverApi!.beginCoverEdit('00000000-0000-4000-8000-000000000001'),
  ).toMatchObject({ notice: 'busy' });
  expect(h.manualSession).toBe(true);
  expect(h.coverApi!.getCoverEditState).toBeTypeOf('function');
  expect(h.draftApi!.stopDraft).toBeTypeOf('function');
  expect(h.draftApi!.reconcileDraft).toBeTypeOf('function');
  expect(h.draftApi!.getDraftState).toBeTypeOf('function');
  expect(h.draftApi!.confirmTaskClosure).toBeTypeOf('function');
});

it('actual cover open holds manual/import/declaration/delete/draft admission while stop/reconciliation remain reachable', async () => {
  await boot();
  const key = '00000000-0000-4000-8000-000000000001';
  const state = await h.coverApi!.beginCoverEdit(key);
  expect(state.status).toBe('open');
  expect(h.manualGate!()).toBe('busy');
  expect(h.draftGate!()).toBe('busy');
  expect(h.declarationGate!()).toBe('busy');
  expect(await h.libraryApi!.startArticleImport()).toEqual({
    status: 'unavailable',
  });
  expect(
    await h.deletionApi!.deleteArticle({
      articleKey: key,
      expectedArticleRevision: 2,
      operationId: '00000000-0000-4000-8000-000000000002',
    }),
  ).toMatchObject({ status: 'blocked' });
  expect(h.deleteArticle).not.toHaveBeenCalled();
  if (!('sessionId' in state)) throw Error('no session');
  await h.coverApi!.closeCoverEdit(state.sessionId);
  expect(h.manualGate!()).toBe('ready');
  expect(h.draftGate!()).toBe('ready');
});

it('native close confirmation preserves dirty cover on continue/invalid save and discards only explicitly', async () => {
  await boot();
  const s = await h.coverApi!.beginCoverEdit(
    '00000000-0000-4000-8000-000000000001',
  );
  if (!('sessionId' in s)) throw Error('no session');
  const dirty = await h.coverApi!.setCoverDraft(
    { sessionId: s.sessionId, expectedDraftRevision: s.draftRevision },
    { mode: 'single', imageTokens: [] },
  );
  expect(dirty).toMatchObject({ dirty: true });
  h.closeAnswer = 0;
  h.window.emit('close', { preventDefault() {} });
  await tick();
  expect(await h.coverApi!.getCoverEditState()).toEqual(dirty);
  expect(h.repoClose).not.toHaveBeenCalled();
  h.closeAnswer = 1;
  h.window.emit('close', { preventDefault() {} });
  await tick();
  expect(await h.coverApi!.getCoverEditState()).toEqual(dirty);
  expect(h.repoClose).not.toHaveBeenCalled();
  h.closeAnswer = 2;
  h.window.emit('close', { preventDefault() {} });
  await tick();
  expect(h.repoClose).toHaveBeenCalledTimes(1);
  expect(h.window.destroy).toHaveBeenCalledTimes(1);
});

it('main shutdown rejects stored preview after cover drain while browser continuation holds storage open', async () => {
  await boot();
  const key = '00000000-0000-4000-8000-000000000001',
    operation = '00000000-0000-4000-8000-000000000002',
    asset = '00000000-0000-4000-8000-000000000003';
  h.coverStoredConfiguration = {
    articleKey: key,
    coverRevision: 1,
    mode: 'single',
    assets: [
      {
        assetKey: asset,
        mime: 'image/png',
        width: 1,
        height: 1,
        byteSize: 1,
        sha256: 'b'.repeat(64),
        relativePath: key + '/' + operation + '/' + asset + '.png',
      },
    ],
    configurationDigest: 'a'.repeat(64),
    saveOperationId: operation,
    committedAt: '2026-10-09T00:00:00.000Z',
  };
  let releaseRead!: () => void,
    releaseBrowser!: () => void,
    releaseFlush!: () => void;
  const readPending = new Promise<void>((resolve) => {
      releaseRead = resolve;
    }),
    browserPending = new Promise<void>((resolve) => {
      releaseBrowser = resolve;
    });
  h.coverRead.mockImplementation(async () => {
    await readPending;
    return new Uint8Array([1]);
  });
  h.browserDrain = () => browserPending;
  const flushPending = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  h.closeFlushDrain = () => flushPending;
  const request = {
    kind: 'stored' as const,
    articleKey: key,
    coverRevision: 1,
    assetKey: asset,
  };
  const admitted = h.coverApi!.getCoverImage(request);
  expect(h.coverRead).toHaveBeenCalledTimes(1);
  try {
    h.window.emit('close', { preventDefault() {} });
    await tick();
    expect(h.repoClose).not.toHaveBeenCalled();
    expect(h.browserClose).not.toHaveBeenCalled();
    expect(await h.coverApi!.getCoverImage(request)).toEqual({
      status: 'unavailable',
    });
    expect(h.coverRead).toHaveBeenCalledTimes(1);
    releaseFlush();
    await tick();
    expect(h.repoClose).not.toHaveBeenCalled();
    releaseRead();
    expect(await admitted).toMatchObject({ status: 'ok' });
    await tick();
    expect(h.browserClose).toHaveBeenCalledTimes(1);
    expect(h.repoClose).not.toHaveBeenCalled();
    expect(await h.coverApi!.getCoverImage(request)).toEqual({
      status: 'unavailable',
    });
    expect(h.coverRead).toHaveBeenCalledTimes(1);
    expect(await h.coverApi!.getCoverSaveResult(operation)).toMatchObject({
      status: 'not_started',
      operationId: operation,
    });
    expect(await h.coverApi!.getCoverEditState()).toMatchObject({
      status: 'unavailable',
    });
  } finally {
    releaseFlush();
    releaseRead();
    releaseBrowser();
    await admitted;
    await tick();
  }
  expect(h.repoClose).toHaveBeenCalledTimes(1);
  expect(h.order.indexOf('browser-close')).toBeLessThan(
    h.order.indexOf('article-close'),
  );
});

it('main composes required metadata and independent task cover reader from its managed cover store', async () => {
  await boot();
  const articleKey = '11111111-1111-4111-8111-111111111111';
  const assetKey = '22222222-2222-4222-8222-222222222222';
  const operationId = '33333333-3333-4333-8333-333333333333';
  const assets = [
    {
      assetKey,
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      byteSize: 1,
      sha256: 'b'.repeat(64),
      relativePath: articleKey + '/' + operationId + '/' + assetKey + '.png',
    },
  ];
  h.coverStoredConfiguration = {
    articleKey,
    coverRevision: 1,
    mode: 'single',
    assets,
    configurationDigest: coverConfigurationDigest(
      articleKey,
      1,
      'single',
      assets,
    ),
    saveOperationId: operationId,
    committedAt: '2026-10-09T00:00:00.000Z',
  };
  const configuration = h.preparationCovers!.loadCover(articleKey)!;
  const captured = h.taskSnapshots!.captureCover(configuration);
  expect(captured).toMatchObject({
    articleKey,
    coverRevision: 1,
    mode: 'single',
  });
  expect(await h.taskSnapshots!.readCoverImage(captured, assetKey)).toEqual(
    new Uint8Array([1]),
  );
  expect(h.coverRead).toHaveBeenCalledTimes(1);
});

vi.mock('../../src/desktop/main/batch-ipc', () => ({
  registerBatchHandlers: (_w: unknown, _u: unknown, api: BatchApi) => {
    h.batchApi = api;
  },
}));
vi.mock('../../src/infrastructure/persistence/draft-batch-repository', () => ({
  openDraftBatchRepository: () => ({
    getCurrent: () => null,
    recover: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../../src/application/batch-controller', () => ({
  createBatchController: (deps: { gate(): string }) => {
    h.batchGate = deps.gate;
    return {
      skipCurrentAndContinue: h.skipRecovery,
      isActive: () => h.batchActive,
      isBlocked: () => h.batchBlocked,
      requestStop: () => h.runtimeStops('batch'),
      stopAndWait: async () => undefined,
      stopForRestart: async () => {
        await tick();
        h.draftBlocked = false;
        h.batchBlocked = false;
      },
      getCurrent: async () => null,
    };
  },
}));
it('batch preparation and durable holds block competitors without blocking internal draft execution', async () => {
  await boot();
  expect(h.batchApi).toBeDefined();
  for (const key of ['batchActive', 'batchBlocked'] as const) {
    h[key] = true;
    expect(h.manualGate!()).toBe('busy');
    expect(h.declarationGate!()).toBe('unavailable');
    expect(await h.libraryApi!.startArticleImport()).toEqual({
      status: 'unavailable',
    });
    expect((await h.draftApi!.startDraft('id')).status).toBe('blocked');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.draftGate!()).toBe('ready');
    expect(h.batchGate!()).toBe('ready');
    h[key] = false;
  }
});

it('global stop invokes local restart settlement and retains an unreleased session as review', async () => {
  await boot();
  h.manualSession = true;
  await h.operations!.requestStopAll();
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'needs_review',
    ),
  );
  expect(h.order).toContain('manual-restart-drained');
  expect(h.manualGate!()).toBe('ready');
  expect(h.draftGate!()).toBe('busy');
});
it('global stop releases an actually clean cover session before reopening platform admission', async () => {
  await boot();
  await h.coverApi!.beginCoverEdit('00000000-0000-4000-8000-000000000001');
  await h.operations!.requestStopAll();
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'stopped',
    ),
  );
  expect(await h.coverApi!.getCoverEditState()).toMatchObject({
    status: 'idle',
  });
  expect(h.draftGate!()).toBe('ready');
});

it('a failed restart settlement with no session cannot make platform admission ready', async () => {
  await boot();
  h.manualDrain = async () => {
    throw Error('release unknown');
  };
  await h.operations!.requestStopAll();
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'needs_review',
    ),
  );
  expect(h.manualGate!()).toBe('ready');
  expect(h.draftGate!()).toBe('busy');
  h.manualDrain = undefined;
  await h.operations!.requestStopAll();
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'stopped',
    ),
  );
  expect(h.draftGate!()).toBe('ready');
});

it('restart flush only opens the pending text-edit lane while all normal writes remain closed', async () => {
  await boot();
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  h.manualDrain = () => pending;
  h.closeFlushDrain = () => pending;
  h.closeBlocked = true; // Renderer ready latch; this response proves only blocked input.
  await h.operations!.requestStopAll();
  expect(h.manualGate!()).toBe('busy');
  expect(h.manualEditGate!()).toBe('busy');
  const flushing = h.restartFlush!();
  expect(h.manualEditGate!()).toBe('ready');
  expect(h.manualGate!()).toBe('busy');
  expect(h.draftGate!()).toBe('busy');
  release();
  expect(await flushing).toBe(false);
  await vi.waitFor(async () =>
    expect((await h.operations!.getOperationControlState()).phase).toBe(
      'stopped',
    ),
  );
});

it('maintenance_remains_exclusive_after_open_promise_resolves across all browser entry points', async () => {
  await boot();
  expect((await h.healthApi!.openBrowserUpdate()).status).toBe('ok');
  expect(h.draftGate!()).toBe('busy');
  expect(h.batchGate!()).toBe('busy');
  for (const call of [
    () => h.draftApi!.openDraftSession(),
    () => h.draftApi!.startDraft('id'),
    () => h.draftApi!.prepareDraft('id', 'id'),
  ])
    expect(await call()).toMatchObject({
      status: 'blocked',
      reason: 'PLATFORM_BUSY',
    });
  expect(await h.batchApi!.prepare({} as never)).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  expect(await h.batchApi!.start({} as never)).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
  expect((await h.healthApi!.checkBrowserHealth()).view.reason).toBe(
    'maintenance_open',
  );
  h.healthListener?.({
    status: 'check_failed',
    reason: 'cleanup_failed',
    stage: 'cleanup',
    version: null,
  });
  expect(h.draftGate!()).toBe('busy');
  expect((await h.draftApi!.getDraftState()).session.status).toBe('closed');
  h.browserOccupied = false;
  h.healthListener?.({
    status: 'unchecked',
    reason: null,
    stage: null,
    version: null,
  });
  expect(h.draftGate!()).toBe('ready');
});
it.each([
  'draftActive',
  'draftBlocked',
  'batchActive',
  'batchBlocked',
  'persistedHold',
  'businessOpen',
  'revisionReady',
  'clipboardReady',
] as const)(
  'health commands never drain or mutate tasks during %s',
  async (flag) => {
    await boot();
    h[flag] = !['revisionReady', 'clipboardReady'].includes(flag);
    for (const call of [
      () => h.healthApi!.checkBrowserHealth(),
      () => h.healthApi!.openBrowserUpdate(),
    ])
      expect(await call()).toMatchObject({
        status: 'blocked',
        view: {
          reason: flag === 'businessOpen' ? 'business_open' : 'task_busy',
        },
      });
    expect(h.healthCheck).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.runtimeStops).not.toHaveBeenCalled();
  },
);
it('health_pass_is_not_platform_ready and invalidation advances the runtime epoch', async () => {
  await boot();
  expect(h.browserEpoch!()).toBe(0);
  expect((await h.healthApi!.checkBrowserHealth()).view.status).toBe('passed');
  expect(h.browserEpoch!()).toBe(1);
  expect(h.invalidateHealth).toHaveBeenCalledOnce();
  expect(await h.draftApi!.getDraftState()).toMatchObject({
    session: { status: 'closed', bindingToken: null },
    preparation: null,
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

it('routes bound batch recovery while preserving other batch and maintenance admission', async () => {
  await boot();
  h.batchBlocked = true;
  const input = {
    batchId: '11111111-1111-4111-8111-111111111111',
    expectedRevision: 3,
    taskId: '22222222-2222-4222-8222-222222222222',
  };
  expect((await h.batchApi!.skipCurrentAndContinue(input)).status).toBe('ok');
  expect(h.skipRecovery).toHaveBeenCalledWith(input);
  expect(await h.draftApi!.openDraftSession()).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  expect(
    await h.draftApi!.finishHandledTask({
      taskId: input.taskId,
      expectedRevision: 1,
    }),
  ).toMatchObject({ status: 'blocked', reason: 'PLATFORM_BUSY' });
  expect(h.finishHandled).not.toHaveBeenCalled();
  h.browserOccupied = true;
  const calls = h.skipRecovery.mock.calls.length;
  expect(await h.batchApi!.skipCurrentAndContinue(input)).toMatchObject({
    status: 'blocked',
    reason: 'PLATFORM_BUSY',
  });
  expect(h.skipRecovery).toHaveBeenCalledTimes(calls);
  h.browserOccupied = false;
  h.batchBlocked = false;
  expect(
    (
      await h.draftApi!.finishHandledTask({
        taskId: input.taskId,
        expectedRevision: 1,
      })
    ).status,
  ).toBe('ok');
  expect(h.finishHandled).toHaveBeenCalledOnce();
});

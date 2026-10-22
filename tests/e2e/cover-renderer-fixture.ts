import type { Page } from '@playwright/test';
export async function installCoverBridge(
  page: Page,
  options: { unknownSave?: boolean; blocked?: boolean } = {},
) {
  await page.addInitScript(({ unknownSave, blocked }) => {
    const stored = new Map<
      string,
      {
        articleKey: string;
        coverRevision: number;
        mode: 'none' | 'single' | 'triple';
        images: {
          assetKey: string;
          mime: 'image/png' | 'image/jpeg';
          width: number;
          height: number;
        }[];
      }
    >();
    let state: import('../../src/contracts/article-cover').CoverEditReply = {
      status: 'idle',
      notice: null,
    };
    let baselineDraft = '';
    const receipts = new Map<
      string,
      import('../../src/contracts/article-cover').CoverSaveResult
    >();
    const log: Array<[string, ...unknown[]]> = [];
    let failPick = false,
      cancelPick = false,
      hold = false,
      active = 0,
      max = 0;
    const blobs = new Set<string>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob) => {
      const u = create(b);
      blobs.add(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => {
      blobs.delete(u);
      revoke(u);
    };
    const view = (key: string) =>
      stored.get(key) ?? {
        articleKey: key,
        coverRevision: 0,
        mode: 'none' as const,
        images: [],
      };
    const reply = () => structuredClone(state);
    Object.assign(window, {
      coverFixture: {
        log: () => log,
        state: () => reply(),
        blobs: () => blobs.size,
        max: () => max,
        failPick: () => {
          failPick = true;
        },
        cancelPick: () => {
          cancelPick = true;
        },
        holdImage: () => {
          hold = true;
        },
        configure: (
          key: string,
          mode: 'none' | 'single' | 'triple',
          count: number,
        ) => {
          stored.set(key, {
            articleKey: key,
            coverRevision: 1,
            mode,
            images: Array.from({ length: count }, () => ({
              assetKey: crypto.randomUUID(),
              mime: 'image/png',
              width: 1,
              height: 1,
            })),
          });
        },
        resolveSave: () => {
          for (const [id, r] of receipts)
            if (r.status === 'needs_review' && 'sessionId' in state) {
              const cfg = {
                articleKey: state.articleKey,
                coverRevision: state.baseCoverRevision + 1,
                mode: state.draft.mode,
                images: state.images.map((i) => ({
                  assetKey: i.imageToken,
                  mime: i.mime,
                  width: i.width,
                  height: i.height,
                })),
              };
              baselineDraft = JSON.stringify(state.draft);
              stored.set(state.articleKey, cfg);
              receipts.set(id, {
                status: 'committed',
                receipt: {
                  operationId: id,
                  articleKey: state.articleKey,
                  coverRevision: cfg.coverRevision,
                  configurationDigest: 'a'.repeat(64),
                },
              });
              state = {
                ...state,
                imageFailure: undefined,
                dirty: false,
                baseCoverRevision: cfg.coverRevision,
                notice: 'saved',
              };
            }
        },
      },
    });
    Object.assign(window.desktopApi, {
      batch: {
        getCurrent: async () => null,
        prepare: async () => ({
          status: 'blocked',
          reason: 'INPUT_UNSUPPORTED',
        }),
        start: async () => ({
          status: 'blocked',
          reason: 'INPUT_UNSUPPORTED',
          view: null,
        }),
        stop: async () => ({ status: 'ok', view: null }),
        finish: async () => ({ status: 'ok', view: null }),
      },
      getArticleCover: async (key: string) => ({
        status: 'ok',
        configuration: structuredClone(view(key)),
      }),
      getCoverEditState: async () => reply(),
      beginCoverEdit: async (key: string) => {
        log.push(['begin', key]);
        if (blocked) return { status: 'idle', notice: 'blocked' };
        const body = Reflect.get(window, 'workspaceState')?.();
        if (body?.state === 'editing') throw Error('body not settled');
        const c = view(key);
        const tokens = c.images.map(() => crypto.randomUUID());
        state = {
          status: 'open',
          sessionId: crypto.randomUUID(),
          articleKey: key,
          baseArticleRevision: 1,
          baseCoverRevision: c.coverRevision,
          draftRevision: 0,
          draft: { mode: c.mode, imageTokens: tokens },
          images: tokens.map((t) => ({
            imageToken: t,
            mime: 'image/png',
            width: 1,
            height: 1,
          })),
          dirty: false,
          notice: null,
        };
        baselineDraft = JSON.stringify(state.draft);
        return reply();
      },
      setCoverDraft: async (
        command: import('../../src/contracts/article-cover').CoverEditCommand,
        draft: import('../../src/contracts/article-cover').CoverDraft,
      ) => {
        if (
          !('sessionId' in state) ||
          state.sessionId !== command.sessionId ||
          state.draftRevision !== command.expectedDraftRevision
        )
          throw Error('stale');
        log.push(['draft', structuredClone(draft)]);
        const previousImages = state.images;
        state = {
          ...state,
          imageFailure: undefined,
          draft: structuredClone(draft),
          draftRevision: state.draftRevision + 1,
          dirty:
            state.baseCoverRevision === 0 ||
            JSON.stringify(draft) !== baselineDraft,
          images: draft.imageTokens.map((token) =>
            previousImages.find((i) => i.imageToken === token)!,
          ),
          notice: null,
        };
        return reply();
      },
      pickCoverImages: async (
        command: import('../../src/contracts/article-cover').CoverEditCommand,
        slots: number[],
      ) => {
        log.push(['pick', slots]);
        if (
          !('sessionId' in state) ||
          state.sessionId !== command.sessionId ||
          state.draftRevision !== command.expectedDraftRevision
        )
          throw Error('stale');
        if (cancelPick) {
          cancelPick = false;
          state = { ...state, notice: 'cancelled', imageFailure: undefined };
          return reply();
        }
        if (failPick) {
          failPick = false;
          state = {
            ...state,
            notice: 'image_invalid',
            imageFailure: { position: slots[0], reason: 'IMAGE_INVALID' },
          };
          return reply();
        }
        const tokens = [...state.draft.imageTokens];
        for (const i of slots) tokens[i] = crypto.randomUUID();
        state = {
          ...state,
          imageFailure: undefined,
          draft: { ...state.draft, imageTokens: tokens },
          draftRevision: state.draftRevision + 1,
          dirty: true,
          notice: null,
          images: tokens.map((t) => ({
            imageToken: t,
            mime: 'image/png',
            width: 1,
            height: 1,
          })),
        };
        return reply();
      },
      copyCoverImage: async (
        command: import('../../src/contracts/article-cover').CoverEditCommand,
        source: Extract<
          import('../../src/contracts/article-cover').CoverImageRequest,
          { kind: 'stored' }
        >,
      ) => {
        log.push(['copy', structuredClone(source)]);
        if (
          !('sessionId' in state) ||
          state.sessionId !== command.sessionId ||
          state.draftRevision !== command.expectedDraftRevision ||
          view(source.articleKey).coverRevision !== source.coverRevision
        )
          throw Error('Stale source');
        const token = crypto.randomUUID();
        state = {
          ...state,
          draft: { mode: 'single', imageTokens: [token] },
          draftRevision: state.draftRevision + 1,
          images: [
            { imageToken: token, mime: 'image/png', width: 1, height: 1 },
          ],
          dirty: true,
          notice: null,
        };
        return reply();
      },
      getCoverImage: async (
        request: import('../../src/contracts/article-cover').CoverImageRequest,
      ) => {
        active++;
        max = Math.max(max, active);
        log.push(['image', request]);
        try {
          if (hold) {
            hold = false;
            await new Promise<void>((r) =>
              Object.assign(window, { releaseCoverImage: r }),
            );
          }
          return {
            status: 'ok',
            mime: 'image/png',
            bytes: Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zJkAAAAASUVORK5CYII=',
              ),
              (c) => c.charCodeAt(0),
            ),
          };
        } finally {
          active--;
        }
      },
      saveCoverEdit: async (
        command: import('../../src/contracts/article-cover').CoverSaveCommand,
      ) => {
        log.push(['save', command]);
        if (!('sessionId' in state)) throw Error('no session');
        if (unknownSave) {
          receipts.set(command.operationId, {
            status: 'needs_review',
            operationId: command.operationId,
          });
          throw Error('lost acknowledgment');
        }
        const cfg = {
          articleKey: state.articleKey,
          coverRevision: state.baseCoverRevision + 1,
          mode: state.draft.mode,
          images: state.images.map((i) => ({
            assetKey: i.imageToken,
            mime: i.mime,
            width: i.width,
            height: i.height,
          })),
        };
        stored.set(cfg.articleKey, cfg);
        const result = {
          status: 'committed' as const,
          receipt: {
            operationId: command.operationId,
            articleKey: cfg.articleKey,
            coverRevision: cfg.coverRevision,
            configurationDigest: 'a'.repeat(64),
          },
        };
        baselineDraft = JSON.stringify(state.draft);
        receipts.set(command.operationId, result);
        state = {
          ...state,
          imageFailure: undefined,
          dirty: false,
          baseCoverRevision: cfg.coverRevision,
          notice: 'saved',
        };
        return result;
      },
      getCoverSaveResult: async (id: string) => {
        log.push(['receipt', id]);
        return receipts.get(id) ?? { status: 'not_started', operationId: id };
      },
      closeCoverEdit: async (id: string) => {
        log.push(['close', id]);
        if ([...receipts.values()].some((r) => r.status === 'needs_review'))
          return reply();
        state = { status: 'idle', notice: null };
        return reply();
      },
    });
  }, options);
}

import { CoverPickFailure } from '../domain/cover-pick-error';
import { StorageIdSchema } from '../contracts/stored-article';
import {
  CoverDraftSchema,
  CoverEditCommandSchema,
  CoverSaveCommandSchema,
  CoverSlotsSchema,
  CoverImageRequestSchema,
  CoverImageDescriptionSchema,
  COVER_IMAGE_MAX_BYTES,
  type ArticleCoverApi,
  type CoverDraft,
  type CoverEditReply,
  type CoverSaveIntent,
  type CoverSaveCommand,
  type CoverSaveResult,
  type CoverImageRequest,
  type CoverImageResult,
  type StoredCoverConfiguration,
  CoverSaveResultSchema,
  type CoverNoticeSchema,
  type CoverImageFailure,
} from '../contracts/article-cover';
import type {
  ArticleCoverRepository,
  CoverAssetStore,
  CoverFilePicker,
  PickedCoverImage,
} from '../domain/ports/article-cover';
import type { ArticleRevisionRepository } from '../domain/ports/article-revision';
import { createCoverRecovery } from './cover-recovery';
import { ImportFailure } from '../domain/import-error';
interface Ports {
  repository: ArticleCoverRepository &
    Pick<ArticleRevisionRepository, 'loadEditableArticle'>;
  assets: CoverAssetStore;
  picker: CoverFilePicker;
  gate(): 'ready' | 'busy' | 'unavailable';
  newId(): string;
  now(): string;
  digest(value: unknown): string;
}
type Notice = (typeof CoverNoticeSchema)['_output'];
type Candidate = {
  source:
    | {
        kind: 'stored';
        configuration: StoredCoverConfiguration;
        assetKey: string;
      }
    | { kind: 'picked'; image: PickedCoverImage };
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  sha256: string;
  byteSize: number;
};
type Session = {
  sessionId: string;
  articleKey: string;
  baseArticleRevision: number;
  baseCoverRevision: number;
  draftRevision: number;
  draft: CoverDraft;
  dirty: boolean;
  images: Map<string, Candidate>;
  status: 'open' | 'selecting' | 'saving' | 'closing';
  notice: Notice;
  imageFailure?: CoverImageFailure;
  initial: string;
  unknownOperation?: string;
};
export function createArticleCoverController(ports: Ports): ArticleCoverApi & {
  hasSession(): boolean;
  isActive(): boolean;
  isBlocked(): boolean;
  requestStop(): void;
  stopAndWait(): Promise<void>;
  stopForRestart(): Promise<void>;
  waitForSettlement(): Promise<void>;
  recover(): Promise<boolean>;
} {
  const recovery = createCoverRecovery(ports.repository, ports.assets);
  let ready = false,
    blocked = false,
    storageUncertain = false,
    stopped = false,
    session: Session | undefined,
    work: Promise<unknown> | undefined,
    abort: AbortController | undefined,
    transfer: Promise<CoverImageResult> | undefined;
  let restartSettlement: Promise<void> | undefined;
  const attempts = new Map<
    string,
    {
      intent: CoverSaveIntent;
      fingerprint: string;
      commandRevision: number;
      settledCoverRevision?: number;
    }
  >();
  const fingerprint = (s: Session) =>
    ports.digest({
      mode: s.draft.mode,
      images: s.draft.imageTokens.map((t) => {
        const i = s.images.get(t)!;
        return {
          sha256: i.sha256,
          mime: i.mime,
          width: i.width,
          height: i.height,
          byteSize: i.byteSize,
        };
      }),
    });
  function snapshot(notice?: Notice): CoverEditReply {
    const s = session;
    if (!s)
      return {
        status: ready && !blocked && !stopped ? 'idle' : 'unavailable',
        notice: notice ?? (blocked ? 'needs_review' : null),
      };
    return {
      status: s.status,
      sessionId: s.sessionId,
      articleKey: s.articleKey,
      baseArticleRevision: s.baseArticleRevision,
      baseCoverRevision: s.baseCoverRevision,
      draftRevision: s.draftRevision,
      draft: { ...s.draft, imageTokens: [...s.draft.imageTokens] },
      dirty: s.dirty,
      images: s.draft.imageTokens.map((t) => {
        const i = s.images.get(t)!;
        return {
          imageToken: t,
          mime: i.mime,
          width: i.width,
          height: i.height,
        };
      }),
      notice: notice ?? s.notice,
      ...((notice ?? s.notice) === 'image_invalid' && s.imageFailure
        ? { imageFailure: { ...s.imageFailure } }
        : {}),
    };
  }
  function gate() {
    try {
      return ready && !blocked && !stopped && !restartSettlement
        ? ports.gate()
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
  function matching(command: unknown): Session | undefined {
    const p = CoverEditCommandSchema.safeParse(command);
    const s = session;
    return p.success &&
      s &&
      p.data.sessionId === s.sessionId &&
      p.data.expectedDraftRevision === s.draftRevision
      ? s
      : undefined;
  }
  function mutated(s: Session) {
    s.draftRevision++;
    // The implicit revision-zero default is not a formal configuration: an accepted edit is an unsaved intent even when it chooses none.
    s.dirty = s.baseCoverRevision === 0 || fingerprint(s) !== s.initial;
    s.notice = null;
    s.imageFailure = undefined;
    for (const t of s.images.keys())
      if (!s.draft.imageTokens.includes(t)) s.images.delete(t);
  }
  function validBase(s: Session) {
    try {
      const article = ports.repository.loadEditableArticle(s.articleKey),
        config = ports.repository.loadCover(s.articleKey);
      return (
        !!article &&
        !!config &&
        article.articleRevision === s.baseArticleRevision &&
        config.coverRevision === s.baseCoverRevision
      );
    } catch {
      storageUncertain = true;
      blocked = true;
      throw Error('Storage unknown');
    }
  }
  const result = (
    status: Exclude<CoverSaveResult['status'], 'committed'>,
    operationId: string,
  ): CoverSaveResult => ({ status, operationId });
  async function readCandidate(i: Candidate) {
    return i.source.kind === 'picked'
      ? new Uint8Array(i.source.image.bytes)
      : ports.assets.readCoverAsset(i.source.configuration, i.source.assetKey);
  }
  async function settleKnown(s: Session, r: CoverSaveResult) {
    if (r.status === 'committed') {
      const intent = attempts.get(r.receipt.operationId)?.intent;
      if (
        !intent ||
        intent.sessionId !== s.sessionId ||
        intent.articleKey !== s.articleKey ||
        r.receipt.coverRevision !== intent.expectedCoverRevision + 1
      )
        throw Error('Cover receipt identity mismatch');
      const config = ports.repository.loadCover(s.articleKey);
      if (
        r.receipt.articleKey !== s.articleKey ||
        !config ||
        config.saveOperationId !== r.receipt.operationId ||
        config.mode !== intent.mode ||
        config.coverRevision !== r.receipt.coverRevision ||
        config.configurationDigest !== r.receipt.configurationDigest
      )
        throw Error('Cover receipt mismatch');
      s.baseCoverRevision = r.receipt.coverRevision;
      attempts.get(r.receipt.operationId)!.settledCoverRevision =
        r.receipt.coverRevision;
      s.initial = fingerprint(s);
      s.dirty = false;
      s.notice = 'saved';
      s.imageFailure = undefined;
      s.unknownOperation = undefined;
      blocked = false;
      storageUncertain = false;
    } else if (r.status === 'failed') {
      const intent = attempts.get(r.operationId)?.intent;
      const op = ports.repository.readCoverOperation(r.operationId);
      if (
        storageUncertain ||
        !intent ||
        !op ||
        s.unknownOperation !== r.operationId ||
        s.sessionId !== intent.sessionId ||
        s.articleKey !== intent.articleKey ||
        s.baseArticleRevision !== intent.expectedArticleRevision ||
        s.baseCoverRevision !== intent.expectedCoverRevision ||
        s.draftRevision !== intent.draftRevision ||
        attempts.get(r.operationId)!.fingerprint !== fingerprint(s) ||
        op.status !== 'failed' ||
        !op.cleanupComplete ||
        op.committedCoverRevision !== null ||
        Object.keys(intent).some(
          (k) =>
            op[k as keyof CoverSaveIntent] !==
            intent[k as keyof CoverSaveIntent],
        ) ||
        !validBase(s)
      )
        throw Error('Failed cover operation is not safely bound');
      // A transient external write gate keeps this same proven operation held;
      // it is not evidence of a storage failure and may be checked again later.
      try {
        if (ports.gate() !== 'ready') return;
      } catch {
        return;
      }
      s.unknownOperation = undefined;
      s.notice = null;
      blocked = false;
    }
  }
  async function cleanup(intent: CoverSaveIntent) {
    const op = ports.repository.readCoverOperation(intent.operationId);
    if (!op) throw Error('Missing intent');
    await ports.assets.cleanupOwnedUnreferenced(op);
    ports.repository.markCoverOperation(intent.operationId, {
      status: 'failed',
      cleanupComplete: true,
    });
  }
  const api = {
    async recover() {
      if (session || work || transfer) return false;
      ready = false;
      blocked = true;
      ready = await recovery.recover();
      blocked = !ready;
      storageUncertain = !ready;
      return ready;
    },
    async waitForSettlement() {
      await work;
      await transfer;
    },
    hasSession: () => !!session,
    // Coordinator owns the stop barrier; this reports only actual I/O so an
    // empty cover cleanup cannot block the manual text-flush lane.
    isActive: () => !!work || !!transfer,
    requestStop() {
      abort?.abort();
    },
    isBlocked: () => blocked || !ready,
    async getArticleCover(articleKey: string) {
      if (!StorageIdSchema.safeParse(articleKey).success)
        return { status: 'not_found' as const };
      if (!ready || blocked) return { status: 'unavailable' as const };
      try {
        const c = ports.repository.loadCover(articleKey);
        return c
          ? {
              status: 'ok' as const,
              configuration: {
                articleKey: c.articleKey,
                coverRevision: c.coverRevision,
                mode: c.mode,
                images: c.assets.map((a) => ({
                  assetKey: a.assetKey,
                  mime: a.mime,
                  width: a.width,
                  height: a.height,
                })),
              },
            }
          : { status: 'not_found' as const };
      } catch {
        storageUncertain = true;
        blocked = true;
        return { status: 'unavailable' as const };
      }
    },
    async beginCoverEdit(articleKey: string) {
      if (session || work) return snapshot('busy');
      const g = gate();
      if (g !== 'ready')
        return snapshot(
          blocked ? 'needs_review' : g === 'busy' ? 'busy' : 'blocked',
        );
      if (!StorageIdSchema.safeParse(articleKey).success)
        return snapshot('conflict');
      try {
        const article = ports.repository.loadEditableArticle(articleKey),
          config = ports.repository.loadCover(articleKey);
        if (!article || !config) return snapshot('conflict');
        const images = new Map<string, Candidate>();
        const tokens = config.assets.map((a) => {
          const t = ports.newId();
          images.set(t, {
            source: {
              kind: 'stored',
              configuration: config,
              assetKey: a.assetKey,
            },
            mime: a.mime,
            width: a.width,
            height: a.height,
            sha256: a.sha256,
            byteSize: a.byteSize,
          });
          return t;
        });
        session = {
          sessionId: ports.newId(),
          articleKey,
          baseArticleRevision: article.articleRevision,
          baseCoverRevision: config.coverRevision,
          draftRevision: 0,
          draft: { mode: config.mode, imageTokens: tokens },
          dirty: false,
          images,
          status: 'open',
          notice: null,
          initial: '',
        };
        session.initial = fingerprint(session);
        return snapshot();
      } catch {
        storageUncertain = true;
        blocked = true;
        return snapshot('needs_review');
      }
    },
    async getCoverEditState() {
      return snapshot(blocked ? 'needs_review' : undefined);
    },
    async setCoverDraft(command: unknown, draft: CoverDraft) {
      const s = matching(command),
        p = CoverDraftSchema.safeParse(draft);
      if (!s || !p.success || p.data.imageTokens.some((t) => !s.images.has(t)))
        return snapshot('conflict');
      if (
        s.status !== 'open' ||
        work ||
        gate() !== 'ready' ||
        s.draftRevision === Number.MAX_SAFE_INTEGER
      )
        return snapshot(blocked ? 'needs_review' : 'busy');
      s.draft = { ...p.data, imageTokens: [...p.data.imageTokens] };
      mutated(s);
      return snapshot();
    },
    async pickCoverImages(command: unknown, slots: number[]) {
      const s = matching(command),
        p = CoverSlotsSchema.safeParse(slots);
      if (
        !s ||
        !p.success ||
        slots.some(
          (i) =>
            i >=
            (s.draft.mode === 'single' ? 1 : s.draft.mode === 'triple' ? 3 : 0),
        )
      )
        return snapshot('conflict');
      const positions = new Set([
        ...s.draft.imageTokens.map((_, i) => i),
        ...slots,
      ]);
      if ([...positions].some((_, i) => !positions.has(i)))
        return snapshot('conflict');
      if (
        work ||
        s.status !== 'open' ||
        gate() !== 'ready' ||
        s.draftRevision === Number.MAX_SAFE_INTEGER
      )
        return snapshot(blocked ? 'needs_review' : 'busy');
      s.status = 'selecting';
      s.notice = null;
      s.imageFailure = undefined;
      const currentAbort = new AbortController();
      abort = currentAbort;
      const selecting = (async () => {
        try {
          const picked = await ports.picker.pick(
            slots.length,
            currentAbort.signal,
          );
          if (
            currentAbort.signal.aborted ||
            session !== s ||
            s.status === 'closing'
          )
            return;
          if (!picked) {
            s.notice = 'cancelled';
            return;
          }
          if (picked.length !== slots.length)
            throw Error('Wrong selection count');
          const next = [...s.draft.imageTokens],
            candidate = new Map(s.images);
          for (let n = 0; n < picked.length; n++) {
            const i = picked[n];
            CoverImageDescriptionSchema.parse({
              assetKey: ports.newId(),
              mime: i.mime,
              width: i.width,
              height: i.height,
            });
            if (
              i.bytes.byteLength === 0 ||
              i.bytes.byteLength > COVER_IMAGE_MAX_BYTES ||
              !/^[a-f0-9]{64}$/.test(i.sha256)
            )
              throw Error('Invalid image');
            const token = ports.newId();
            next[slots[n]] = token;
            candidate.set(token, {
              source: {
                kind: 'picked',
                image: { ...i, bytes: new Uint8Array(i.bytes) },
              },
              mime: i.mime,
              width: i.width,
              height: i.height,
              sha256: i.sha256,
              byteSize: i.bytes.byteLength,
            });
          }
          if (
            next.reduce((sum, t) => sum + candidate.get(t)!.byteSize, 0) >
            30_000_000
          )
            throw Error('Candidate budget');
          if (!validBase(s)) {
            s.notice = 'conflict';
            return;
          }
          s.images = candidate;
          s.draft = { ...s.draft, imageTokens: next };
          mutated(s);
        } catch (error) {
          if (!currentAbort.signal.aborted) {
            s.notice = blocked ? 'needs_review' : 'image_invalid';
            s.imageFailure =
              !blocked &&
              error instanceof CoverPickFailure &&
              Number.isInteger(error.selectionIndex) &&
              error.selectionIndex >= 0 &&
              error.selectionIndex < slots.length
                ? {
                    position: slots[error.selectionIndex],
                    reason: error.code as CoverImageFailure['reason'],
                  }
                : undefined;
          }
        } finally {
          if (s.status !== 'closing') s.status = 'open';
        }
      })();
      work = selecting;
      try {
        await selecting;
      } finally {
        if (work === selecting) work = undefined;
        if (abort === currentAbort) abort = undefined;
      }
      return snapshot();
    },
    async copyCoverImage(
      command: unknown,
      source: Extract<CoverImageRequest, { kind: 'stored' }>,
    ) {
      const s = matching(command),
        p = CoverImageRequestSchema.safeParse(source);
      if (!s || !p.success || p.data.kind !== 'stored')
        return snapshot('conflict');
      if (work || transfer || s.status !== 'open' || gate() !== 'ready')
        return snapshot('busy');
      if (s.draftRevision === Number.MAX_SAFE_INTEGER)
        return snapshot('conflict');
      const a = new AbortController();
      abort = a;
      s.status = 'selecting';
      const copying = (async () => {
        try {
          const c = ports.repository.loadCover(source.articleKey);
          if (
            !c ||
            c.mode !== 'single' ||
            c.coverRevision !== source.coverRevision ||
            c.assets.length !== 1 ||
            c.assets[0].assetKey !== source.assetKey
          ) {
            s.notice = 'conflict';
            return;
          }
          await ports.assets.verifyCoverVersion(c);
          a.signal.throwIfAborted();
          const bytes = await ports.assets.readCoverAsset(c, source.assetKey);
          a.signal.throwIfAborted();
          if (session !== s || s.status === 'closing' || gate() !== 'ready')
            return;
          if (
            !validBase(s) ||
            ports.repository.loadCover(source.articleKey)?.coverRevision !==
              source.coverRevision
          ) {
            s.notice = 'conflict';
            return;
          }
          const asset = c.assets[0];
          if (
            bytes.byteLength !== asset.byteSize ||
            bytes.byteLength > COVER_IMAGE_MAX_BYTES
          )
            throw Error('Invalid source');
          const token = ports.newId();
          s.images = new Map([
            [
              token,
              {
                source: {
                  kind: 'picked',
                  image: {
                    bytes: new Uint8Array(bytes),
                    mime: asset.mime,
                    width: asset.width,
                    height: asset.height,
                    sha256: asset.sha256,
                  },
                },
                mime: asset.mime,
                width: asset.width,
                height: asset.height,
                sha256: asset.sha256,
                byteSize: bytes.byteLength,
              },
            ],
          ]);
          s.draft = { mode: 'single', imageTokens: [token] };
          mutated(s);
        } catch {
          if (!a.signal.aborted)
            s.notice = blocked ? 'needs_review' : 'image_invalid';
        } finally {
          if (s.status !== 'closing') s.status = 'open';
        }
      })();
      work = copying;
      try {
        await copying;
      } finally {
        if (work === copying) work = undefined;
        if (abort === a) abort = undefined;
      }
      return snapshot();
    },
    async getCoverImage(request: CoverImageRequest): Promise<CoverImageResult> {
      if (stopped) return { status: 'unavailable' };
      if (transfer) return { status: 'busy' };
      const p = CoverImageRequestSchema.safeParse(request);
      if (!p.success) return { status: 'not_found' };
      if (!ready || blocked) return { status: 'unavailable' };
      const s = session;
      let candidate: Candidate | undefined,
        config: StoredCoverConfiguration | undefined;
      try {
        if (request.kind === 'session') {
          if (!s || s.sessionId !== request.sessionId || s.status === 'closing')
            return { status: 'not_found' };
          candidate = s.images.get(request.imageToken);
          if (!candidate) return { status: 'not_found' };
        } else {
          if (!ports.repository.loadCover(request.articleKey))
            return { status: 'not_found' };
          config = ports.repository.loadArchivedCoverVersion(
            request.articleKey,
            request.coverRevision,
          );
          if (
            !config ||
            !config.assets.some((a) => a.assetKey === request.assetKey)
          )
            return { status: 'not_found' };
        }
        const reading = (async (): Promise<CoverImageResult> => {
          try {
            const bytes = candidate
              ? await readCandidate(candidate)
              : await ports.assets.readCoverAsset(
                  config!,
                  request.kind === 'stored' ? request.assetKey : '',
                );
            if (
              request.kind === 'session' &&
              (session !== s ||
                s!.status === 'closing' ||
                s!.images.get(request.imageToken) !== candidate)
            )
              return { status: 'not_found' };
            if (
              request.kind === 'stored' &&
              !ports.repository.loadCover(request.articleKey)
            )
              return { status: 'not_found' };
            if (
              bytes.byteLength === 0 ||
              bytes.byteLength > COVER_IMAGE_MAX_BYTES
            )
              throw Error('Invalid transfer');
            const mime =
              candidate?.mime ??
              config!.assets.find(
                (a) =>
                  a.assetKey ===
                  (request.kind === 'stored' ? request.assetKey : ''),
              )!.mime;
            return { status: 'ok', mime, bytes: new Uint8Array(bytes) };
          } catch (error) {
            if (!(
              error instanceof ImportFailure &&
              error.code === 'IMAGE_UNAVAILABLE'
            ))
              storageUncertain = blocked = true;
            return { status: 'unavailable' };
          }
        })();
        transfer = reading;
        try {
          return await reading;
        } finally {
          if (transfer === reading) transfer = undefined;
        }
      } catch {
        storageUncertain = true;
        blocked = true;
        return { status: 'unavailable' };
      }
    },
    async saveCoverEdit(command: CoverSaveCommand) {
      if (!CoverSaveCommandSchema.safeParse(command).success)
        return result('conflict', command.operationId);
      const s = session;
      const prior = attempts.get(command.operationId);
      if (prior) {
        if (
          !s ||
          s.sessionId !== command.sessionId ||
          prior.intent.sessionId !== s.sessionId ||
          prior.intent.articleKey !== s.articleKey ||
          prior.intent.draftRevision !== s.draftRevision ||
          prior.intent.expectedArticleRevision !== s.baseArticleRevision ||
          (prior.intent.expectedCoverRevision !== s.baseCoverRevision &&
            prior.settledCoverRevision !== s.baseCoverRevision) ||
          prior.commandRevision !== command.expectedDraftRevision ||
          prior.fingerprint !== fingerprint(s)
        )
          return result('conflict', command.operationId);
        return api.getCoverSaveResult(command.operationId);
      }
      const valid = matching({
        sessionId: command.sessionId,
        expectedDraftRevision: command.expectedDraftRevision,
      });
      if (!valid) return result('conflict', command.operationId);
      if (work || valid.status !== 'open' || gate() !== 'ready')
        return result(
          blocked ? 'needs_review' : 'blocked',
          command.operationId,
        );
      if (
        valid.draft.imageTokens.length !==
        (valid.draft.mode === 'none'
          ? 0
          : valid.draft.mode === 'single'
            ? 1
            : 3)
      )
        return result('conflict', command.operationId);
      try {
        const existing = ports.repository.readCoverOperation(
          command.operationId,
        );
        if (existing) return result('conflict', command.operationId);
        if (!validBase(valid)) return result('conflict', command.operationId);
      } catch {
        storageUncertain = true;
        blocked = true;
        return result('needs_review', command.operationId);
      }
      const fp = fingerprint(valid),
        intent: CoverSaveIntent = {
          operationId: command.operationId,
          articleKey: valid.articleKey,
          sessionId: valid.sessionId,
          expectedArticleRevision: valid.baseArticleRevision,
          expectedCoverRevision: valid.baseCoverRevision,
          draftRevision: valid.draftRevision,
          mode: valid.draft.mode,
          payloadDigest: ports.digest({
            articleKey: valid.articleKey,
            sessionId: valid.sessionId,
            articleRevision: valid.baseArticleRevision,
            coverRevision: valid.baseCoverRevision,
            mode: valid.draft.mode,
            images: valid.draft.imageTokens.map(
              (t) => valid.images.get(t)!.sha256,
            ),
          }),
          startedAt: ports.now(),
        };
      attempts.set(command.operationId, {
        intent,
        fingerprint: fp,
        commandRevision: command.expectedDraftRevision,
      });
      valid.status = 'saving';
      valid.notice = null;
      valid.imageFailure = undefined;
      const currentAbort = new AbortController();
      abort = currentAbort;
      const saving = (async (): Promise<CoverSaveResult> => {
        let begun = false;
        try {
          const admitted = ports.repository.beginCoverSave(intent);
          // T1 returns not_started only for a freshly persisted preparing intent.
          // Pending is an existing/unknown operation and never authorizes replay.
          if (admitted.status !== 'not_started') {
            if (
              admitted.status === 'pending' ||
              admitted.status === 'needs_review'
            ) {
              blocked = true;
              valid.unknownOperation = intent.operationId;
              valid.notice = 'needs_review';
            }
            return admitted;
          }
          const persisted = ports.repository.readCoverOperation(
            intent.operationId,
          );
          if (
            !persisted ||
            persisted.status !== 'preparing' ||
            persisted.ownedFiles.length !== 0 ||
            persisted.cleanupComplete ||
            persisted.committedCoverRevision !== null ||
            Object.keys(intent).some(
              (k) =>
                persisted[k as keyof CoverSaveIntent] !==
                intent[k as keyof CoverSaveIntent],
            )
          )
            throw Error('Intent mismatch');
          begun = true;
          const images = [];
          for (const token of valid.draft.imageTokens) {
            currentAbort.signal.throwIfAborted();
            images.push({
              bytes: await readCandidate(valid.images.get(token)!),
            });
          }
          const files = await ports.assets.prepareCoverFiles(
            intent,
            images,
            currentAbort.signal,
          );
          currentAbort.signal.throwIfAborted();
          if (gate() !== 'ready' || !validBase(valid)) {
            await cleanup(intent);
            return result('conflict', intent.operationId);
          }
          const committed = ports.repository.commitCoverVersion(intent, files);
          if (committed.status === 'committed')
            await settleKnown(valid, committed);
          else if (
            committed.status === 'conflict' ||
            committed.status === 'blocked'
          )
            await cleanup(intent);
          else {
            blocked = true;
            valid.unknownOperation = intent.operationId;
          }
          return committed;
        } catch (error) {
          try {
            const known = ports.repository.readCoverSaveResult(
              intent.operationId,
            );
            if (known.status === 'committed') {
              await settleKnown(valid, known);
              return known;
            }
            if (
              begun &&
              (currentAbort.signal.aborted ||
                (error instanceof ImportFailure &&
                  error.code === 'IMAGE_UNAVAILABLE'))
            ) {
              await cleanup(intent);
              return result('failed', intent.operationId);
            }
          } catch {
            /* Preserve intent/receipt when proof or cleanup cannot be established. */
          }
          blocked = true;
          valid.unknownOperation = intent.operationId;
          valid.notice = 'needs_review';
          return result('needs_review', intent.operationId);
        } finally {
          if (valid.status !== 'closing') valid.status = 'open';
        }
      })();
      work = saving;
      try {
        return await saving;
      } finally {
        if (work === saving) work = undefined;
        if (abort === currentAbort) abort = undefined;
      }
    },
    async getCoverSaveResult(operationId: string) {
      if (!StorageIdSchema.safeParse(operationId).success)
        return result('unavailable', operationId);
      try {
        const r = CoverSaveResultSchema.parse(
          ports.repository.readCoverSaveResult(operationId),
        );
        if (
          (r.status === 'committed' ? r.receipt.operationId : r.operationId) !==
          operationId
        )
          throw Error('Cover receipt operation mismatch');
        if (
          session?.unknownOperation === operationId &&
          (r.status === 'committed' ||
            (r.status === 'failed' && session.status === 'open'))
        )
          await settleKnown(session, r);
        return r;
      } catch {
        storageUncertain = true;
        blocked = true;
        return result('needs_review', operationId);
      }
    },
    async closeCoverEdit(sessionId: string) {
      if (!session || session.sessionId !== sessionId)
        return snapshot('conflict');
      const s = session;
      if (s.unknownOperation || blocked) return snapshot('needs_review');
      s.status = 'closing';
      abort?.abort();
      await work;
      await transfer;
      if (s.unknownOperation || blocked) {
        s.status = 'open';
        return snapshot('needs_review');
      }
      if (session === s) {
        s.images.clear();
        session = undefined;
      }
      return snapshot();
    },
    stopForRestart(): Promise<void> {
      if (restartSettlement) return restartSettlement;
      abort?.abort();
      restartSettlement = Promise.resolve()
        .then(async () => {
          await work;
          await transfer;
          if (blocked || storageUncertain || session?.unknownOperation)
            throw Error('Cover settlement required');
          // Preserve unsaved candidates for explicit operator save or discard.
          if (session?.dirty) throw Error('Unsaved cover retained');
          if (session) {
            const answer = await api.closeCoverEdit(session.sessionId);
            if ('sessionId' in answer) throw Error('Cover settlement required');
          }
        })
        .finally(() => {
          restartSettlement = undefined;
        });
      return restartSettlement;
    },
    async stopAndWait() {
      stopped = true;
      if (session) {
        const answer = await api.closeCoverEdit(session.sessionId);
        if ('sessionId' in answer) throw Error('Cover settlement required');
      } else {
        await work;
        await transfer;
      }
      if (blocked) throw Error('Cover settlement required');
    },
  };
  return api;
}

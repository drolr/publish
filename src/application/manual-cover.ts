import type {
  CoverImageResult,
  CoverSaveIntent,
  CoverSaveResult,
  StoredCoverConfiguration,
} from '../contracts/article-cover';
import { CoverImageResultSchema } from '../contracts/article-cover';
import type {
  CoverFilePicker,
  PickedCoverImage,
} from '../domain/ports/article-cover';
import type { ManualSession } from './manual-article-mapper';
import type { CoverSaveService } from './cover-save';
import type { EditableArticle } from '../contracts/article-revision';

export interface ManualCoverServices {
  picker: CoverFilePicker;
  loadCover(articleKey: string): StoredCoverConfiguration | undefined;
  readImage(
    configuration: StoredCoverConfiguration,
    assetKey: string,
  ): Promise<Uint8Array>;
  save: CoverSaveService['save'];
  getSaveResult: CoverSaveService['getSaveResult'];
}
interface PendingCover {
  picked?: PickedCoverImage;
  stored?: StoredCoverConfiguration;
  intent?: CoverSaveIntent;
}
/** One manual owner retains candidate bytes and immutable cover operation identity. */
export function createManualCoverState(ports: {
  services?: ManualCoverServices;
  newId(): string;
  digest(value: unknown): string;
  loadEditableArticle(articleKey: string): EditableArticle | undefined;
  gate(): string;
}) {
  const candidates = new Map<string, PendingCover>();
  let transfer: Promise<CoverImageResult> | undefined;

  function initialize(session: ManualSession) {
    if (candidates.has(session.sessionId)) return;
    const stored =
      session.target.kind === 'existing' && ports.services
        ? ports.services.loadCover(session.target.articleKey)
        : undefined;
    if (
      ports.services &&
      session.target.kind === 'existing' &&
      (!stored || stored.articleKey !== session.target.articleKey)
    ) {
      throw Error('Missing cover head');
    }
    const firstImage = stored?.assets[0];
    session.cover = {
      draftRevision: 0,
      baseCoverRevision: stored?.coverRevision ?? 0,
      mode: stored?.mode ?? 'none',
      dirty: false,
      ...(firstImage
        ? {
            image: {
              imageToken: ports.newId(),
              mime: firstImage.mime,
              width: firstImage.width,
              height: firstImage.height,
            },
          }
        : {}),
    };
    candidates.set(session.sessionId, { stored });
  }
  function unknown(session: ManualSession) {
    return (
      !!session.cover?.outcome &&
      ['pending', 'needs_review', 'unavailable', 'not_started'].includes(
        session.cover.outcome.status,
      )
    );
  }
  function validBase(session: ManualSession) {
    if (session.target.kind !== 'existing' || !ports.services || !session.cover)
      return false;
    const target = session.target;
    const editable = ports.loadEditableArticle(target.articleKey);
    const head = ports.services.loadCover(target.articleKey);
    return (
      !!editable &&
      editable.article.articleKey === target.articleKey &&
      editable.article.externalId === target.externalId &&
      editable.article.importId === target.importId &&
      editable.articleRevision === target.baseArticleRevision &&
      !!head &&
      head.articleKey === target.articleKey &&
      head.coverRevision === session.cover.baseCoverRevision
    );
  }
  async function settle(session: ManualSession, result: CoverSaveResult) {
    const candidate = candidates.get(session.sessionId)!;
    const intent = candidate.intent!;
    const cover = session.cover!;
    if (result.status === 'committed') {
      const receipt = result.receipt;
      const head = ports.services!.loadCover(intent.articleKey);
      if (
        receipt.operationId !== intent.operationId ||
        receipt.articleKey !== intent.articleKey ||
        receipt.coverRevision !== intent.expectedCoverRevision + 1 ||
        !head ||
        head.articleKey !== receipt.articleKey ||
        head.saveOperationId !== receipt.operationId ||
        head.coverRevision !== receipt.coverRevision ||
        head.mode !== intent.mode ||
        head.configurationDigest !== receipt.configurationDigest
      ) {
        throw Error('Cover receipt mismatch');
      }
      cover.baseCoverRevision = receipt.coverRevision;
      cover.dirty = false;
      candidate.stored = head;
      delete candidate.picked;
    } else if (result.operationId !== intent.operationId) {
      throw Error('Cover operation mismatch');
    }
    cover.outcome = result;
    delete cover.notice;
  }
  return {
    initialize,
    unknown,
    async pick(session: ManualSession, signal: AbortSignal) {
      initialize(session);
      if (!ports.services) return;
      try {
        const selection = await ports.services.picker.pick(1, signal);
        signal.throwIfAborted();
        if (!selection) return;
        if (selection.length !== 1) throw Error('Invalid cover selection');
        const image = selection[0];
        const cover = session.cover!;
        CoverImageResultSchema.parse({
          status: 'ok',
          mime: image.mime,
          bytes: image.bytes,
        });
        candidates.get(session.sessionId)!.picked = {
          ...image,
          bytes: new Uint8Array(image.bytes),
        };
        cover.mode = 'single';
        cover.image = {
          imageToken: ports.newId(),
          mime: image.mime,
          width: image.width,
          height: image.height,
        };
        cover.draftRevision++;
        cover.dirty = true;
        delete cover.outcome;
        delete cover.notice;
        session.revision++;
      } catch {
        if (signal.aborted) return;
        session.cover!.notice =
          '封面图片无法使用，请选择有效的 JPG 或 PNG 图片。';
      }
    },
    mode(session: ManualSession, mode: 'none' | 'single') {
      initialize(session);
      const cover = session.cover!;
      if (cover.mode === mode) return;
      cover.mode = mode;
      delete cover.image;
      delete candidates.get(session.sessionId)!.picked;
      cover.draftRevision++;
      cover.dirty = true;
      delete cover.outcome;
      delete cover.notice;
      session.revision++;
    },
    async read(
      session: ManualSession,
      token: string,
    ): Promise<CoverImageResult> {
      if (transfer) return { status: 'busy' };
      initialize(session);
      const image = session.cover?.image;
      if (!image || image.imageToken !== token) return { status: 'not_found' };
      const candidate = candidates.get(session.sessionId)!;
      // Selection/clear may run while a stored read awaits I/O. Capture its source
      // and MIME together, then reject a late result whose binding was replaced.
      const picked = candidate.picked;
      const stored = candidate.stored;
      const mime = image.mime;
      const reading = (async (): Promise<CoverImageResult> => {
        try {
          const bytes = picked
            ? new Uint8Array(picked.bytes)
            : stored && ports.services
              ? await ports.services.readImage(
                  stored,
                  stored.assets[0].assetKey,
                )
              : undefined;
          if (
            candidates.get(session.sessionId) !== candidate ||
            session.cover?.image?.imageToken !== token
          ) {
            return { status: 'not_found' };
          }
          return bytes
            ? CoverImageResultSchema.parse({ status: 'ok', mime, bytes })
            : { status: 'not_found' };
        } catch {
          return { status: 'unavailable' };
        }
      })();
      transfer = reading;
      try {
        return await reading;
      } finally {
        if (transfer === reading) transfer = undefined;
      }
    },
    async save(session: ManualSession, signal: AbortSignal) {
      initialize(session);
      const cover = session.cover!;
      const candidate = candidates.get(session.sessionId)!;
      if (!cover.dirty) return;
      if (!ports.services || !validBase(session)) {
        cover.outcome = { status: 'conflict', operationId: ports.newId() };
        return;
      }
      if (
        cover.mode === 'triple' ||
        (cover.mode === 'single' && !candidate.picked)
      ) {
        cover.notice = '请选择一张封面图片后再保存。';
        return;
      }
      if (session.target.kind !== 'existing')
        throw Error('Unsaved cover target');
      const intent: CoverSaveIntent = {
        operationId: ports.newId(),
        articleKey: session.target.articleKey,
        sessionId: session.sessionId,
        expectedArticleRevision: session.target.baseArticleRevision,
        expectedCoverRevision: cover.baseCoverRevision,
        draftRevision: cover.draftRevision,
        mode: cover.mode,
        payloadDigest: ports.digest({
          sessionId: session.sessionId,
          target: session.target,
          coverRevision: cover.baseCoverRevision,
          mode: cover.mode,
          sha256: candidate.picked?.sha256,
        }),
        startedAt: new Date().toISOString(),
      };
      candidate.intent = intent;
      cover.outcome = { status: 'pending', operationId: intent.operationId };
      try {
        const picked = candidate.picked;
        const result = await ports.services.save(
          intent,
          async () => (picked ? [{ bytes: new Uint8Array(picked.bytes) }] : []),
          signal,
          () => ports.gate() === 'ready' && validBase(session),
          (result) => settle(session, result),
        );
        await settle(session, result);
      } catch {
        cover.outcome = {
          status: 'needs_review',
          operationId: intent.operationId,
        };
      }
      session.revision++;
    },
    async reconcile(session: ManualSession) {
      const candidate = candidates.get(session.sessionId);
      if (!candidate?.intent || !ports.services || !unknown(session)) return;
      try {
        const result = await ports.services.getSaveResult(
          candidate.intent.operationId,
          candidate.intent,
        );
        // Shared writer verifies immutable intent and journal cleanup before failed.
        if (
          result.status === 'failed' &&
          (!validBase(session) ||
            candidate.intent.sessionId !== session.sessionId ||
            candidate.intent.draftRevision !== session.cover?.draftRevision)
        )
          return;
        if (result.status === 'committed' || result.status === 'failed') {
          await settle(session, result);
        }
      } catch {
        // Retain the original unknown identity; never replay it.
      }
      session.revision++;
    },
    async release(sessionId: string) {
      await transfer;
      candidates.delete(sessionId);
    },
  };
}

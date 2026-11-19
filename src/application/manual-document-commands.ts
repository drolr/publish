import {
  createManualCoverState,
  type ManualCoverServices,
} from './manual-cover';
import type { ManualArticleApi } from '../contracts/manual-article';
import { isManualImageBlock } from '../contracts/manual-rich-draft';
import type { PasteSummary } from '../contracts/web-paste';
import type { ManualFragmentV2 } from '../contracts/manual-rich-draft';
import {
  ManualDraftSchema,
  ManualImageSchema,
  manualRequests,
  type ManualDraft,
  type ManualImage,
  type ManualReply,
  type ManualState,
} from '../contracts/manual-article';
import { TitleSchema } from '../contracts/article-package';
import type {
  ContinuousManualArticleApi,
  DocumentCommand,
  DraftRange,
  SaveCommand,
  ManualOperationKind,
} from '../contracts/manual-edit';
import type {
  EditableArticle,
  RevisionImageSource,
  RevisionSaveInput,
  RevisionSaveResult,
  SaveLookup,
  EditorCompatibilityLease,
} from '../contracts/article-revision';
import type { StoredImageLeases } from '../domain/ports/revision-assets';
import type { ManualClipboard } from '../domain/ports/manual-clipboard';
import {
  manualRevisionInput,
  manualSessionFromEditable,
  type ManualSession,
} from './manual-article-mapper';
import { richBodyEquals, upgradeEditorBody } from '../domain/rich-text-body';
import {
  selectManualRange,
  spliceManualRange,
} from '../domain/manual-draft-range';
import { WebPasteFailure } from '../domain/web-paste-error';
import { admitRichManualPaste } from './manual-paste-admission';
import {
  runManualPasteImages,
  isPasteSource,
  type PasteRunItem,
} from './manual-paste-runner';
import type { ManualPasteControllerPorts } from '../domain/ports/web-paste';

export interface ManualDocumentServices {
  covers?: ManualCoverServices;
  createEditorCompatibilityLease(
    articleKey: string,
    sessionId: string,
    baseRevision: number,
  ): EditorCompatibilityLease | undefined;
  releaseEditorCompatibilityLease(lease: EditorCompatibilityLease): void;
  loadEditableArticle(articleKey: string): EditableArticle | undefined;
  storedImages: StoredImageLeases;
  saveRevision(
    input: RevisionSaveInput,
    signal: AbortSignal,
  ): Promise<RevisionSaveResult>;
  getSaveResult(operationId: string): Promise<SaveLookup>;
  clipboard: ManualClipboard;
  digest(value: unknown): string;
  respondClose(
    requestId: string,
    sessionId: string,
    documentRevision: number,
    status: 'flushed' | 'blocked',
  ): boolean;
}
/** Trusted queue-local primitives. No session or writer is owned by this facade. */
export interface ManualDocumentCommandPorts extends ManualPasteControllerPorts {
  newId(): string;
  current(): ManualState;
  replace(state: ManualState): void;
  reply(status: ManualReply['status']): ManualReply;
  gate(): 'ready' | 'busy' | 'unavailable';
  editGate(): 'ready' | 'busy' | 'unavailable';
  discardGate(): 'ready' | 'busy' | 'unavailable';
  verifyConflictDiscard(): boolean;
  versionConflict(): void;
  busy(): boolean;
  blocked(): void;
  mutate(operation: () => Promise<ManualReply>): Promise<ManualReply>;
  run(
    session: ManualSession,
    kind: ManualOperationKind,
    operation: (signal: AbortSignal) => Promise<void>,
  ): ManualReply;
  retain(session: ManualSession): Promise<boolean>;
  release(session: ManualSession): Promise<boolean>;
  chooseImage(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ManualImage | undefined>;
  rememberPasteItems(items: readonly PasteRunItem[]): void;
  onSessionRelease(listener: (sessionId: string) => void | Promise<void>): void;
  services?: ManualDocumentServices;
}
type KnownCommand = DocumentCommand & { digest: string };
export class ManualVersionConflict extends WebPasteFailure {
  constructor() {
    super('RECOVERY_REQUIRED');
  }
}
type KnownSave = SaveCommand & {
  input?: RevisionSaveInput;
  payloadDigest: string;
  target: ManualSession['target'];
  startedAt?: string;
  status: 'pending' | 'failed' | 'committed' | 'unchanged' | 'unknown';
};
export interface ManualLegacyDocumentCommands {
  confirmLegacyDocument(
    session: ManualSession,
    draft: ManualDraft,
    images?: ManualImage[],
    candidates?: ManualSession['candidates'],
    enforcePositions?: boolean,
  ): void;
  invalidateLegacyTicket(session: ManualSession): void;
  updateLegacyDocument(draft: ManualDraft): Promise<ManualReply>;
  commitLegacyDocument(
    sessionId: string,
    expectedRevision: number,
  ): ManualReply;
}
export function createManualDocumentCommands(
  ports: ManualDocumentCommandPorts,
): ContinuousManualArticleApi &
  ManualLegacyDocumentCommands &
  Pick<
    ManualArticleApi,
    | 'pickManualCoverImage'
    | 'setManualCoverMode'
    | 'getManualCoverImage'
    | 'reconcileManualCoverSave'
  > {
  const covers = createManualCoverState({
    services: ports.services?.covers,
    newId: ports.newId,
    digest: (value) => ports.services!.digest(value),
    loadEditableArticle: (key) => ports.services!.loadEditableArticle(key),
    gate: ports.gate,
  });
  let boundSession: string | undefined;
  let compatibilityLease: EditorCompatibilityLease | undefined;
  let compatibilitySession: string | undefined;
  let compatibilityCeiling = 200;
  function releaseCompatibility(sessionId: string) {
    if (compatibilitySession !== sessionId) return;
    if (compatibilityLease)
      ports.services!.releaseEditorCompatibilityLease(compatibilityLease);
    compatibilityLease = undefined;
    compatibilitySession = undefined;
    compatibilityCeiling = 200;
  }
  const commands = new Map<string, KnownCommand>();
  const saves = new Map<string, KnownSave>();
  const legacySaves = new Map<string, SaveCommand>();
  const rejectedSaves = new Map<
    string,
    SaveCommand & { status: 'invalid' | 'conflict' }
  >();
  const imageSources = new Map<string, RevisionImageSource>();
  const imageKeys = new Map<string, string>();
  const pendingKeys = new Map<string, string>();
  function session(): ManualSession | undefined {
    const value = ports.current();
    if (!('sessionId' in value)) return undefined;
    if (value.sessionId !== boundSession) {
      if (boundSession) releaseCompatibility(boundSession);
      boundSession = value.sessionId;
      commands.clear();
      saves.clear();
      legacySaves.clear();
      rejectedSaves.clear();
      imageSources.clear();
      imageKeys.clear();
      pendingKeys.clear();
    }
    covers.initialize(value);
    for (const block of value.draft.blocks) {
      if (block.type === 'image')
        imageKeys.set(block.blockKey, block.imageToken);
      if (block.type === 'image-pending')
        pendingKeys.set(block.blockKey, block.candidateId);
    }
    return value;
  }
  function invalid(
    message = '内容、图片或选区已失效，请检查后重试。',
  ): ManualReply {
    const result = ports.reply('invalid');
    if ('sessionId' in result.snapshot) result.snapshot.issues = [{ message }];
    return result;
  }
  const digest = (value: unknown) =>
    ports.services?.digest(value) ??
    ports.fingerprint(value as Parameters<typeof ports.fingerprint>[0]);
  function check(
    command: DocumentCommand,
    payload: unknown,
  ): ManualReply | undefined {
    const s = session();
    if (!s || s.sessionId !== command.sessionId) return ports.reply('conflict');
    const fingerprint = digest(payload);
    const old = commands.get(command.commandId);
    if (old)
      return ports.reply(
        old.sessionId === command.sessionId &&
          old.expectedDocumentRevision === command.expectedDocumentRevision &&
          old.clientSequence === command.clientSequence &&
          old.digest === fingerprint
          ? 'ok'
          : 'conflict',
      );
    if (
      s.nextEditCommandId !== command.commandId ||
      s.documentRevision !== command.expectedDocumentRevision ||
      command.clientSequence !== s.nextClientSequence ||
      command.clientSequence >= Number.MAX_SAFE_INTEGER
    )
      return ports.reply('conflict');
    if (covers.unknown(s)) return ports.reply('unavailable');
    const ready =
      Array.isArray(payload) && payload[0] === 'edit'
        ? ports.editGate()
        : Array.isArray(payload) &&
            payload[0] === 'close' &&
            payload[1] === 'discard'
          ? ports.discardGate()
          : ports.gate();
    if (ready !== 'ready') return ports.reply(ready);
    if (ports.busy()) return ports.reply('busy');
    if (s.state !== 'editing') return ports.reply('unavailable');
    return undefined;
  }
  function reserve(
    s: ManualSession,
    command: DocumentCommand,
    payload: unknown,
  ) {
    commands.set(command.commandId, { ...command, digest: digest(payload) });
    s.nextClientSequence = command.clientSequence + 1;
    s.nextEditCommandId = ports.newId();
    s.revision++;
  }
  function accept(
    s: ManualSession,
    command: DocumentCommand,
    payload: unknown,
  ) {
    if (!commands.has(command.commandId)) reserve(s, command, payload);
    s.acknowledgedEdit = {
      clientSequence: command.clientSequence,
      commandId: command.commandId,
    };
    s.revision++;
  }
  function confirm(s: ManualSession, draft: ManualDraft) {
    if (
      JSON.stringify(ManualDraftSchema.parse(s.draft)) !== JSON.stringify(draft)
    ) {
      s.draft = draft;
      s.documentRevision++;
      s.dirty = true;
      for (const prior of saves.values())
        if (
          prior.status === 'failed' &&
          prior.expectedDocumentRevision !== s.documentRevision
        )
          delete prior.input;
      delete s.saveOutcome;
    }
    delete s.issues;
    delete s.result;
    session();
  }
  function invalidateLegacyTicket(s: ManualSession) {
    s.nextEditCommandId = ports.newId();
    s.nextClientSequence++;
  }
  function authorized(s: ManualSession, draft: ManualDraft): boolean {
    const positions = (d: ManualDraft) =>
      d.blocks.filter(isManualImageBlock).length;
    if (positions(draft) > compatibilityCeiling) return false;
    return draft.blocks.every(
      (b) =>
        !isManualImageBlock(b) ||
        (b.type === 'image'
          ? imageKeys.get(b.blockKey) === b.imageToken &&
            s.images.some((i) => i.imageToken === b.imageToken)
          : b.type === 'image-pending' &&
            pendingKeys.get(b.blockKey) === b.candidateId),
    );
  }
  function rangeValid(s: ManualSession, range: DraftRange): boolean {
    try {
      selectManualRange(s.draft, range);
      return true;
    } catch {
      return false;
    }
  }
  async function acceptDraft(
    s: ManualSession,
    draft: ManualDraft,
    images = s.images,
    signal?: AbortSignal,
  ) {
    const next = { ...s, draft, images };
    if (!(await ports.retain(next)))
      throw new WebPasteFailure('RECOVERY_REQUIRED');
    if (signal?.aborted) throw new WebPasteFailure('CANCELLED');
    if (ports.current() !== s) throw new WebPasteFailure('RECOVERY_REQUIRED');
    s.images = images;
    confirm(s, draft);
  }
  async function bindSavedImages(s: ManualSession, editable: EditableArticle) {
    for (const [token, source] of imageSources) {
      if (source.kind === 'stored') continue;
      const asset = editable.article.assets.find(
        (a) => a.imageId === source.imageId,
      );
      if (!asset) continue; // History may reference an image removed from the saved body.
      const lease = await ports.services!.storedImages.bindSavedImage(
        s.sessionId,
        editable.article,
        asset.assetKey,
        token,
        new AbortController().signal,
      );
      imageSources.set(token, {
        kind: 'stored',
        imageId: asset.imageId,
        lease,
      });
    }
  }
  async function save(
    s: ManualSession,
    input: RevisionSaveInput | undefined,
    operationId: string,
    close: boolean,
    signal: AbortSignal,
  ) {
    if (!input) {
      if (!s.dirty && s.target.kind === 'existing') {
        await covers.save(s, signal);
        const known = saves.get(operationId);
        if (known) known.status = 'unchanged';
        if (close && !s.cover?.dirty && !covers.unknown(s)) {
          if (ports.gate() !== 'ready' || !(await ports.release(s)))
            throw new WebPasteFailure('RECOVERY_REQUIRED');
          ports.replace({ state: 'idle', revision: s.revision + 1 });
        }
      }
      return;
    }
    const result = await ports.services!.saveRevision(input, signal);
    const known = saves.get(operationId);
    if (known)
      known.status =
        result.status === 'committed' ||
        result.status === 'unchanged' ||
        result.status === 'failed'
          ? result.status
          : 'unknown';
    if (known && known.status !== 'failed' && known.status !== 'pending')
      delete known.input;
    if (result.status === 'committed' || result.status === 'unchanged') {
      const articleKey =
        result.status === 'committed'
          ? result.receipt.articleKey
          : result.articleKey;
      const articleRevision =
        result.status === 'committed'
          ? result.receipt.articleRevision
          : result.articleRevision;
      s.saveOutcome = {
        kind: result.status === 'committed' ? result.receipt.kind : 'unchanged',
        articleKey,
        articleRevision,
        operationId,
      };
      s.dirty = false;
      const editable = ports.services!.loadEditableArticle(articleKey);
      if (editable && editable.articleRevision > articleRevision)
        throw new ManualVersionConflict();
      if (
        !editable ||
        editable.articleRevision !== articleRevision ||
        editable.article.title !== input.title ||
        editable.article.contentDeclaration !== input.contentDeclaration ||
        !richBodyEquals(
          upgradeEditorBody(editable.editorBody, editable.article.body),
          input.editorBody,
        )
      )
        throw new WebPasteFailure('RECOVERY_REQUIRED');
      // A receipt is commit evidence, never a source of an old document projection.
      s.target = {
        kind: 'existing',
        articleKey,
        externalId: editable.article.externalId,
        importId: editable.article.importId,
        baseArticleRevision: articleRevision,
      };
      await bindSavedImages(s, editable);
      const afterBinding = ports.services!.loadEditableArticle(articleKey);
      if (afterBinding && afterBinding.articleRevision > articleRevision)
        throw new ManualVersionConflict();
      if (!afterBinding || afterBinding.articleRevision !== articleRevision)
        throw new WebPasteFailure('RECOVERY_REQUIRED');
      await covers.save(s, signal);
      if (close && !s.cover?.dirty && !covers.unknown(s)) {
        if (ports.gate() !== 'ready')
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        if (!(await ports.release(s)))
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        ports.replace({ state: 'idle', revision: s.revision + 1 });
      }
    } else if (result.status === 'failed')
      s.issues = [{ message: '保存未完成，内容已保留，请检查后重试。' }];
    else throw new WebPasteFailure('RECOVERY_REQUIRED');
  }
  function commit(command: SaveCommand, close = false): ManualReply {
    if (!manualRequests.commitManualDocument.safeParse([command]).success)
      return invalid();
    const s = session();
    if (!s || s.sessionId !== command.sessionId) return ports.reply('conflict');
    if (covers.unknown(s)) return ports.reply('unavailable');
    if (
      (s.cover?.dirty && command.expectedCoverDraftRevision === undefined) ||
      (command.expectedCoverDraftRevision !== undefined &&
        command.expectedCoverDraftRevision !== s.cover?.draftRevision)
    )
      return ports.reply('conflict');
    const rejected = rejectedSaves.get(command.operationId);
    if (rejected)
      return rejected.expectedDocumentRevision ===
        command.expectedDocumentRevision
        ? ports.reply(rejected.status)
        : ports.reply('conflict');
    const old = saves.get(command.operationId);
    if (old) {
      if (
        old.expectedCoverDraftRevision !== command.expectedCoverDraftRevision ||
        old.expectedDocumentRevision !== command.expectedDocumentRevision
      )
        return ports.reply('conflict');
      if (old.status !== 'failed') return ports.reply('ok');
      if (s.documentRevision !== command.expectedDocumentRevision)
        return ports.reply('conflict');
      const ready = ports.gate();
      if (ready !== 'ready') return ports.reply(ready);
      if (ports.busy()) return ports.reply('busy');
      if (JSON.stringify(old.target) !== JSON.stringify(s.target))
        return ports.reply('conflict');
      let originalInput = old.input;
      if (!originalInput) {
        try {
          originalInput = manualRevisionInput(
            s,
            command,
            imageSources,
            s.target.kind === 'existing'
              ? ports.services!.loadEditableArticle(s.target.articleKey)
              : undefined,
            digest,
            old.startedAt ?? new Date().toISOString(),
            compatibilityLease,
          );
        } catch {
          ports.blocked();
          return ports.reply('unavailable');
        }
        const currentDigest =
          originalInput.kind === 'created'
            ? originalInput.command.payloadDigest
            : originalInput.intent.payloadDigest;
        if (currentDigest !== old.payloadDigest) return ports.reply('conflict');
      }
      const retryInput = originalInput;
      for (const prior of saves.values())
        if (prior !== old && prior.status === 'failed') delete prior.input;
      old.input = retryInput;
      old.status = 'pending';
      return ports.run(s, 'save', (signal) =>
        save(s, retryInput, command.operationId, close, signal),
      );
    }
    if (
      s.nextSaveOperationId !== command.operationId ||
      s.documentRevision !== command.expectedDocumentRevision
    )
      return ports.reply('conflict');
    const ready = ports.gate();
    if (ready !== 'ready') return ports.reply(ready);
    if (ports.busy()) return ports.reply('busy');
    if (!ports.services || s.state !== 'editing')
      return ports.reply('unavailable');
    const title = TitleSchema.safeParse(s.draft.title);
    if (!title.success || title.data !== s.draft.title) {
      rejectedSaves.set(command.operationId, { ...command, status: 'invalid' });
      s.nextSaveOperationId = ports.newId();
      s.revision++;
      s.issues = [
        {
          message:
            '请填写标题，并移除标题两端的空白字符后再保存。正文和图片已保留。',
        },
      ];
      return ports.reply('invalid');
    }
    if (s.cover?.dirty && s.cover.mode === 'single' && !s.cover.image)
      return invalid('请选择一张封面图片后再保存。');
    if (s.draft.blocks.some((b) => b.type === 'image-pending'))
      return invalid();
    let input: RevisionSaveInput | undefined;
    try {
      const editable =
        s.target.kind === 'existing'
          ? ports.services.loadEditableArticle(s.target.articleKey)
          : undefined;
      if (
        editable &&
        s.target.kind === 'existing' &&
        editable.articleRevision > s.target.baseArticleRevision &&
        editable.article.externalId === s.target.externalId &&
        editable.article.importId === s.target.importId
      ) {
        rejectedSaves.set(command.operationId, {
          ...command,
          status: 'conflict',
        });
        s.nextSaveOperationId = ports.newId();
        s.revision++;
        ports.versionConflict();
        return ports.reply('conflict');
      }
      input =
        !s.dirty && s.target.kind === 'existing' && s.cover?.dirty
          ? undefined
          : manualRevisionInput(
              s,
              command,
              imageSources,
              editable,
              digest,
              new Date().toISOString(),
              compatibilityLease,
            );
      for (const source of input?.images ?? [])
        if (source.kind === 'temporary')
          imageSources.set(source.imageToken, source);
    } catch {
      ports.blocked();
      return ports.reply('unavailable');
    }
    for (const prior of saves.values())
      if (prior.status === 'failed') delete prior.input;
    saves.set(command.operationId, {
      ...command,
      input,
      payloadDigest: input
        ? input.kind === 'created'
          ? input.command.payloadDigest
          : input.intent.payloadDigest
        : digest(s.target),
      target: structuredClone(s.target),
      ...(input?.kind === 'updated'
        ? { startedAt: input.intent.startedAt }
        : {}),
      status: 'pending',
    });
    s.nextSaveOperationId = ports.newId();
    return ports.run(s, 'save', (signal) =>
      save(s, input, command.operationId, close, signal),
    );
  }
  ports.onSessionRelease(async (sessionId) => {
    const current = ports.current();
    if (
      'sessionId' in current &&
      current.sessionId === sessionId &&
      covers.unknown(current)
    )
      throw Error('Cover outcome unknown');
    await covers.release(sessionId);
    releaseCompatibility(sessionId);
    for (const prior of saves.values())
      if (prior.sessionId === sessionId) delete prior.input;
  });
  function coverCheck(
    command: import('../contracts/manual-article').ManualCoverEditCommand,
  ) {
    const s = session();
    if (
      !s ||
      command.sessionId !== s.sessionId ||
      command.expectedCoverDraftRevision !== s.cover?.draftRevision
    )
      return ports.reply('conflict');
    if (ports.busy()) return ports.reply('busy');
    const gate = ports.gate();
    if (gate !== 'ready') return ports.reply(gate);
    if (s.state !== 'editing' || covers.unknown(s))
      return ports.reply('unavailable');
    return undefined;
  }
  return {
    async pickManualCoverImage(command) {
      if (!manualRequests.pickManualCoverImage.safeParse([command]).success)
        return invalid();
      const denied = coverCheck(command);
      if (denied) return denied;
      if (!ports.services?.covers) return ports.reply('unavailable');
      const s = session()!;
      return ports.run(s, 'image', (signal) => covers.pick(s, signal));
    },
    async setManualCoverMode(command, mode) {
      if (!manualRequests.setManualCoverMode.safeParse([command, mode]).success)
        return invalid();
      const denied = coverCheck(command);
      if (denied) return denied;
      covers.mode(session()!, mode);
      return ports.reply('ok');
    },
    async getManualCoverImage(sessionId, token) {
      if (
        !manualRequests.getManualCoverImage.safeParse([sessionId, token])
          .success
      )
        return { status: 'not_found' };
      const s = session();
      if (!s || s.sessionId !== sessionId) return { status: 'not_found' };
      return covers.read(s, token);
    },
    async reconcileManualCoverSave(sessionId) {
      if (
        !manualRequests.reconcileManualCoverSave.safeParse([sessionId]).success
      )
        return invalid();
      const s = session();
      if (!s || s.sessionId !== sessionId || ports.busy())
        return ports.reply('busy');
      if (ports.gate() !== 'ready') return ports.reply('unavailable');
      return ports.run(s, 'save', () => covers.reconcile(s));
    },
    invalidateLegacyTicket,
    confirmLegacyDocument(
      s,
      draft,
      images = s.images,
      candidates = s.candidates,
      enforcePositions = true,
    ) {
      session();
      const parsed = ManualDraftSchema.safeParse(draft);
      const positions = (d: ManualDraft) =>
        d.blocks.filter(isManualImageBlock).length;
      if (
        !parsed.success ||
        images.length + candidates.length > 200 ||
        images.reduce((n, i) => n + i.byteSize, 0) > 200 * 1024 * 1024 ||
        (enforcePositions &&
          positions(draft) > Math.max(200, positions(s.draft)))
      )
        throw new WebPasteFailure('INPUT_LIMIT');
      if (
        draft.blocks.some(
          (b) =>
            b.type === 'image' &&
            !images.some((i) => i.imageToken === b.imageToken),
        )
      )
        throw new WebPasteFailure('RECOVERY_REQUIRED');
      const changed =
        JSON.stringify(ManualDraftSchema.parse(s.draft)) !==
        JSON.stringify(parsed.data);
      s.images = images;
      s.candidates = candidates;
      confirm(s, parsed.data);
      if (changed) invalidateLegacyTicket(s);
    },
    async updateLegacyDocument(draft) {
      const s = session();
      if (!s) return ports.reply('unavailable');
      const parsed = ManualDraftSchema.safeParse(draft);
      if (!parsed.success || !authorized(s, parsed.data)) return invalid();
      return ports.mutate(async () => {
        const normalized = {
          ...parsed.data,
          blocks: parsed.data.blocks.map((b) =>
            b.type === 'image-pending' && imageKeys.has(b.blockKey)
              ? {
                  type: 'image' as const,
                  blockKey: b.blockKey,
                  imageToken: imageKeys.get(b.blockKey)!,
                }
              : b,
          ),
        };
        const changed =
          JSON.stringify(ManualDraftSchema.parse(s.draft)) !==
          JSON.stringify(ManualDraftSchema.parse(normalized));
        await acceptDraft(s, normalized);
        if (changed) invalidateLegacyTicket(s);
        s.revision++;
        return ports.reply('ok');
      });
    },
    commitLegacyDocument(sessionId, expectedRevision) {
      const s = session();
      if (!s || s.sessionId !== sessionId) return ports.reply('unavailable');
      const key = `${sessionId}:${expectedRevision}`;
      const previous = legacySaves.get(key);
      if (previous) return commit(previous);
      if (s.revision !== expectedRevision) return ports.reply('conflict');
      const command = {
        sessionId,
        expectedDocumentRevision: s.documentRevision,
        operationId: s.nextSaveOperationId,
      };
      const result = commit(command);
      if (
        result.status === 'started' ||
        result.status === 'invalid' ||
        result.status === 'conflict'
      )
        legacySaves.set(key, command);
      return result;
    },
    async openManualArticle(articleKey) {
      if (!manualRequests.openManualArticle.safeParse([articleKey]).success)
        return invalid();
      const ready = ports.gate();
      if (ready !== 'ready') return ports.reply(ready);
      if (ports.busy()) return ports.reply('busy');
      const old = session();
      if (old && (old.dirty || old.cover?.dirty || covers.unknown(old)))
        return ports.reply('conflict');
      if (!ports.services) return ports.reply('unavailable');
      let editable: EditableArticle | undefined;
      try {
        editable = ports.services.loadEditableArticle(articleKey);
      } catch {
        ports.blocked();
        return ports.reply('unavailable');
      }
      if (!editable) return ports.reply('unavailable');
      // Show the already loaded formal projection before async image verification.
      const {
        session: s,
        imageIds,
        assets,
      } = manualSessionFromEditable(
        editable,
        ports.current().revision + 1,
        ports.newId,
      );
      covers.initialize(s);
      ports.replace(s);
      session();
      compatibilityCeiling = Math.max(
        200,
        s.draft.blocks.filter(isManualImageBlock).length,
      );
      if (compatibilityCeiling > 200) {
        compatibilityLease = ports.services.createEditorCompatibilityLease(
          articleKey,
          s.sessionId,
          editable.articleRevision,
        );
        if (!compatibilityLease) {
          ports.blocked();
          return ports.reply('unavailable');
        }
        compatibilitySession = s.sessionId;
      }
      return ports.run(s, 'open', async (signal) => {
        if (old && !(await ports.release(old)))
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        for (const asset of assets) {
          signal.throwIfAborted();
          const token = imageIds.get(asset.imageId)!;
          const verified = await ports.services!.storedImages.authorizeStored(
            s.sessionId,
            editable!.article,
            asset.assetKey,
            signal,
          );
          s.images = s.images.map((i) =>
            i.imageToken === token ? verified.image : i,
          );
          s.draft.blocks = s.draft.blocks.map((b) =>
            b.type === 'image' && b.imageToken === token
              ? { ...b, imageToken: verified.image.imageToken }
              : b,
          );
          imageSources.set(verified.image.imageToken, {
            kind: 'stored',
            imageId: asset.imageId,
            lease: verified.lease,
          });
        }
        session();
      });
    },
    async applyManualEdit(command, draft) {
      if (!manualRequests.applyManualEdit.safeParse([command, draft]).success)
        return invalid();
      const denied = check(command, ['edit', draft]);
      if (denied) return denied;
      const s = session()!;
      reserve(s, command, ['edit', draft]);
      if (!authorized(s, draft)) return invalid();
      return ports.mutate(async () => {
        const normalized = {
          ...draft,
          blocks: draft.blocks.map((b) =>
            b.type === 'image-pending' && imageKeys.has(b.blockKey)
              ? {
                  type: 'image' as const,
                  blockKey: b.blockKey,
                  imageToken: imageKeys.get(b.blockKey)!,
                }
              : b,
          ),
        };
        await acceptDraft(s, ManualDraftSchema.parse(normalized));
        accept(s, command, ['edit', draft]);
        return ports.reply('ok');
      });
    },
    async spliceManualPaste(command, range, input) {
      if (
        !manualRequests.spliceManualPaste.safeParse([command, range, input])
          .success
      )
        return invalid();
      const payload = ['paste', range, input];
      const denied = check(command, payload);
      if (denied) return denied;
      const s = session()!;
      reserve(s, command, payload);
      if (!rangeValid(s, range)) return invalid();
      if ('kind' in input && !ports.services) return invalid();
      return ports.run(s, 'paste', async (signal) => {
        let items: PasteRunItem[] = [];
        const summary: PasteSummary = {
          jobId: s.jobId!,
          kind: 'paste',
          outcome: 'rejected',
          admitted: false,
          paragraphs: 0,
          imagePositions: 0,
          unresolved: 0,
          plainOnly: false,
          warnings: [],
        };
        s.pasteSummary = summary;
        if ('kind' in input) {
          const pasted = await ports.services!.clipboard.paste(
            input.grantId,
            s.sessionId,
            signal,
            s.images.map((i) => i.imageToken),
            { images: s.images, candidates: s.candidates.length },
          );
          signal.throwIfAborted();
          const proposal = spliceManualRange(
            s.draft,
            range,
            pasted.fragment,
            ports.newId,
          );
          if (
            proposal.blocks.filter(isManualImageBlock).length >
            Math.max(200, s.draft.blocks.filter(isManualImageBlock).length)
          )
            throw new WebPasteFailure('INPUT_LIMIT');
          const known = new Set(s.images.map((i) => i.imageToken));
          const fresh = [
            ...new Map(
              pasted.images
                .filter((i) => !known.has(i.imageToken))
                .map((i) => [i.imageToken, i]),
            ).values(),
          ];
          if (
            s.images.length + s.candidates.length + fresh.length > 200 ||
            s.images.reduce((n, i) => n + i.byteSize, 0) +
              fresh.reduce((n, i) => n + i.byteSize, 0) >
              200 * 1024 * 1024
          )
            throw new WebPasteFailure('IMAGE_LIMIT');
          await acceptDraft(s, proposal, [...s.images, ...fresh], signal);
          summary.paragraphs = pasted.fragment.blocks.reduce(
            (n, b) =>
              n +
              (b.type === 'list'
                ? b.items.length
                : b.type === 'blockquote'
                  ? b.paragraphs.length
                  : isManualImageBlock(b)
                    ? 0
                    : 1),
            0,
          );
          summary.imagePositions =
            pasted.fragment.blocks.filter(isManualImageBlock).length;
        } else {
          const converted = await ports.converter.convert(input, signal);
          signal.throwIfAborted();
          const admitted = admitRichManualPaste(
            s,
            converted,
            ports.newId,
            range,
          );
          await acceptDraft(s, admitted.draft, s.images, signal);
          Object.assign(summary, {
            paragraphs: admitted.paragraphs,
            plainOnly: admitted.plainOnly,
            warnings: admitted.warnings,
            imagePositions: admitted.items.length,
          });
          s.candidates.push(...admitted.candidates);
          items = admitted.items;
          ports.rememberPasteItems(items);
        }
        summary.admitted = true;
        summary.unresolved = items.length;
        summary.outcome = items.length ? 'partial' : 'completed';
        s.pasteProgress = {
          jobId: s.jobId!,
          kind: 'paste',
          phase: items.length ? 'images' : 'parsing',
          admitted: true,
          current: 0,
          total: items.length,
        };
        accept(s, command, payload);
        let imageSignal = signal;
        await runManualPasteImages(
          items,
          signal,
          (source, acquiringSignal) => {
            imageSignal = acquiringSignal;
            return ports.pasteImages.acquire(
              s.sessionId,
              source,
              acquiringSignal,
            );
          },
          async (event) => {
            const candidate = s.candidates.find(
              (c) => c.candidateId === event.candidateId,
            );
            if (!candidate) return;
            s.pasteProgress!.current =
              items.findIndex((i) => i.candidateId === event.candidateId) + 1;
            if (
              event.type === 'ready' &&
              !signal.aborted &&
              !imageSignal.aborted
            ) {
              if (
                !ManualImageSchema.safeParse(event.image).success ||
                s.images.some((i) => i.imageToken === event.image.imageToken) ||
                s.images.length >= 200 ||
                s.images.reduce(
                  (n, i) => n + i.byteSize,
                  event.image.byteSize,
                ) >
                  200 * 1024 * 1024
              ) {
                candidate.state = 'failed';
                candidate.retryable = false;
                candidate.reason = 'IMAGE_LIMIT';
                s.revision++;
                return;
              }
              const next = { ...s, images: [...s.images, event.image] };
              if (!(await ports.retain(next)))
                throw new WebPasteFailure('RECOVERY_REQUIRED');
              if (signal.aborted) return;
              s.images = next.images;
              s.draft.blocks = s.draft.blocks.map((b) =>
                b.type === 'image-pending' &&
                b.candidateId === event.candidateId
                  ? {
                      type: 'image',
                      blockKey: b.blockKey,
                      imageToken: event.image.imageToken,
                    }
                  : b,
              );
              s.candidates = s.candidates.filter((c) => c !== candidate);
              session();
            } else if (event.type !== 'fetching') {
              candidate.state =
                event.type === 'cancelled' ? 'cancelled' : 'failed';
              candidate.retryable =
                (event.type === 'cancelled' ||
                  (event.type === 'failed' && event.retryable)) &&
                isPasteSource(
                  items.find((i) => i.candidateId === event.candidateId)
                    ?.source,
                );
              candidate.reason =
                event.type === 'cancelled'
                  ? 'CANCELLED'
                  : event.type === 'failed'
                    ? event.reason
                    : 'CANCELLED';
            } else candidate.state = 'fetching';
            s.revision++;
          },
        );
        summary.unresolved = items.filter((i) =>
          s.candidates.some((c) => c.candidateId === i.candidateId),
        ).length;
        summary.outcome = signal.aborted
          ? 'cancelled'
          : summary.unresolved
            ? 'partial'
            : 'completed';
      });
    },
    async insertManualImage(command, range) {
      if (!manualRequests.insertManualImage.safeParse([command, range]).success)
        return invalid();
      const payload = ['image', range];
      const denied = check(command, payload);
      if (denied) return denied;
      const s = session()!;
      reserve(s, command, payload);
      if (!rangeValid(s, range)) return invalid();
      if (s.images.length + s.candidates.length >= 200)
        return invalid(
          '本次编辑保留的图片已达上限，请先保存并结束编辑，再继续添加图片。',
        );
      return ports.run(s, 'image', async (signal) => {
        const image = await ports.chooseImage(s.sessionId, signal);
        signal.throwIfAborted();
        if (!image) return;
        if (
          !ManualImageSchema.safeParse(image).success ||
          s.images.some((i) => i.imageToken === image.imageToken) ||
          s.images.length + s.candidates.length >= 200 ||
          s.images.reduce((n, i) => n + i.byteSize, image.byteSize) >
            200 * 1024 * 1024
        )
          throw new WebPasteFailure('IMAGE_LIMIT');
        const proposal = spliceManualRange(
          s.draft,
          range,
          {
            version: 2,
            openStart: false,
            openEnd: false,
            blocks: [
              {
                type: 'image',
                blockKey: ports.newId(),
                imageToken: image.imageToken,
              },
            ],
          },
          ports.newId,
        );
        if (
          proposal.blocks.filter(isManualImageBlock).length >
          Math.max(200, s.draft.blocks.filter(isManualImageBlock).length)
        )
          throw new WebPasteFailure('INPUT_LIMIT');
        await acceptDraft(s, proposal, [...s.images, image], signal);
        accept(s, command, payload);
      });
    },
    async commitManualDocument(command) {
      return commit(command);
    },
    async closeManualEditor(command, choice) {
      if (
        !manualRequests.closeManualEditor.safeParse([command, choice]).success
      )
        return invalid();
      const payload = ['close', choice];
      const denied = check(command, payload);
      if (denied) return denied;
      const s = session()!;
      if (choice === 'keep') {
        accept(s, command, payload);
        return ports.reply('ok');
      }
      if (choice === 'save') {
        const result = commit(
          {
            sessionId: s.sessionId,
            expectedDocumentRevision: s.documentRevision,
            expectedCoverDraftRevision: s.cover?.draftRevision,
            operationId: s.nextSaveOperationId,
          },
          true,
        );
        if (result.status === 'started') accept(s, command, payload);
        return ports.reply(result.status);
      }
      return ports.mutate(async () => {
        s.state = 'stopping';
        s.operationKind = 'close';
        s.revision++;
        if (!(await ports.release(s))) return ports.reply('unavailable');
        ports.replace({ state: 'idle', revision: s.revision + 1 });
        return ports.reply('ok');
      });
    },
    async copyManualSelection(command, range, cut) {
      if (
        !manualRequests.copyManualSelection.safeParse([command, range, cut])
          .success
      )
        return invalid();
      const payload = ['copy', range, cut];
      const denied = check(command, payload);
      if (denied) return denied;
      const s = session()!;
      if (!ports.services) return ports.reply('unavailable');
      reserve(s, command, payload);
      let selected: ManualFragmentV2, proposal: ManualDraft;
      try {
        selected = selectManualRange(s.draft, range);
        proposal = cut
          ? spliceManualRange(
              s.draft,
              range,
              { version: 2, blocks: [], openStart: false, openEnd: false },
              ports.newId,
            )
          : s.draft;
      } catch {
        return invalid();
      }
      const revision = s.documentRevision;
      return ports.run(s, 'copy', async (signal) => {
        await ports.services!.clipboard.copy(
          s.sessionId,
          selected,
          s.images,
          signal,
        );
        signal.throwIfAborted();
        if (ports.current() !== s || s.documentRevision !== revision)
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        if (cut) await acceptDraft(s, proposal, s.images, signal);
        accept(s, command, payload);
      });
    },
    async getManualSaveResult(sessionId, operationId) {
      if (
        !manualRequests.getManualSaveResult.safeParse([sessionId, operationId])
          .success
      )
        return { status: 'unavailable', operationId };
      const s = session(),
        original = saves.get(operationId);
      if (
        s?.sessionId === sessionId &&
        rejectedSaves.get(operationId)?.sessionId === sessionId
      ) {
        if (
          rejectedSaves.get(operationId)?.status === 'conflict' &&
          s.target.kind === 'existing' &&
          ports.services
        ) {
          try {
            const current = ports.services.loadEditableArticle(
              s.target.articleKey,
            );
            if (
              current &&
              current.articleRevision > s.target.baseArticleRevision &&
              current.article.externalId === s.target.externalId &&
              current.article.importId === s.target.importId
            )
              ports.verifyConflictDiscard();
          } catch {
            ports.blocked();
            return { status: 'unavailable', operationId };
          }
        }
        return { status: 'not_started', operationId };
      }
      if (
        s?.sessionId === sessionId &&
        s.nextSaveOperationId === operationId &&
        !original
      )
        return { status: 'not_started', operationId };
      if (
        !s ||
        s.sessionId !== sessionId ||
        original?.sessionId !== sessionId ||
        !ports.services
      )
        return { status: 'unavailable', operationId };
      let result: SaveLookup;
      try {
        result = await ports.services.getSaveResult(operationId);
      } catch {
        ports.blocked();
        return { status: 'unavailable', operationId };
      }
      if (result.status === 'unavailable' || result.status === 'needs_review')
        ports.blocked();
      if (
        result.status === 'committed' &&
        (result.receipt.sessionId !== sessionId ||
          result.receipt.payloadDigest !== original.payloadDigest)
      ) {
        ports.blocked();
        return { status: 'needs_review', operationId };
      }
      if (
        result.status === 'committed' &&
        s.saveOutcome?.operationId === operationId
      ) {
        let current: EditableArticle | undefined;
        try {
          current = ports.services.loadEditableArticle(
            result.receipt.articleKey,
          );
        } catch {
          ports.blocked();
          return { status: 'unavailable', operationId };
        }
        if (
          current &&
          current.articleRevision >= result.receipt.articleRevision &&
          current.article.externalId === s.externalId &&
          s.saveOutcome.articleRevision === result.receipt.articleRevision
        )
          ports.verifyConflictDiscard();
      }
      return result;
    },
    async respondManualClose(requestId, sessionId, documentRevision, status) {
      if (
        !manualRequests.respondManualClose.safeParse([
          requestId,
          sessionId,
          documentRevision,
          status,
        ]).success
      )
        return invalid();
      const s = session();
      if (
        !s ||
        s.sessionId !== sessionId ||
        s.documentRevision !== documentRevision ||
        !ports.services?.respondClose(
          requestId,
          sessionId,
          documentRevision,
          status,
        )
      )
        return ports.reply('conflict');
      return ports.reply('ok');
    },
  };
}

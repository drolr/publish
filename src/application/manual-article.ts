import {
  ImageResultSchema,
  type ImageResult,
  type ImportOutcome,
} from '../contracts/article-library';
import { validateArticlePackage } from '../contracts/article-package';
import {
  ignoredMetadataWarning,
  mapIssues,
} from '../contracts/article-package-errors';
import {
  ManualDraftSchema,
  ManualImageSchema,
  type ManualDraft,
  type ManualImage,
  type ManualReply,
  type ManualState,
  manualRequests,
} from '../contracts/manual-article';
import type {
  PasteCommand,
  WebPasteInput,
  PasteErrorCode,
  PasteSummary,
} from '../contracts/web-paste';
import type { ManualPasteControllerPorts } from '../domain/ports/web-paste';
import { WebPasteFailure } from '../domain/web-paste-error';
import {
  manualArticleInput,
  type ManualSession,
} from './manual-article-mapper';
import { admitManualPaste } from './manual-paste-admission';
import {
  runManualPasteImages,
  isPasteSource,
  type PasteImageEvent,
  type PasteRunItem,
} from './manual-paste-runner';
import {
  ImportFailure,
  importMessages,
  type ImportErrorCode,
} from '../domain/import-error';
import type { ImportResult } from './article-import';
import {
  createManualDocumentCommands,
  type ManualDocumentServices,
  ManualVersionConflict,
} from './manual-document-commands';
import type { ManualOperationKind } from '../contracts/manual-edit';

export interface ManualArticleControllerPorts extends ManualPasteControllerPorts {
  newId(): string;
  externalExists(id: string): boolean;
  gate(): 'ready' | 'busy' | 'unavailable';
  flushForRestart?(): Promise<boolean>;
  editGate?(): 'ready' | 'busy' | 'unavailable';
  closeGate?(): 'ready' | 'busy' | 'unavailable';
  chooseImage(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ManualImage | undefined>;
  readImage(
    sessionId: string,
    imageToken: string,
    signal: AbortSignal,
  ): Promise<{ mime: string; bytes: Uint8Array }>;
  retainImages(
    sessionId: string,
    tokens: readonly string[],
    options?: { preserveHistory: boolean },
  ): Promise<void>;
  documents?: ManualDocumentServices;
  releaseImages(sessionId: string): Promise<void>;
  save(
    input: unknown,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ImportResult>;
}
type Session = ManualSession;
type Issues = NonNullable<Session['issues']>;
const isSession = (state: ManualState): state is Session =>
  'sessionId' in state;
function failure(code: ImportErrorCode): ImportOutcome {
  return { status: 'failed', code, message: importMessages[code] };
}
function outcome(result: ImportResult): ImportOutcome {
  switch (result.status) {
    case 'imported':
      return {
        status: 'imported',
        articleKey: result.article.articleKey,
        title: result.article.title,
        warnings: result.warnings.length
          ? [ignoredMetadataWarning.message]
          : [],
      };
    // A collision is not evidence that this editing session committed an article.
    case 'already_exists':
    case 'already_deleted':
      return failure('STORAGE_UNAVAILABLE');
    case 'cancelled':
      return { status: 'cancelled' };
    case 'failed':
      return {
        ...failure(result.code),
        ...(Number.isInteger(result.imageIndex) &&
        result.imageIndex! >= 0 &&
        result.imageIndex! < 200
          ? { imageIndex: result.imageIndex }
          : {}),
      };
    case 'invalid':
      return {
        status: 'invalid',
        issues: result.issues.slice(0, 50).map((issue) => {
          const safe = mapIssues([
            {
              code: 'custom',
              path: [],
              params: { contractCode: issue.code },
              message: '',
            },
          ])[0];
          const [field, index] = issue.path;
          const position =
            field === 'title'
              ? '标题'
              : typeof index === 'number' &&
                  Number.isSafeInteger(index) &&
                  index >= 0
                ? field === 'body'
                  ? `第 ${index + 1} 个内容块`
                  : field === 'images'
                    ? `第 ${index + 1} 张图片`
                    : undefined
                : field === 'body'
                  ? '正文'
                  : undefined;
          return { message: safe.message, ...(position ? { position } : {}) };
        }),
      };
  }
}
export function createManualArticleController(
  ports: ManualArticleControllerPorts,
) {
  let current: ManualState = { state: 'idle', revision: 0 };
  let mutation: Promise<void> | undefined;
  let closing = false;
  let restarting: Promise<void> | undefined;
  let restartFlush = false;
  let shutdownSettlement: Promise<void> | undefined;
  let blocked = false;
  let continuous = false;
  let trustedClose = false;
  let releaseDocumentCompatibility: (sessionId: string) => void = () => {};
  let knownVersionConflict = false,
    verifiedConflictDiscard = false,
    resourcesSettled = true;
  const sources = new Map<string, string>();
  let initialBlock: string | undefined;
  let lastPaste:
    (PasteCommand & { fingerprint: string; jobId: string }) | undefined;
  let active:
    | {
        jobId: string;
        kind: 'selecting' | 'saving' | 'pasting' | 'retrying';
        abort: AbortController;
        settled: Promise<void>;
      }
    | undefined;
  let reading:
    { abort: AbortController; settled: Promise<ImageResult> } | undefined;
  let lastSave:
    { sessionId: string; revision: number; jobId: string } | undefined;
  const snapshot = (): ManualState => structuredClone(current);
  const reply = (status: ManualReply['status']): ManualReply => ({
    status,
    snapshot: snapshot(),
  });
  function gate(): 'ready' | 'busy' | 'unavailable' {
    if (closing || blocked || restarting) return 'unavailable';
    try {
      return trustedClose && ports.closeGate ? ports.closeGate() : ports.gate();
    } catch {
      return 'unavailable';
    }
  }
  function markBlocked() {
    blocked = true;
    knownVersionConflict = false;
    verifiedConflictDiscard = false;
    if (isSession(current)) {
      if (current.result?.status !== 'imported' && !current.saveOutcome)
        current.result = failure('RECOVERY_REQUIRED');
      current.issues = [{ message: importMessages.RECOVERY_REQUIRED }];
    }
  }
  async function retain(session: Session): Promise<boolean> {
    try {
      const tokens = session.images.map((image) => image.imageToken);
      if (continuous)
        await ports.retainImages(session.sessionId, tokens, {
          preserveHistory: true,
        });
      else await ports.retainImages(session.sessionId, tokens);
      return true;
    } catch {
      markBlocked();
      return false;
    }
  }
  async function release(session: Session): Promise<boolean> {
    reading?.abort.abort();
    try {
      releaseDocumentCompatibility(session.sessionId);
      await ports.releaseImages(session.sessionId);
      return true;
    } catch {
      markBlocked();
      return false;
    }
  }
  function assertActiveSession(session: Session, jobId: string): void {
    // A reserved writer cannot outlive fatal closure discovered by an awaited
    // preview. Check recovery/binding before the caller handles cancellation.
    if (
      blocked ||
      current !== session ||
      session.jobId !== jobId ||
      active?.jobId !== jobId
    )
      throw new WebPasteFailure('RECOVERY_REQUIRED');
  }
  function check(sessionId: string, revision: number): ManualReply | undefined {
    const ready = gate();
    if (ready !== 'ready') return reply(ready);
    if (!isSession(current) || current.sessionId !== sessionId)
      return reply('unavailable');
    if (active || mutation) return reply('busy');
    if (current.state === 'finished') return reply('unavailable');
    if (current.revision !== revision) return reply('conflict');
    return undefined;
  }
  function mutate(operation: () => Promise<ManualReply>): Promise<ManualReply> {
    let done!: () => void;
    mutation = new Promise<void>((resolve) => {
      done = resolve;
    });
    return operation().finally(() => {
      mutation = undefined;
      done();
    });
  }
  function invalid(issues: Issues): ManualReply {
    // Rejected input is never acknowledged or substituted for the saved draft.
    const result = reply('invalid');
    if (isSession(result.snapshot)) result.snapshot.issues = issues;
    return result;
  }
  async function settle(
    session: Session,
    result?: ImportOutcome,
  ): Promise<void> {
    session.revision++;
    if (result?.status === 'imported') {
      // Commit evidence is canonical immediately; cleanup still owns the writer.
      session.result = result;
      session.dirty = false;
      delete session.issues;
      await release(session);
      session.state = 'finished';
      session.revision++;
      return;
    }
    session.state = 'editing';
    if (result) {
      session.result = result;
      if (result.status === 'invalid') session.issues = result.issues;
      else if (result.status === 'failed')
        session.issues = [{ message: result.message }];
      else delete session.issues;
    }
    if (result?.status === 'failed' && result.code === 'RECOVERY_REQUIRED')
      blocked = true;
  }
  function start(session: Session, kind: 'selecting' | 'saving'): ManualReply {
    const jobId = ports.newId();
    const abort = new AbortController();
    const previousRead = reading;
    previousRead?.abort.abort();
    if (kind === 'saving')
      lastSave = {
        sessionId: session.sessionId,
        revision: session.revision,
        jobId,
      };
    session.state = kind;
    session.jobId = jobId;
    session.revision++;
    delete session.issues;
    delete session.result;
    const frozen = kind === 'saving' ? manualArticleInput(session) : undefined;
    const settled = Promise.resolve().then(async () => {
      try {
        // The image capability allows one physical read. Settle preview before
        // opening a picker or asking the import service to consume image bytes.
        if (previousRead) await previousRead.settled;
        assertActiveSession(session, jobId);
        if (kind === 'selecting') {
          const selected = abort.signal.aborted
            ? undefined
            : await ports.chooseImage(session.sessionId, abort.signal);
          let result: ImportOutcome | undefined;
          let next = session;
          if (selected && !abort.signal.aborted) {
            const parsed = ManualImageSchema.safeParse(selected);
            if (!parsed.success) result = failure('IMAGE_INVALID');
            else if (
              session.images.some(
                (image) => image.imageToken === selected.imageToken,
              ) ||
              session.images.length >= 200 ||
              session.images.reduce((sum, image) => sum + image.byteSize, 0) +
                selected.byteSize >
                200 * 1024 * 1024
            )
              result = failure('IMAGE_LIMIT_EXCEEDED');
            else {
              const nextDraft = {
                ...session.draft,
                blocks: [
                  ...session.draft.blocks,
                  {
                    blockKey: ports.newId(),
                    type: 'image' as const,
                    imageToken: parsed.data.imageToken,
                  },
                ],
              };
              const draft = ManualDraftSchema.safeParse(nextDraft);
              if (!draft.success)
                result = {
                  status: 'invalid',
                  issues: [
                    { message: '文章内容超出当前支持范围，请减少后重试。' },
                  ],
                };
              else {
                next = {
                  ...session,
                  draft: draft.data,
                  images: [...session.images, parsed.data],
                  dirty: true,
                };
              }
            }
          }
          if (!(await retain(next))) result = failure('RECOVERY_REQUIRED');
          else if (abort.signal.aborted) {
            result = (await retain(session))
              ? { status: 'cancelled' }
              : failure('RECOVERY_REQUIRED');
          } else {
            documents.confirmLegacyDocument(
              session,
              next.draft,
              next.images,
              session.candidates,
              continuous,
            );
          }
          await settle(session, result);
        } else {
          let result: ImportOutcome;
          if (abort.signal.aborted) result = { status: 'cancelled' };
          else {
            const checked = validateArticlePackage(frozen);
            result = outcome(
              checked.ok
                ? await ports.save(
                    checked.article,
                    session.sessionId,
                    abort.signal,
                  )
                : { status: 'invalid', issues: checked.issues },
            );
          }
          await settle(session, result);
        }
      } catch (error) {
        if (kind === 'saving') {
          // An unexpected rejection provides no trustworthy evidence about commit/cleanup.
          await settle(session, failure('RECOVERY_REQUIRED'));
        } else {
          const clean = await retain(session);
          await settle(
            session,
            !clean ||
              blocked ||
              (error instanceof WebPasteFailure &&
                error.code === 'RECOVERY_REQUIRED')
              ? failure('RECOVERY_REQUIRED')
              : abort.signal.aborted
                ? { status: 'cancelled' }
                : failure(
                    error instanceof ImportFailure
                      ? error.code
                      : 'IMAGE_UNAVAILABLE',
                  ),
          );
        }
      } finally {
        if (continuous) {
          try {
            await ports.retainImages(
              session.sessionId,
              session.images.map((i) => i.imageToken),
            );
          } catch {
            markBlocked();
          }
          delete session.jobId;
        }
        active = undefined;
      }
    });
    active = { jobId, kind, abort, settled };
    return reply('started');
  }
  function cancelManualOperation(
    sessionId: string,
    jobId: string,
  ): ManualReply {
    if (!isSession(current) || current.sessionId !== sessionId)
      return reply('unavailable');
    if (active?.jobId === jobId && current.state !== 'stopping') {
      current.state = 'stopping';
      current.revision++;
      active.abort.abort();
    }
    return reply('ok');
  }
  function pasteCommandCheck(
    command: PasteCommand,
    fingerprint: string,
  ): ManualReply | undefined {
    if (!isSession(current) || current.sessionId !== command.sessionId)
      return reply('conflict');
    if (lastPaste?.commandId === command.commandId) {
      return reply(
        lastPaste.expectedRevision === command.expectedRevision &&
          lastPaste.fingerprint === fingerprint
          ? 'ok'
          : 'conflict',
      );
    }
    if (
      current.nextPasteCommandId !== command.commandId ||
      current.revision !== command.expectedRevision
    )
      return reply('conflict');
    return check(command.sessionId, command.expectedRevision);
  }
  function startPaste(
    session: Session,
    command: PasteCommand,
    fingerprint: string,
    input?: WebPasteInput,
    candidateId?: string,
  ): ManualReply {
    const jobId = ports.newId();
    const nextToken = ports.newId();
    const abort = new AbortController();
    const kind = input ? 'paste' : 'retry';
    const previousRead = reading;
    previousRead?.abort.abort();
    lastPaste = { ...command, fingerprint, jobId };
    session.nextPasteCommandId = nextToken;
    session.state = kind === 'paste' ? 'pasting' : 'retrying';
    session.jobId = jobId;
    session.revision++;
    delete session.issues;
    delete session.result;
    delete session.pasteSummary;
    session.pasteProgress = {
      jobId,
      kind,
      phase: input ? 'parsing' : 'images',
      admitted: !input,
      current: 0,
      total: input ? 0 : 1,
    };
    const summary: PasteSummary = {
      jobId,
      kind,
      outcome: 'rejected',
      admitted: !input,
      paragraphs: 0,
      imagePositions: input ? 0 : 1,
      unresolved: 0,
      plainOnly: false,
    };
    const settled = Promise.resolve().then(async () => {
      let items: PasteRunItem[] = input
        ? []
        : [{ candidateId: candidateId!, source: sources.get(candidateId!) }];
      let imageSignal = abort.signal;
      const applyEvent = async (event: PasteImageEvent): Promise<void> => {
        if (current !== session || session.jobId !== jobId)
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        const candidate = session.candidates.find(
          (c) => c.candidateId === event.candidateId,
        );
        const block = session.draft.blocks.find(
          (b) =>
            b.type === 'image-pending' &&
            b.candidateId === event.candidateId &&
            b.blockKey === candidate?.blockKey,
        );
        // Even a late authorization must settle its storage ownership before the
        // operation releases the writer. No late ready enters the snapshot.
        if (event.type === 'ready') {
          if (
            !candidate ||
            !block ||
            imageSignal.aborted ||
            abort.signal.aborted
          ) {
            if (!(await retain(session)))
              throw new WebPasteFailure('RECOVERY_REQUIRED');
            return;
          }
          const parsed = ManualImageSchema.safeParse(event.image);
          let reason: PasteErrorCode | undefined;
          if (!parsed.success) reason = 'IMAGE_INVALID';
          else if (
            session.images.some((i) => i.imageToken === parsed.data.imageToken)
          )
            throw new WebPasteFailure('RECOVERY_REQUIRED');
          else if (
            session.images.reduce((sum, i) => sum + i.byteSize, 0) +
              parsed.data.byteSize >
            200 * 1024 * 1024
          )
            reason = 'IMAGE_LIMIT';
          if (reason) {
            if (!(await retain(session)))
              throw new WebPasteFailure('RECOVERY_REQUIRED');
            candidate.state = 'failed';
            candidate.reason = reason;
            candidate.retryable = false;
            sources.delete(candidate.candidateId);
          } else if (parsed.success) {
            const next: Session = {
              ...session,
              images: [...session.images, parsed.data],
            };
            if (!(await retain(next)))
              throw new WebPasteFailure('RECOVERY_REQUIRED');
            if (imageSignal.aborted || abort.signal.aborted) {
              if (!(await retain(session)))
                throw new WebPasteFailure('RECOVERY_REQUIRED');
              return;
            }
            session.images = next.images;
            session.draft.blocks = session.draft.blocks.map((b) =>
              b === block
                ? {
                    blockKey: b.blockKey,
                    type: 'image',
                    imageToken: parsed.data.imageToken,
                  }
                : b,
            );
            session.candidates = session.candidates.filter(
              (c) => c !== candidate,
            );
            sources.delete(candidate.candidateId);
          }
        } else {
          if (!candidate || !block) return;
          if (event.type === 'fetching') {
            candidate.state = 'fetching';
            candidate.retryable = false;
            delete candidate.reason;
            session.pasteProgress!.current =
              items.findIndex((i) => i.candidateId === event.candidateId) + 1;
          } else {
            candidate.state =
              event.type === 'cancelled' ? 'cancelled' : 'failed';
            candidate.reason =
              event.type === 'cancelled' ? 'CANCELLED' : event.reason;
            candidate.retryable =
              isPasteSource(sources.get(candidate.candidateId)) &&
              (event.type === 'cancelled' || event.retryable);
            if (!candidate.retryable) sources.delete(candidate.candidateId);
          }
        }
        session.revision++;
      };
      try {
        if (previousRead) await previousRead.settled;
        assertActiveSession(session, jobId);
        if (input) {
          if (abort.signal.aborted) throw new WebPasteFailure('CANCELLED');
          const converted = await ports.converter.convert(input, abort.signal);
          input = undefined;
          assertActiveSession(session, jobId);
          if (abort.signal.aborted) throw new WebPasteFailure('CANCELLED');
          const admitted = admitManualPaste(
            session,
            converted,
            initialBlock,
            ports.newId,
            undefined,
            continuous,
          );
          documents.confirmLegacyDocument(
            session,
            admitted.draft,
            session.images,
            [...session.candidates, ...admitted.candidates],
            continuous,
          );
          items = admitted.items;
          for (const item of items)
            if (item.source !== undefined)
              sources.set(item.candidateId, item.source);
          session.dirty = true;
          session.revision++;
          initialBlock = undefined;
          Object.assign(summary, {
            admitted: true,
            paragraphs: admitted.paragraphs,
            imagePositions: items.length,
            plainOnly: admitted.plainOnly,
          });
          session.pasteProgress = {
            jobId,
            kind,
            phase: 'images',
            admitted: true,
            current: 0,
            total: items.length,
          };
        }
        await runManualPasteImages(
          items,
          abort.signal,
          (source, signal) => {
            assertActiveSession(session, jobId);
            imageSignal = signal;
            return ports.pasteImages.acquire(session.sessionId, source, signal);
          },
          applyEvent,
        );
        summary.unresolved = items.filter((item) =>
          session.candidates.some((c) => c.candidateId === item.candidateId),
        ).length;
        summary.outcome = abort.signal.aborted
          ? 'cancelled'
          : summary.unresolved
            ? 'partial'
            : 'completed';
        if (abort.signal.aborted) summary.reason = 'CANCELLED';
        else if (
          session.candidates.some(
            (c) =>
              items.some((i) => i.candidateId === c.candidateId) &&
              c.reason === 'OPERATION_TIMEOUT',
          )
        )
          summary.reason = 'OPERATION_TIMEOUT';
      } catch (error) {
        const reason =
          error instanceof WebPasteFailure ? error.code : 'RECOVERY_REQUIRED';
        summary.reason = reason;
        summary.outcome =
          reason === 'CANCELLED'
            ? 'cancelled'
            : summary.admitted
              ? 'partial'
              : 'rejected';
        summary.unresolved = items.filter((item) =>
          session.candidates.some((c) => c.candidateId === item.candidateId),
        ).length;
        if (reason === 'RECOVERY_REQUIRED') markBlocked();
      } finally {
        input = undefined;
        session.pasteSummary = summary;
        delete session.pasteProgress;
        session.state = 'editing';
        session.revision++;
        if (continuous) {
          try {
            await ports.retainImages(
              session.sessionId,
              session.images.map((i) => i.imageToken),
            );
          } catch {
            markBlocked();
          }
          delete session.jobId;
        }
        active = undefined;
      }
    });
    active = { jobId, kind: input ? 'pasting' : 'retrying', abort, settled };
    return reply('started');
  }
  const documents = createManualDocumentCommands({
    ...ports,
    services: ports.documents,
    current: () => current,
    replace: (state) => {
      if (
        state.state === 'idle' &&
        knownVersionConflict &&
        verifiedConflictDiscard &&
        resourcesSettled
      ) {
        blocked = false;
        knownVersionConflict = false;
        verifiedConflictDiscard = false;
      }
      current = state;
      continuous = true;
    },
    reply,
    gate,
    editGate: () => {
      if (closing || blocked || (restarting && !restartFlush))
        return 'unavailable';
      try {
        return ports.editGate
          ? ports.editGate()
          : restartFlush
            ? ports.gate()
            : gate();
      } catch {
        return 'unavailable';
      }
    },
    discardGate: () => {
      if (
        closing ||
        (blocked &&
          !(
            knownVersionConflict &&
            verifiedConflictDiscard &&
            resourcesSettled
          ))
      )
        return 'unavailable';
      try {
        return trustedClose && ports.closeGate
          ? ports.closeGate()
          : ports.gate();
      } catch {
        return 'unavailable';
      }
    },
    verifyConflictDiscard: () => {
      if (
        !knownVersionConflict ||
        !resourcesSettled ||
        active ||
        mutation ||
        reading
      )
        return false;
      try {
        if ((ports.closeGate ? ports.closeGate() : ports.gate()) !== 'ready')
          return false;
      } catch {
        return false;
      }
      verifiedConflictDiscard = true;
      return true;
    },
    versionConflict: () => {
      markBlocked();
      knownVersionConflict = true;
      if (isSession(current))
        current.issues = [
          {
            message:
              '文章已由其他操作更新，当前编辑内容已保留。请核对保存结果后放弃当前编辑，再重新打开文章。',
          },
        ];
    },
    busy: () => !!(active || mutation),
    blocked: markBlocked,
    mutate: (operation) => {
      continuous = true;
      return mutate(operation);
    },
    retain,
    release,
    rememberPasteItems: (items) => {
      for (const item of items)
        if (item.source !== undefined)
          sources.set(item.candidateId, item.source);
    },
    onSessionRelease: (listener) => {
      releaseDocumentCompatibility = listener;
    },
    run(
      session: Session,
      kind: ManualOperationKind,
      operation: (signal: AbortSignal) => Promise<void>,
    ): ManualReply {
      continuous = true;
      resourcesSettled = false;
      const jobId = ports.newId(),
        abort = new AbortController();
      const previousRead = reading;
      previousRead?.abort.abort();
      const state =
        kind === 'save' ? 'saving' : kind === 'paste' ? 'pasting' : 'selecting';
      session.state = state;
      session.operationKind = kind;
      session.jobId = jobId;
      if (kind === 'paste')
        session.pasteProgress = {
          jobId,
          kind: 'paste',
          phase: 'parsing',
          admitted: false,
          current: 0,
          total: 0,
        };
      session.revision++;
      delete session.issues;
      delete session.result;
      const settled = Promise.resolve().then(async () => {
        try {
          if (previousRead) await previousRead.settled;
          assertActiveSession(session, jobId);
          await operation(abort.signal);
        } catch (error) {
          if (error instanceof ManualVersionConflict) {
            markBlocked();
            knownVersionConflict = true;
            session.issues = [
              {
                message:
                  '文章已由其他操作更新，当前编辑内容已保留。请核对保存结果后放弃当前编辑，再重新打开文章。',
              },
            ];
          } else if (
            (error instanceof WebPasteFailure ||
              error instanceof ImportFailure) &&
            error.code === 'RECOVERY_REQUIRED'
          )
            markBlocked();
          else if (abort.signal.aborted && kind !== 'save' && kind !== 'open') {
            /* Known cancellation after the owned operation settled. */
          } else if (
            kind === 'open' ||
            (!(error instanceof WebPasteFailure) &&
              !(error instanceof ImportFailure))
          )
            markBlocked();
          else if (error.code !== 'CANCELLED')
            session.issues = [
              {
                message:
                  error.code === 'IMAGE_LIMIT' ||
                  error.code === 'IMAGE_LIMIT_EXCEEDED'
                    ? kind === 'copy'
                      ? '复制图片所需资源暂时超出范围，请减少选区或稍后再试。'
                      : '本次编辑保留的图片已达上限，请先保存并结束编辑，再继续添加图片。'
                    : '本次操作未完成，内容和选区已保留，请检查后重试。',
              },
            ];
        } finally {
          // Session.images includes current AND confirmed history resources. Prune only
          // newly prepared capabilities which never entered either confirmed projection.
          try {
            await ports.retainImages(
              session.sessionId,
              session.images.map((i) => i.imageToken),
            );
            resourcesSettled = true;
          } catch {
            markBlocked();
          }
          if (current === session) {
            session.state = 'editing';
            session.revision++;
            delete session.operationKind;
            delete session.jobId;
            delete session.pasteProgress;
          }
          active = undefined;
        }
      });
      active = { jobId, kind: state, abort, settled };
      return reply('started');
    },
  });
  async function waitForSettlement(): Promise<void> {
    await Promise.all([active?.settled, mutation, reading?.settled]);
  }
  return {
    ...documents,
    canDiscardVerifiedConflict: () =>
      knownVersionConflict && verifiedConflictDiscard && resourcesSettled,
    async confirmManualEditorClose(
      choice: 'save' | 'discard' | 'keep',
    ): Promise<ManualReply> {
      if (!isSession(current) || active || mutation || trustedClose)
        return reply('busy');
      trustedClose = true;
      try {
        const result = await documents.closeManualEditor(
          {
            sessionId: current.sessionId,
            expectedDocumentRevision: current.documentRevision,
            clientSequence: current.nextClientSequence,
            commandId: current.nextEditCommandId,
          },
          choice,
        );
        if (result.status === 'started') await waitForSettlement();
        return reply(result.status);
      } finally {
        trustedClose = false;
      }
    },
    async startManualPaste(
      command: PasteCommand,
      input: WebPasteInput,
    ): Promise<ManualReply> {
      const parsed = manualRequests.startManualPaste.safeParse([
        command,
        input,
      ]);
      if (!parsed.success)
        return invalid([
          { message: '本次内容超出支持范围，请减少内容后再粘贴。' },
        ]);
      [command, input] = parsed.data;
      let fingerprint: string;
      try {
        fingerprint = ports.fingerprint(input);
      } catch {
        markBlocked();
        return reply('unavailable');
      }
      const denied = pasteCommandCheck(command, fingerprint);
      if (denied) return denied;
      if (!isSession(current)) return reply('conflict');
      return startPaste(current, command, fingerprint, input);
    },
    async retryManualPasteImage(
      command: PasteCommand,
      candidateId: string,
    ): Promise<ManualReply> {
      if (
        !manualRequests.retryManualPasteImage.safeParse([command, candidateId])
          .success
      )
        return invalid([{ message: '图片位置已失效，请重新检查。' }]);
      let fingerprint: string;
      try {
        fingerprint = ports.fingerprint({ candidateId });
      } catch {
        markBlocked();
        return reply('unavailable');
      }
      const denied = pasteCommandCheck(command, fingerprint);
      if (denied) return denied;
      if (!isSession(current)) return reply('conflict');
      const candidate = current.candidates.find(
        (c) => c.candidateId === candidateId,
      );
      if (!candidate?.retryable || !isPasteSource(sources.get(candidateId)))
        return invalid([
          { message: '该图片暂不支持重试，请移除该位置或重新复制。' },
        ]);
      return startPaste(current, command, fingerprint, undefined, candidateId);
    },
    getManualArticleState: snapshot,
    requestStop() {
      if (active && isSession(current))
        cancelManualOperation(current.sessionId, active.jobId);
      reading?.abort.abort();
    },
    hasSession: () => isSession(current) && current.state !== 'finished',
    hasUnsavedChanges: () =>
      isSession(current) && current.dirty && current.state !== 'finished',
    isActive: () =>
      restarting !== undefined ||
      active !== undefined ||
      mutation !== undefined ||
      reading !== undefined ||
      shutdownSettlement !== undefined,
    isBlocked: () => blocked,
    waitForSettlement,
    async beginManualArticle(): Promise<ManualReply> {
      const ready = gate();
      if (ready !== 'ready') return reply(ready);
      if (mutation || active) return reply('busy');
      if (isSession(current) && current.state !== 'finished')
        return reply('ok');
      try {
        const sessionId = ports.newId();
        let externalId = '';
        for (let n = 0; n < 8; n++) {
          const candidate = `manual-${ports.newId()}`;
          if (!ports.externalExists(candidate)) {
            externalId = candidate;
            break;
          }
        }
        if (!externalId) return reply('unavailable');
        current = {
          state: 'editing',
          revision: current.revision + 1,
          sessionId,
          externalId,
          target: { kind: 'new' },
          documentRevision: 0,
          acknowledgedEdit: null,
          nextEditCommandId: ports.newId(),
          nextClientSequence: 1,
          nextSaveOperationId: ports.newId(),
          draft: {
            title: '',
            contentDeclaration: 'repost',
            blocks: [{ blockKey: ports.newId(), type: 'paragraph', text: '' }],
          },
          images: [],
          candidates: [],
          nextPasteCommandId: ports.newId(),
          dirty: false,
        };
        lastSave = undefined;
        continuous = false;
        lastPaste = undefined;
        sources.clear();
        initialBlock = current.draft.blocks[0].blockKey;
        return reply('ok');
      } catch {
        return reply('unavailable');
      }
    },
    async updateManualDraft(
      sessionId: string,
      expectedRevision: number,
      draft: ManualDraft,
    ): Promise<ManualReply> {
      const denied = check(sessionId, expectedRevision);
      if (denied) return denied;
      if (!isSession(current)) return reply('unavailable');
      const parsed = ManualDraftSchema.safeParse(draft);
      if (!parsed.success)
        return invalid([
          { message: '文章内容格式不完整或超出当前支持范围，请检查后重试。' },
        ]);
      if (continuous) return documents.updateLegacyDocument(parsed.data);
      const tokens = new Set(
        parsed.data.blocks.flatMap((block) =>
          block.type === 'image' ? [block.imageToken] : [],
        ),
      );
      const availableImages = current.images;
      if (
        [...tokens].some(
          (token) =>
            !availableImages.some((image) => image.imageToken === token),
        )
      )
        return invalid([{ message: '图片已失效，请重新选择。' }]);
      const previous = current;
      if (
        parsed.data.blocks.some(
          (block) =>
            block.type === 'image-pending' &&
            !previous.draft.blocks.some(
              (known) =>
                known.type === 'image-pending' &&
                known.blockKey === block.blockKey &&
                known.candidateId === block.candidateId,
            ),
        )
      )
        return invalid([{ message: '图片位置已失效，请重新检查。' }]);
      // A pending block cannot be exchanged for an already-authorized image.
      if (
        parsed.data.blocks.some(
          (block) =>
            block.type === 'image' &&
            previous.draft.blocks.some(
              (known) =>
                known.blockKey === block.blockKey &&
                known.type === 'image-pending',
            ),
        )
      )
        return invalid([{ message: '图片位置已失效，请重新检查。' }]);
      const changed =
        JSON.stringify(previous.draft) !== JSON.stringify(parsed.data);
      const retainedCandidates = new Set(
        parsed.data.blocks.flatMap((block) =>
          block.type === 'image-pending' ? [block.candidateId] : [],
        ),
      );
      const next: Session = {
        ...previous,
        draft: parsed.data,
        images: continuous
          ? previous.images
          : previous.images.filter((image) => tokens.has(image.imageToken)),
        candidates: continuous
          ? previous.candidates
          : previous.candidates.filter((candidate) =>
              retainedCandidates.has(candidate.candidateId),
            ),
        dirty: previous.dirty || changed,
        revision: previous.revision + 1,
        documentRevision: previous.documentRevision + (changed ? 1 : 0),
      };
      delete next.issues;
      delete next.result;
      return mutate(async () => {
        reading?.abort.abort();
        if (!(await retain(next))) return reply('unavailable');
        if (!continuous)
          for (const id of sources.keys())
            if (!retainedCandidates.has(id)) sources.delete(id);
        if (
          initialBlock &&
          (parsed.data.blocks.length !== 1 ||
            !parsed.data.blocks.some(
              (b) =>
                b.blockKey === initialBlock &&
                b.type === 'paragraph' &&
                b.text === '',
            ))
        )
          initialBlock = undefined;
        current = next;
        if (changed) documents.invalidateLegacyTicket(next);
        return reply('ok');
      });
    },
    pickManualImage(sessionId: string, expectedRevision: number): ManualReply {
      const denied = check(sessionId, expectedRevision);
      if (denied) return denied;
      if (!isSession(current)) return reply('unavailable');
      if (
        current.draft.blocks.length >= 1000 ||
        current.images.length + current.candidates.length >= 200
      )
        return invalid([
          { message: '文章内容或图片数量超出当前支持范围，请减少后重试。' },
        ]);
      return start(current, 'selecting');
    },
    getManualImage(
      sessionId: string,
      imageToken: string,
    ): Promise<ImageResult> {
      const authorized = () =>
        !closing &&
        isSession(current) &&
        current.sessionId === sessionId &&
        current.state !== 'finished' &&
        current.images.some((image) => image.imageToken === imageToken);
      if (!authorized()) return Promise.resolve({ status: 'not_found' });
      if (reading || active || mutation)
        return Promise.resolve({ status: 'busy' });
      const abort = new AbortController();
      const settled = Promise.resolve().then(async (): Promise<ImageResult> => {
        try {
          if (!authorized() || abort.signal.aborted)
            return { status: 'not_found' };
          const value = await ports.readImage(
            sessionId,
            imageToken,
            abort.signal,
          );
          if (!authorized() || abort.signal.aborted)
            return { status: 'not_found' };
          const parsed = ImageResultSchema.safeParse({
            status: 'ok',
            ...value,
          });
          return parsed.success ? parsed.data : { status: 'unavailable' };
        } catch (error) {
          if (
            (error instanceof WebPasteFailure ||
              error instanceof ImportFailure) &&
            error.code === 'RECOVERY_REQUIRED'
          )
            markBlocked();
          return { status: 'unavailable' };
        } finally {
          reading = undefined;
        }
      });
      reading = { abort, settled };
      return settled;
    },
    saveManualArticle(
      sessionId: string,
      expectedRevision: number,
    ): ManualReply {
      if (
        isSession(current) &&
        (continuous || current.target.kind === 'existing')
      )
        return documents.commitLegacyDocument(sessionId, expectedRevision);
      // Replaying an acknowledged commit is read-only, including during another
      // writer's operation or shutdown. Only fresh saves must acquire the gate.
      if (
        isSession(current) &&
        current.sessionId === sessionId &&
        current.result?.status === 'imported' &&
        lastSave?.sessionId === sessionId &&
        (lastSave.revision === expectedRevision ||
          current.revision === expectedRevision)
      )
        return reply('ok');
      const denied = check(sessionId, expectedRevision);
      if (denied) return denied;
      if (!isSession(current)) return reply('unavailable');
      if (current.draft.blocks.some((block) => block.type === 'image-pending'))
        return invalid([{ message: '还有图片需要处理，请先完成或移除。' }]);
      return start(current, 'saving');
    },
    cancelManualOperation,
    async discardManualArticle(
      sessionId: string,
      expectedRevision: number,
    ): Promise<ManualReply> {
      const denied = check(sessionId, expectedRevision);
      if (denied) return denied;
      if (!isSession(current)) return reply('unavailable');
      const session = current;
      return mutate(async () => {
        if (!(await release(session))) return reply('unavailable');
        current = { state: 'idle', revision: session.revision + 1 };
        lastSave = undefined;
        lastPaste = undefined;
        initialBlock = undefined;
        sources.clear();
        return reply('ok');
      });
    },
    stopForRestart(): Promise<void> {
      if (restarting) return restarting;
      if (active && isSession(current))
        cancelManualOperation(current.sessionId, active.jobId);
      reading?.abort.abort();
      restarting = Promise.resolve()
        .then(async () => {
          await waitForSettlement();
          if (blocked || closing)
            throw new WebPasteFailure('RECOVERY_REQUIRED');
          if (isSession(current) && current.state !== 'finished') {
            // Main dirty=false cannot prove renderer title/IME input is synced.
            // Only the text synchronization lane opens for this main-owned proof.
            restartFlush = true;
            try {
              if (ports.flushForRestart && !(await ports.flushForRestart()))
                throw new WebPasteFailure('RECOVERY_REQUIRED');
            } finally {
              restartFlush = false;
            }
            if (current.dirty || blocked || current.state !== 'editing')
              throw new WebPasteFailure('RECOVERY_REQUIRED');
            if (!(await release(current)))
              throw new WebPasteFailure('RECOVERY_REQUIRED');
            current = { state: 'idle', revision: current.revision + 1 };
            sources.clear();
            lastSave = undefined;
            lastPaste = undefined;
            initialBlock = undefined;
          }
        })
        .finally(() => {
          restarting = undefined;
        });
      return restarting;
    },
    stopAndWait(): Promise<void> {
      if (shutdownSettlement) return shutdownSettlement;
      closing = true;
      const running = active;
      const read = reading;
      if (running && isSession(current))
        cancelManualOperation(current.sessionId, running.jobId);
      read?.abort.abort();
      shutdownSettlement = (async () => {
        await Promise.all([running?.settled, read?.settled, mutation]);
        // Unknown ownership from any awaited operation cannot authorize database close.
        if (blocked || (isSession(current) && !(await release(current))))
          throw new WebPasteFailure('RECOVERY_REQUIRED');
        sources.clear();
      })().finally(() => {
        shutdownSettlement = undefined;
      });
      return shutdownSettlement;
    },
  };
}

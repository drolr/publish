import {
  DraftContentCapabilitiesSchema,
  type DraftContentCapabilities,
} from '../../../contracts/draft-content';
import { checkContentSupport } from '../../../domain/draft-content';
import { verifyDraftSnapshotIntegrity } from '../../draft-snapshot-integrity';
import { richEvidenceKnown } from './rich-content-evidence';
import { JudongcheCoverRequiredError } from './production-state';
import { createHash } from 'node:crypto';
import {
  CoverReportSchema,
  reportMatchesSnapshot,
  type CoverReport,
} from '../../../contracts/cover-task';
import type { CoverUploadFile } from './cover-pages';
import {
  DraftEvidenceSchema,
  DraftTaskSchema,
  type AdapterOutcome,
  type DraftEvidence,
  type DraftTask,
  type ReasonCode,
} from '../../../contracts/draft-task';
import type {
  DraftPlatform,
  ExecutionHooks,
} from '../../../domain/ports/draft-task';

const diag = (event: string, data?: unknown) => {
  if (process.env.JUDONGCHE_DIAG !== '1') return;
  console.error('[jdc-adapter] ' + event + ' ' + JSON.stringify(data));
};
import { effectiveCoverPolicy } from '../../../domain/cover-task';
import { canCloseWithoutSave } from '../../../domain/draft-task';
import {
  BrowserSessionError,
  type BrowserSession,
} from '../../automation/browser-session';
import {
  matchesOperationContent,
  sameRemote,
  sameStore,
  validRemote,
  validEditorUrl,
  verifyEvidence,
  titleEditApplies,
  verifyAcknowledgedTitleEdit,
  verifyLocalCover,
  type EditorEvidence,
} from './content-evidence';
import {
  createJudongchePages,
  JudongchePageError,
  type JudongchePages,
  type JudongcheReadPages,
  type JudongchePageOptions,
} from './page-contract';
const blocked = (
  reason: ReasonCode,
): Extract<AdapterOutcome, { status: 'blocked' }> => ({
  status: 'blocked',
  reason,
});
const fail = (reason: ReasonCode): never => {
  throw new JudongchePageError(reason);
};
const reasonOf = (error: unknown, fallback: ReasonCode): ReasonCode =>
  error instanceof JudongchePageError || error instanceof BrowserSessionError
    ? error.reason
    : fallback;
async function checkStore(pages: JudongcheReadPages, task: DraftTask) {
  const probe = await pages.probe();
  if (probe.status === 'blocked') return fail(probe.reason);
  if (probe.status !== 'ready' || !sameStore(probe.store, task.store))
    fail('STORE_CHANGED');
  return probe;
}
// This function has no write capabilities, even when used after execute.
export async function reconcileWithPages(
  pages: JudongcheReadPages,
  task: DraftTask,
): Promise<AdapterOutcome> {
  const uncertain = (reason: ReasonCode): AdapterOutcome => ({
    ...blocked(reason),
    ...(task.coverPlan
      ? {
          coverReport:
            ['confirmed', 'failed'].includes(task.coverPlan.report.phase) ||
            (task.coverPlan.report.phase === 'needs_human' &&
              task.coverPlan.report.reason !== 'PAGE_UNVERIFIED')
              ? structuredClone(task.coverPlan.report)
              : {
                  ...task.coverPlan.report,
                  phase: 'needs_human' as const,
                  reason: 'PAGE_UNVERIFIED' as const,
                  updatedAt: new Date().toISOString(),
                },
        }
      : {}),
  });
  try {
    if (!task.evidence.remote) {
      await checkStore(pages, task);
      await pages.inspectDraftAbsence?.(task.snapshot.article.title);
      return uncertain('RESULT_AMBIGUOUS');
    }
    if (!task.evidence.remote || !validRemote(task.evidence.remote))
      return uncertain('RESULT_AMBIGUOUS');
    await checkStore(pages, task);
    const located = await pages.locateDraft(task.evidence.remote);
    if (!located || !sameRemote(located, task.evidence.remote))
      return uncertain('RESULT_AMBIGUOUS');
    await checkStore(pages, task);
    const observed =
      task.snapshot.version === 2
        ? await pages.inspectRichDraft?.(located)
        : await pages.inspectDraft(located);
    if (
      task.snapshot.version === 2 &&
      (!observed || !richEvidenceKnown(observed))
    )
      return uncertain('PAGE_CHANGED');
    await checkStore(pages, task);
    if (!observed) return uncertain('CONTENT_MISMATCH');
    const report =
      task.coverPlan && observed
        ? { coverReport: verifyLocalCover(task, observed) }
        : {};
    return observed && verifyEvidence(task, observed)
      ? {
          status: 'verified',
          evidence: structuredClone(task.evidence),
          ...report,
        }
      : { ...blocked('CONTENT_MISMATCH'), ...report };
  } catch (error) {
    return uncertain(reasonOf(error, 'RESULT_AMBIGUOUS'));
  }
}
/** Verified rich-text declaration for the production Judongche writer. */
const JUDONGCHE_CONTENT_CAPABILITIES: DraftContentCapabilities = {
  revision: 'judongche-rich-v1',
  features: {
    bold: 'verified',
    italic: 'verified',
    underline: 'verified',
    heading: 'verified',
    ordered_list: 'verified',
    bullet_list: 'verified',
    blockquote: 'verified',
  },
};
/** Internal infrastructure composition seam. createJudongcheAdapter forwards the
 * verified production declaration; tests may inject synthetic capabilities. */
export function createAdapterWithPages(
  session: BrowserSession,
  pages: JudongchePages,
  /** Capability declaration, injectable for synthetic infrastructure fixtures. */
  fixtureCapabilities?: DraftContentCapabilities,
): DraftPlatform {
  const capabilities = fixtureCapabilities
    ? DraftContentCapabilitiesSchema.parse(fixtureCapabilities)
    : { revision: 'judongche-rich-unknown-v1', features: {} };
  const attempted = new Set<string>();
  const continuationOwners = new Map<
    string,
    { generation: string; storeKey: string }
  >();
  let checkedSession:
    Awaited<ReturnType<JudongcheReadPages['probe']>> | undefined;
  const probe = async () => {
    checkedSession = await pages.probe();
    return checkedSession;
  };
  const reads: JudongcheReadPages = {
    probe,
    inspectEditor: () => pages.inspectEditor(),
    inspectRichEditor: pages.inspectRichEditor
      ? () => pages.inspectRichEditor!()
      : undefined,
    inspectRichDraft: pages.inspectRichDraft
      ? (ref) => pages.inspectRichDraft!(ref)
      : undefined,
    locateDraft: (ref) => pages.locateDraft(ref),
    inspectDraft: (ref) => pages.inspectDraft(ref),
    inspectDraftAbsence: pages.inspectDraftAbsence
      ? (title) => pages.inspectDraftAbsence!(title)
      : undefined,
  };
  const captureHandledTaskContinuation = (task: DraftTask) => {
    const generation = session.generation();
    const context = session.current();
    const owner = continuationOwners.get(task.taskId);
    if (!context || !generation) return fail('BROWSER_UNAVAILABLE');
    if (!owner || owner.generation !== generation) return fail('PAGE_CHANGED');
    if (owner.storeKey !== task.store.storeKey) return fail('STORE_CHANGED');
    if (!pages.captureHandledTaskContinuation) return fail('INPUT_UNSUPPORTED');
    const proceed = pages.captureHandledTaskContinuation(task.taskId);
    return async (cancelled: () => boolean) => {
      try {
        if (cancelled())
          return {
            status: 'blocked' as const,
            reason: 'STOP_REQUESTED' as const,
          };
        if (
          session.current() !== context ||
          session.generation() !== generation
        )
          return {
            status: 'blocked' as const,
            reason: 'PAGE_CHANGED' as const,
          };
        const value = await proceed(cancelled);
        if (cancelled())
          return {
            status: 'blocked' as const,
            reason: 'STOP_REQUESTED' as const,
          };
        if (
          session.current() !== context ||
          session.generation() !== generation ||
          (value.status === 'ready' && value.generation !== generation)
        )
          return {
            status: 'blocked' as const,
            reason: 'PAGE_CHANGED' as const,
          };
        if (value.status === 'ready' && !sameStore(value.store, task.store))
          return {
            status: 'blocked' as const,
            reason: 'STORE_CHANGED' as const,
          };
        checkedSession = value;
        return value;
      } catch (error) {
        return {
          status: 'blocked' as const,
          reason: reasonOf(error, 'PAGE_CHANGED'),
        };
      }
    };
  };
  return {
    contentCapabilities: () => structuredClone(capabilities),
    async openSession() {
      try {
        await session.open();
        return await probe();
      } catch (error) {
        return {
          status: 'blocked',
          reason: reasonOf(error, 'BROWSER_UNAVAILABLE'),
        };
      }
    },
    async checkSession(contextOnly = false) {
      if (
        contextOnly &&
        pages.manualReview &&
        pages.checkWritingContext &&
        checkedSession?.status === 'ready'
      ) {
        try {
          await pages.checkWritingContext(() => false);
          if (session.generation() !== checkedSession.generation)
            return { status: 'blocked', reason: 'PAGE_CHANGED' };
          return structuredClone(checkedSession);
        } catch (error) {
          return { status: 'blocked', reason: reasonOf(error, 'PAGE_CHANGED') };
        }
      }
      return probe();
    },
    closeSession: () => session.close(),
    bindTaskForContinuation(task, generation) {
      const existing = checkedSession;
      if (
        task.state !== 'queued' ||
        !session.current() ||
        session.generation() !== generation ||
        existing?.status !== 'ready' ||
        existing.generation !== generation
      )
        return fail('PAGE_CHANGED');
      if (!sameStore(existing.store, task.store)) fail('STORE_CHANGED');
      pages.bindTaskForContinuation?.(task.taskId, generation);
      continuationOwners.set(task.taskId, {
        generation,
        storeKey: task.store.storeKey,
      });
    },
    captureHandledTaskContinuation,
    async returnHomeAfterHandledTask(task, cancelled) {
      try {
        return await captureHandledTaskContinuation(task)(cancelled);
      } catch (error) {
        return { status: 'blocked', reason: reasonOf(error, 'PAGE_CHANGED') };
      }
    },
    async reconcile(task) {
      if (!pages.manualReview) return reconcileWithPages(reads, task);
      if (
        !(task.snapshot.version === 2
          ? pages.reviewRichSavedDraft
          : pages.reviewSavedDraft)
      )
        return blocked(
          task.snapshot.version === 2
            ? 'PAGE_CHANGED'
            : task.reason === 'MANUAL_REVIEW_REQUIRED'
              ? task.reason
              : 'RESULT_AMBIGUOUS',
        );
      try {
        if (
          !DraftTaskSchema.safeParse(task).success ||
          task.state !== 'needs_human' ||
          ![
            'MANUAL_REVIEW_REQUIRED',
            'CONTENT_MISMATCH',
            'RESULT_AMBIGUOUS',
          ].includes(task.reason ?? '') ||
          !task.saveAttempted ||
          !task.possibleRemoteEffect ||
          !task.holdsPlatform ||
          (task.reason === 'CONTENT_MISMATCH' &&
            !task.evidence.remote &&
            pages.confirmedDraftSave?.(
              task.taskId,
              task.snapshot.article.title,
            ) !== true)
        )
          fail('RESULT_AMBIGUOUS');
        // An uncertain task may be inspected, but only existing trusted save
        // acknowledgement can authorize association and settlement.
        const diagnosticOnly =
          task.reason === 'RESULT_AMBIGUOUS' &&
          pages.confirmedDraftSave?.(
            task.taskId,
            task.snapshot.article.title,
          ) !== true;
        const titleEdit = pages.acknowledgedTitleEdit;
        if (
          titleEdit &&
          (!titleEditApplies(task, titleEdit) ||
            pages.confirmedDraftSave?.(
              task.taskId,
              task.snapshot.article.title,
            ) !== true)
        )
          fail('RESULT_AMBIGUOUS');
        const readGeneration = session.generation();
        await checkStore(reads, task);
        const observed = await (
          task.snapshot.version === 2
            ? pages.reviewRichSavedDraft!
            : pages.reviewSavedDraft!
        )(task.taskId, task.snapshot.article.title, titleEdit?.editedTitle);
        if (session.generation() !== readGeneration) fail('PAGE_CHANGED');
        if (
          diagnosticOnly ||
          (task.reason === 'RESULT_AMBIGUOUS' &&
            pages.confirmedDraftSave?.(
              task.taskId,
              task.snapshot.article.title,
            ) !== true)
        )
          return blocked('RESULT_AMBIGUOUS');
        if (task.snapshot.version === 2 && !richEvidenceKnown(observed))
          fail('PAGE_CHANGED');
        const evidence = { ...task.evidence, remote: observed.remote };
        if (
          !evidence.remote ||
          !validRemote(evidence.remote) ||
          (task.evidence.remote &&
            !sameRemote(task.evidence.remote, evidence.remote))
        )
          fail('RESULT_AMBIGUOUS');
        const report = task.coverPlan
          ? { coverReport: verifyLocalCover({ ...task, evidence }, observed) }
          : {};
        const verified = titleEdit
          ? verifyAcknowledgedTitleEdit(
              { ...task, evidence },
              observed,
              titleEdit,
            )
          : verifyEvidence({ ...task, evidence }, observed);
        return verified
          ? {
              status: 'verified',
              evidence: structuredClone(evidence),
              ...report,
            }
          : { ...blocked('CONTENT_MISMATCH'), ...report };
      } catch (error) {
        return blocked(reasonOf(error, 'RESULT_AMBIGUOUS'));
      }
    },
    async checkAbsence(task) {
      // Closure proof must not depend on what the platform draft box contains:
      // the operator confirms the closure in the closure panel, and the local
      // task record (no save attempt, no remote evidence) is authoritative.
      try {
        if (
          !DraftTaskSchema.safeParse(task).success ||
          !canCloseWithoutSave(task)
        )
          return blocked('RESULT_AMBIGUOUS');
        const generation = session.generation();
        const before = await checkStore(reads, task);
        const after = await checkStore(reads, task);
        if (
          session.generation() !== generation ||
          before.generation !== after.generation
        )
          return blocked('PAGE_CHANGED');
        return {
          status: 'absent',
          proof: {
            taskId: task.taskId,
            revision: task.revision,
            snapshotDigest: task.snapshot.digest,
            storeKey: task.store.storeKey,
            generation: after.generation,
            checkedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        return blocked(reasonOf(error, 'RESULT_AMBIGUOUS'));
      }
    },
    async openVerified(task) {
      if (task.state !== 'draft_saved') fail('RESULT_AMBIGUOUS');
      const result = await reconcileWithPages(reads, task);
      if (result.status === 'blocked') fail(result.reason);
    },
    async execute(task, hooks) {
      // No V2 task reaches the writer without a capability declaration and a
      // snapshot whose rich semantics the adapter can reproduce exactly.
      if (task.snapshot.version === 2) {
        if (!fixtureCapabilities) return blocked('FORMAT_UNSUPPORTED');
        try {
          verifyDraftSnapshotIntegrity(task.snapshot);
        } catch {
          return blocked('INPUT_UNSUPPORTED');
        }
        if (
          !pages.appendTextBlock ||
          !pages.inspectRichEditor ||
          !pages.inspectRichDraft ||
          (pages.manualReview &&
            pages.automaticDraftReview &&
            !pages.reviewRichSavedDraft)
        )
          return blocked('PAGE_CHANGED');
        if (!checkContentSupport(task.snapshot.editorBody, capabilities).ok)
          return blocked('FORMAT_UNSUPPORTED');
        // The platform exposes no starting-number control: reject before any
        // block write so an unsupported list cannot leave a partial draft.
        if (
          task.snapshot.editorBody.blocks.some(
            (block) =>
              block.type === 'list' &&
              block.kind === 'ordered' &&
              block.start !== 1,
          )
        )
          return blocked('FORMAT_UNSUPPORTED');
      }
      const rich = task.snapshot.version === 2;
      const plainArticle =
        pages.writesOnEditorReady &&
        task.snapshot.version === 2 &&
        task.snapshot.editorBody.blocks.every(
          (b) =>
            b.type === 'image' ||
            (b.type === 'paragraph' &&
              b.content.every((run) => run.marks.length === 0)),
        );

      const inspect = async () => {
        const value = pages.inspectOperationEditor
          ? await pages.inspectOperationEditor()
          : rich
            ? await pages.inspectRichEditor!()
            : await pages.inspectEditor();
        if (
          !value.known ||
          !value.store ||
          !value.contextKey ||
          !value.editorUrl ||
          !validEditorUrl(value.editorUrl)
        )
          fail('PAGE_CHANGED');
        return value;
      };
      const review =
        task.snapshot.version === 2
          ? pages.reviewRichSavedDraft
          : pages.reviewSavedDraft;
      if (
        attempted.has(task.taskId) ||
        task.saveAttempted ||
        task.possibleRemoteEffect
      )
        return blocked('RESULT_AMBIGUOUS');
      attempted.add(task.taskId);
      const generation = session.generation();
      let saving = false;
      let saveContext: EditorEvidence | undefined;
      let evidence: DraftEvidence = structuredClone(task.evidence);
      let coverPlan = task.coverPlan
        ? structuredClone(task.coverPlan)
        : undefined;
      try {
        if (
          !DraftTaskSchema.safeParse(task).success ||
          task.state !== 'running' ||
          !['manual-after-draft', 'local-upload-v1'].includes(
            effectiveCoverPolicy(task),
          )
        )
          fail('INPUT_UNSUPPORTED');
        if (
          task.coverPlan &&
          task.coverPlan.snapshot.mode !== 'none' &&
          (pages.localCoverUpload !== 'supported' || !pages.uploadLocalCover)
        )
          fail('INPUT_UNSUPPORTED');
        const body =
          task.snapshot.version === 2
            ? task.snapshot.editorBody.blocks
            : task.snapshot.article.body;
        for (const block of body) {
          if (block.type === 'image') {
            const asset = task.snapshot.article.assets.find(
              (value) =>
                value.imageId ===
                ('imageId' in block ? block.imageId : block.image_id),
            );
            if (!asset) fail('ASSET_UNAVAILABLE');
            if (asset!.mime !== 'image/jpeg' && asset!.mime !== 'image/png')
              fail('IMAGE_FORMAT_UNSUPPORTED');
            if (asset!.byteSize > 10_000_000) fail('IMAGE_SIZE_UNSUPPORTED');
          }
        }
        const local = (): DraftTask => ({
          ...task,
          evidence,
          ...(coverPlan ? { coverPlan } : {}),
        });
        const stop = () => {
          if (task.stopRequested || hooks.stopped()) fail('STOP_REQUESTED');
        };
        let count = 0;
        let titleWritten = false;
        let context: EditorEvidence | null = null;
        const checkpointed = pages.manualReview && !!pages.checkWritingContext;
        const guard = async () => {
          stop();
          if (checkpointed) {
            await pages.checkWritingContext!(
              () => task.stopRequested || hooks.stopped(),
            );
            if (session.generation() !== generation) {
              diag('guard-generation', {
                at: 'checkWritingContext',
                generation,
                now: session.generation(),
              });
              fail('PAGE_CHANGED');
            }
            stop();
            if (
              !coverPlan ||
              (hooks.batchSubmissionReview === 'operator' &&
                pages.batchSubmissionReview === 'operator')
            )
              return;
          }
          await checkStore(reads, task);
          stop();
          if (session.generation() !== generation) {
            diag('guard-generation', {
              at: 'checkStore',
              generation,
              now: session.generation(),
            });
            fail('PAGE_CHANGED');
          }
          if (context) {
            const current = await inspect();
            stop();
            if (session.generation() !== generation) {
              diag('guard-generation', {
                at: 'inspect',
                generation,
                now: session.generation(),
              });
              fail('PAGE_CHANGED');
            }
            if (
              !current.known ||
              current.contextKey !== context.contextKey ||
              current.editorUrl !== context.editorUrl
            ) {
              diag('guard-inspect', {
                known: current.known,
                contextKey: current.contextKey,
                expectedContextKey: context.contextKey,
                editorUrl: current.editorUrl,
                expectedEditorUrl: context.editorUrl,
              });
              fail('PAGE_CHANGED');
            }
            if (!sameStore(current.store, task.store)) fail('STORE_CHANGED');
            if (current.remote) fail('CONTENT_MISMATCH');
            if (titleWritten) {
              if (!matchesOperationContent(local(), current, count))
                fail('CONTENT_MISMATCH');
            } else if (
              current.title !== '' ||
              current.blocks.length ||
              current.remote ||
              current.pendingUploads
            )
              fail('CONTENT_MISMATCH');
          }
          stop();
        };
        const effect = async (
          stage: Parameters<ExecutionHooks['checkpoint']>[0],
          action: () => Promise<void>,
          retainEvidence = false,
        ) => {
          diag('effect-start', { stage });
          await guard();
          diag('effect-checkpoint', { stage });
          await hooks.checkpoint(stage);
          await guard();
          diag('effect-action', { stage });
          await action();
          if (!retainEvidence) stop();
        };
        const persist = async (next: DraftEvidence) => {
          if (!DraftEvidenceSchema.safeParse(next).success)
            fail('CONTENT_MISMATCH');
          await hooks.evidence(structuredClone(next));
          evidence = structuredClone(next);
          stop();
        };
        if (checkpointed) {
          stop();
          await checkStore(reads, task);
          stop();
          if (session.generation() !== generation) fail('PAGE_CHANGED');
        }
        await effect('editor', () =>
          pages.enterNewEditor(
            task.snapshot.article.title,
            () => task.stopRequested || hooks.stopped(),
            task.taskId,
            hooks.batchSubmissionReview === 'operator',
          ),
        );
        if (!pages.writesOnEditorReady) {
          context = await inspect();
          stop();
          if (
            !context.known ||
            !context.contextKey ||
            !context.editorUrl ||
            !validEditorUrl(context.editorUrl)
          )
            fail('PAGE_CHANGED');
          if (
            checkpointed &&
            (context.title ||
              context.blocks.length ||
              context.remote ||
              context.pendingUploads ||
              !sameStore(context.store, task.store))
          )
            fail('CONTENT_MISMATCH');
        }
        await effect('body', () =>
          pages.fillTitle(task.snapshot.article.title),
        );
        titleWritten = true;
        if (!context) {
          context = await inspect();
          if (!sameStore(context.store, task.store)) fail('STORE_CHANGED');
          if (
            context.remote ||
            context.pendingUploads ||
            context.title !== task.snapshot.article.title
          )
            fail('CONTENT_MISMATCH');
        }
        for (const [bodyIndex, block] of body.entries()) {
          if (
            plainArticle &&
            block.type === 'paragraph' &&
            'content' in block
          ) {
            const text = block.content.map((run) => run.text).join('');
            await effect('body', () => pages.appendParagraph(text));
            count++;
          } else if (block.type !== 'image') {
            await effect('body', () =>
              rich
                ? pages.appendTextBlock!(
                    block as import('../../../contracts/rich-text-body').RichTextBlock,
                    () => task.stopRequested || hooks.stopped(),
                  )
                : pages.appendParagraph((block as { text: string }).text),
            );
            count++;
          } else {
            await guard();
            const asset = task.snapshot.article.assets.find(
              (value) =>
                value.imageId ===
                ('imageId' in block ? block.imageId : block.image_id),
            )!;
            const bytes = await hooks.readImage(asset.assetKey);
            stop();
            if (bytes.byteLength !== asset.byteSize) fail('ASSET_UNAVAILABLE');
            let resourceKey = '';
            await effect(
              'body',
              async () => {
                resourceKey = await pages.appendImage(
                  bytes,
                  asset.mime as 'image/jpeg' | 'image/png',
                );
              },
              true,
            );
            await persist({
              ...evidence,
              images: [
                ...evidence.images,
                {
                  bodyIndex,
                  imageId: 'imageId' in block ? block.imageId : block.image_id,
                  assetKey: asset.assetKey,
                  resourceKey,
                },
              ],
            });
            count++;
          }
        }
        await guard();
        if (checkpointed) {
          const final = await inspect();
          stop();
          if (
            session.generation() !== generation ||
            !final.known ||
            final.contextKey !== context.contextKey ||
            final.editorUrl !== context.editorUrl
          )
            fail('PAGE_CHANGED');
          if (!sameStore(final.store, task.store)) fail('STORE_CHANGED');
          if (final.remote || !matchesOperationContent(local(), final, count))
            fail('CONTENT_MISMATCH');
        }
        const reportCover = async (
          phase: CoverReport['phase'],
          reason: CoverReport['reason'],
          items = coverPlan!.report.confirmedItems,
        ) => {
          const report = CoverReportSchema.parse({
            ...coverPlan!.report,
            phase,
            reason,
            confirmedItems: items,
            updatedAt: new Date().toISOString(),
          });
          if (!reportMatchesSnapshot(coverPlan!.snapshot, report))
            fail('PAGE_CHANGED');
          await hooks.coverReport(report);
          coverPlan = { ...coverPlan!, report };
        };
        const freshCoverEditor = async () => {
          await guard();
          const current = await inspect();
          stop();
          if (
            session.generation() !== generation ||
            !current.known ||
            current.contextKey !== context!.contextKey ||
            current.editorUrl !== context!.editorUrl
          )
            fail('PAGE_CHANGED');
          if (!sameStore(current.store, task.store)) fail('STORE_CHANGED');
          if (
            current.remote ||
            !matchesOperationContent(local(), current, count)
          )
            fail('CONTENT_MISMATCH');
          return current;
        };
        if (coverPlan) {
          await guard();
          await hooks.checkpoint('cover');
          await freshCoverEditor();
          const mode = coverPlan.snapshot.mode;
          if (mode !== 'none') {
            const files: CoverUploadFile[] = [];
            let unavailable = false;
            for (const [
              position,
              asset,
            ] of coverPlan.snapshot.assets.entries()) {
              stop();
              let bytes: Uint8Array;
              try {
                bytes = await hooks.readCoverImage(asset.assetKey);
              } catch (error) {
                if (!(
                  typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  error.code === 'IMAGE_UNAVAILABLE'
                ))
                  throw error;
                unavailable = true;
                break;
              }
              stop();
              if (
                bytes.byteLength !== asset.byteSize ||
                createHash('sha256').update(bytes).digest('hex') !==
                  asset.sha256
              )
                fail('PAGE_CHANGED');
              files.push({
                position,
                assetKey: asset.assetKey,
                sha256: asset.sha256,
                mime: asset.mime,
                bytes: new Uint8Array(bytes),
              });
            }
            if (unavailable) {
              await reportCover('failed', 'IMAGE_UNAVAILABLE');
              await freshCoverEditor();
            } else {
              await reportCover('uploading', null);
              await freshCoverEditor();
              const outcome = await pages.uploadLocalCover!(
                { mode, files },
                () => task.stopRequested || hooks.stopped(),
              );
              if (outcome.status === 'blocked') {
                if (
                  outcome.reason === 'COVER_UPLOAD_FAILED' &&
                  outcome.safeEditorProof
                ) {
                  await reportCover('failed', 'COVER_UPLOAD_FAILED');
                  await persist({
                    ...evidence,
                    coverAbort: {
                      attempts: 2,
                      step: 'wait-for-upload',
                      modalClosed: true,
                      editorClean: true,
                    },
                  });
                  return fail(outcome.reason);
                }
                await reportCover('needs_human', 'PAGE_UNVERIFIED');
                return fail(outcome.reason);
              }
              await reportCover(
                outcome.status === 'completed' ? 'pending' : 'failed',
                outcome.status === 'completed' ? null : outcome.reason,
                outcome.items,
              );
              stop();
              const current = await freshCoverEditor();
              if (outcome.status === 'completed') {
                if (
                  outcome.libraryUnchecked !== true ||
                  outcome.items.length !== files.length
                )
                  fail('PAGE_CHANGED');
              } else {
                const proof = outcome.safeEditorProof;
                if (
                  proof.generation !== generation ||
                  proof.contextKey !== current.contextKey ||
                  proof.storeKey !== task.store.storeKey ||
                  proof.modalClosed !== true ||
                  proof.uploadsSettled !== true ||
                  proof.editorUrl !== current.editorUrl ||
                  proof.operation?.taskId !== current.operation?.taskId ||
                  proof.operation?.rootKey !== current.operation?.rootKey ||
                  proof.operation?.coverKey !== current.operation?.coverKey ||
                  current.operation?.saving === true
                )
                  fail('PAGE_CHANGED');
              }
            }
          }
          saveContext = await freshCoverEditor();
        }
        if (
          hooks.batchSubmissionReview === 'operator' &&
          pages.batchSubmissionReview === 'operator'
        ) {
          if (!pages.saveForOperatorReview || !pages.returnHomeAfterSubmission)
            fail('INPUT_UNSUPPORTED');
          let submission:
            import('../../../contracts/draft-task').Submission | undefined;
          await effect(
            'save',
            async () => {
              if (rich) saveContext = await freshCoverEditor();
              saving = true;
              submission = await pages.saveForOperatorReview!(
                () => task.stopRequested || hooks.stopped(),
                (observed) => persist({ ...evidence, submission: observed }),
              );
              if (!evidence.submission)
                await persist({ ...evidence, submission });
            },
            true,
          );
          stop();
          await pages.returnHomeAfterSubmission!(
            () => task.stopRequested || hooks.stopped(),
          );
          stop();
          if (session.generation() !== generation || !submission)
            fail('PAGE_CHANGED');
          return {
            status: 'submission_recorded',
            submission: submission!,
            evidence: structuredClone(evidence),
          };
        }
        await effect(
          'save',
          async () => {
            if (rich) saveContext = await freshCoverEditor();
            saving = true;
            await pages.saveOnce();
          },
          true,
        );
        if (pages.manualReview) {
          if (!pages.automaticDraftReview)
            return blocked('MANUAL_REVIEW_REQUIRED');
          if (!review) fail('RESULT_AMBIGUOUS');
          stop();
          if (session.generation() !== generation) fail('PAGE_CHANGED');
          await checkStore(reads, task);
          stop();
          await hooks.verifying();
          const observed = await review!(
            task.taskId,
            task.snapshot.article.title,
          );
          stop();
          if (session.generation() !== generation) fail('PAGE_CHANGED');
          if (rich && !richEvidenceKnown(observed)) fail('PAGE_CHANGED');
          if (!observed.remote || !validRemote(observed.remote))
            fail('RESULT_AMBIGUOUS');
          const next = { ...evidence, remote: observed.remote };
          const candidate = { ...local(), evidence: next };
          if (!verifyEvidence(candidate, observed)) fail('CONTENT_MISMATCH');
          await persist(next);
          return {
            status: 'verified',
            evidence: structuredClone(evidence),
            ...(coverPlan
              ? { coverReport: verifyLocalCover(candidate, observed) }
              : {}),
          };
        }
        // The sole save may reopen its associated record in a new document.
        // Result association is read-only; the writing root remains retired.
        const saved = rich
          ? await pages.inspectRichEditor!()
          : await pages.inspectEditor();
        if (
          !saved.known ||
          saved.contextKey !== context.contextKey ||
          !sameStore(saved.store, task.store) ||
          !saved.remote ||
          !validRemote(saved.remote) ||
          saved.editorUrl !== saved.remote.editUrl
        )
          fail('RESULT_AMBIGUOUS');
        await persist({ ...evidence, remote: saved.remote });
        await hooks.verifying();
        stop();
        const result = await reconcileWithPages(reads, local());
        if (result.coverReport) await hooks.coverReport(result.coverReport);
        return result.status === 'verified'
          ? { status: 'verified', evidence: result.evidence }
          : blocked(
              result.status === 'blocked' ? result.reason : 'RESULT_AMBIGUOUS',
            );
      } catch (error) {
        if (
          error instanceof JudongchePageError &&
          error.reason === 'CONTENT_MISMATCH'
        ) {
          try {
            pages.reportAdapterFailure?.(error);
          } catch {
            // Optional diagnostics cannot replace the original execution result.
          }
        }
        if (
          coverPlan &&
          saving &&
          error instanceof JudongchePageError &&
          error.reason === 'COVER_REQUIRED'
        ) {
          try {
            await hooks.coverReport({
              ...coverPlan.report,
              phase: 'failed',
              reason: 'COVER_REQUIRED',
              updatedAt: new Date().toISOString(),
            });
          } catch {
            return blocked('STORAGE_UNAVAILABLE');
          }
          if (task.stopRequested || hooks.stopped())
            return blocked('STOP_REQUESTED');
          const proof =
            error instanceof JudongcheCoverRequiredError
              ? error.noSaveProof
              : undefined;
          if (
            !proof ||
            proof.explicitRejection !== true ||
            proof.remoteRecordAbsent !== true ||
            proof.noPendingSave !== true ||
            proof.autosaveExcluded !== true ||
            !saveContext
          )
            return blocked('RESULT_AMBIGUOUS');
          try {
            const before = await checkStore(reads, task);
            const current = await inspect();
            const after = await checkStore(reads, task);
            if (task.stopRequested || hooks.stopped())
              return blocked('STOP_REQUESTED');
            if (
              before.generation !== generation ||
              before.generation !== after.generation ||
              session.generation() !== before.generation ||
              !current.known ||
              current.remote ||
              current.contextKey !== saveContext.contextKey ||
              current.editorUrl !== saveContext.editorUrl ||
              !matchesOperationContent({ ...task, evidence }, current)
            )
              return blocked('RESULT_AMBIGUOUS');
            return blocked('COVER_REQUIRED');
          } catch (guardError) {
            return blocked(reasonOf(guardError, 'RESULT_AMBIGUOUS'));
          }
        }
        return blocked(
          reasonOf(error, saving ? 'RESULT_AMBIGUOUS' : 'PAGE_CHANGED'),
        );
      }
    },
  };
}
export function createJudongcheAdapter(
  session: BrowserSession,
  diagnostic?: import('./production-pages').ProbeDiagnosticSink,
  options?: JudongchePageOptions,
): DraftPlatform {
  return createAdapterWithPages(
    session,
    createJudongchePages(session, diagnostic, options),
    JUDONGCHE_CONTENT_CAPABILITIES,
  );
}

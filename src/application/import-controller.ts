import type {
  ImportOutcome,
  ImportSnapshot,
  StartImportResult,
} from '../contracts/article-library';
import {
  ignoredMetadataWarning,
  mapIssues,
} from '../contracts/article-package-errors';
import { ImportFailure, importMessages } from '../domain/import-error';
import type { LocalRootCapability } from '../domain/ports/article-import';
import type {
  ImportResult,
  createArticleImportService,
} from './article-import';

interface ImportControllerPorts {
  choose(
    signal: AbortSignal,
  ): Promise<{ input: unknown; capability: LocalRootCapability } | undefined>;
  importArticle: ReturnType<typeof createArticleImportService>['importArticle'];
  newId(): string;
}

function outcome(result: ImportResult): ImportOutcome {
  switch (result.status) {
    case 'imported':
      return {
        status: result.status,
        articleKey: result.article.articleKey,
        title: result.article.title,
        warnings: result.warnings.length
          ? [ignoredMetadataWarning.message]
          : [],
      };
    case 'already_exists':
    case 'already_deleted':
      return {
        status: result.status,
        articleKey: result.article.articleKey,
        title: result.article.title,
      };
    case 'cancelled':
      return { status: result.status };
    case 'failed':
      return {
        status: result.status,
        code: result.code,
        message: importMessages[result.code],
        ...(Number.isInteger(result.imageIndex) &&
        result.imageIndex! >= 0 &&
        result.imageIndex! < 200
          ? { imageIndex: result.imageIndex }
          : {}),
      };
    case 'invalid':
      return {
        status: result.status,
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
            typeof index === 'number' &&
            Number.isSafeInteger(index) &&
            index >= 0
              ? field === 'images'
                ? `第 ${index + 1} 张图片`
                : field === 'body'
                  ? `第 ${index + 1} 个内容块`
                  : undefined
              : undefined;
          return { message: safe.message, ...(position ? { position } : {}) };
        }),
      };
  }
}

export function createImportController(ports: ImportControllerPorts) {
  let current: ImportSnapshot = { state: 'idle', revision: 0 };
  let closing = false;
  let active:
    | { jobId: string; abort: AbortController; settled: Promise<void> }
    | undefined;
  const snapshot = (): ImportSnapshot => structuredClone(current);
  const isBlocked = () =>
    current.state === 'finished' &&
    current.result.status === 'failed' &&
    current.result.code === 'RECOVERY_REQUIRED';
  function cancel(jobId: string): ImportSnapshot {
    if (active?.jobId === jobId && current.state !== 'stopping') {
      current = { state: 'stopping', jobId, revision: current.revision + 1 };
      active.abort.abort();
    }
    return snapshot();
  }
  return {
    snapshot,
    requestStop() {
      if (active) cancel(active.jobId);
    },
    isBlocked,
    isActive: () => active !== undefined,
    cancel,
    start(): StartImportResult {
      if (closing || isBlocked()) return { status: 'unavailable' };
      if (active) return { status: 'busy', jobId: active.jobId };
      const jobId = ports.newId();
      const abort = new AbortController();
      current = { state: 'selecting', jobId, revision: current.revision + 1 };
      const settled = Promise.resolve().then(async () => {
        let result: ImportOutcome;
        let importing = false;
        try {
          // A shutdown or cancellation can occur before the picker is opened.
          const selection = abort.signal.aborted
            ? undefined
            : await ports.choose(abort.signal);
          if (!selection || abort.signal.aborted)
            result = { status: 'cancelled' };
          else {
            importing = true;
            current = {
              state: 'importing',
              jobId,
              revision: current.revision + 1,
            };
            result = outcome(
              await ports.importArticle(selection.input, {
                capability: selection.capability,
                signal: abort.signal,
              }),
            );
          }
        } catch (error) {
          if (!importing && abort.signal.aborted)
            result = { status: 'cancelled' };
          else {
            const code =
              error instanceof ImportFailure
                ? error.code
                : importing
                  ? 'STORAGE_UNAVAILABLE'
                  : 'FILE_UNAVAILABLE';
            result = { status: 'failed', code, message: importMessages[code] };
          }
        }
        current = {
          state: 'finished',
          jobId,
          revision: current.revision + 1,
          result,
        };
        active = undefined;
      });
      active = { jobId, abort, settled };
      return { status: 'started', jobId };
    },
    async stopAndWait(): Promise<void> {
      closing = true;
      const running = active;
      if (running) {
        cancel(running.jobId);
        await running.settled;
      }
    },
  };
}

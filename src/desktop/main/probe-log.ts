import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type RuntimeIdentity = Readonly<{
  appVersion: string;
  packaged: boolean;
  asarSha256: string | null;
  asarStatus: 'verified' | 'not-packaged' | 'unavailable';
}>;

/** Main supplies Electron's original-fs reader: node:fs treats ASAR as a directory. */
export function createRuntimeIdentity(
  input: { appVersion: string; packaged: boolean; asarPath: string },
  readArchive: (path: string) => Uint8Array,
): RuntimeIdentity {
  const base = { appVersion: input.appVersion, packaged: input.packaged };
  if (!input.packaged)
    return { ...base, asarSha256: null, asarStatus: 'not-packaged' };
  try {
    return {
      ...base,
      asarSha256: createHash('sha256')
        .update(readArchive(input.asarPath))
        .digest('hex'),
      asarStatus: 'verified',
    };
  } catch {
    // Hashing is diagnostic only. Never expose a raw read error or local path.
    return { ...base, asarSha256: null, asarStatus: 'unavailable' };
  }
}

/** Caller supplies fixed platform labels and sanitized task state only. */
export function writeProbeLog(
  root: string,
  event: {
    operation?: string;
    closeRequested?: boolean;
    check?: string;
    failure?: boolean;
    searchDiagnostic?: unknown;
  },
  task: { taskId: string } | null,
  runtimeIdentity?: RuntimeIdentity,
): void {
  const record =
    JSON.stringify({
      ...event,
      task,
      ...(runtimeIdentity
        ? {
            runtimeIdentity: {
              appVersion: runtimeIdentity.appVersion,
              packaged: runtimeIdentity.packaged,
              asarSha256: runtimeIdentity.asarSha256,
              asarStatus: runtimeIdentity.asarStatus,
            },
          }
        : {}),
      observedAt: new Date().toISOString(),
    }) + '\n';
  if (
    event.check &&
    [
      'editor-page-crashed',
      'browser-disconnected',
      'business-context-closed',
      'preview-image-error',
    ].includes(event.check)
  ) {
    appendFileSync(join(root, 'judongche-browser-events.jsonl'), record, {
      mode: 0o600,
    });
  }
  if (
    event.check === 'cover-click-observation' &&
    task &&
    /^[a-f0-9-]{36}$/i.test(task.taskId)
  ) {
    // A delayed observation belongs to the original task even if the operator has continued.
    appendFileSync(
      join(root, 'judongche-write-observations-' + task.taskId + '.jsonl'),
      record,
      { mode: 0o600 },
    );
    return;
  }
  // Later session/store probes must not overwrite the latest search evidence.
  if (event.searchDiagnostic)
    writeFileSync(join(root, 'judongche-search-probe.json'), record, {
      mode: 0o600,
    });
  if (
    task &&
    /^[a-f0-9-]{36}$/i.test(task.taskId) &&
    (event.check === 'editor-controls-observed' ||
      event.check === 'paragraph-write-observed')
  ) {
    appendFileSync(
      join(root, 'judongche-write-observations-' + task.taskId + '.jsonl'),
      record,
      { mode: 0o600 },
    );
  }
  // Separate execution from subsequent read-only diagnosis. Exclusive creation
  // preserves the first failure across refreshes and application restarts.
  if (event.failure && task && /^[a-f0-9-]{36}$/i.test(task.taskId)) {
    const scope = [
      'enterNewEditor',
      'fillTitle',
      'appendParagraph',
      'appendTextBlock',
      'appendImage',
      'uploadLocalCover',
      'saveForOperatorReview',
      'adapterValidation',
      'saveOnce',
    ].includes(event.operation ?? '')
      ? 'execution'
      : 'readonly';
    try {
      writeFileSync(
        join(root, `judongche-first-failure-${task.taskId}-${scope}.json`),
        record,
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
  }
  writeFileSync(join(root, 'judongche-probe.json'), record, { mode: 0o600 });
}

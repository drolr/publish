import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Caller supplies fixed platform labels and sanitized task state only. */
export function writeProbeLog(
  root: string,
  event: { operation?: string; failure?: boolean; searchDiagnostic?: unknown },
  task: { taskId: string } | null,
): void {
  const record =
    JSON.stringify({ ...event, task, observedAt: new Date().toISOString() }) +
    '\n';
  // Later session/store probes must not overwrite the latest search evidence.
  if (event.searchDiagnostic)
    writeFileSync(join(root, 'judongche-search-probe.json'), record, {
      mode: 0o600,
    });
  // Separate execution from subsequent read-only diagnosis. Exclusive creation
  // preserves the first failure across refreshes and application restarts.
  if (event.failure && task && /^[a-f0-9-]{36}$/i.test(task.taskId)) {
    const scope = [
      'enterNewEditor',
      'fillTitle',
      'appendParagraph',
      'appendImage',
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

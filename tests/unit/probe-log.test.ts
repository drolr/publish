import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeProbeLog } from '../../src/desktop/main/probe-log';

test('first execution failure survives refresh, later failures and a separate readonly failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-log-'));
  const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
  try {
    writeProbeLog(root, { operation: 'enterNewEditor', failure: true }, task);
    const path = join(
      root,
      `judongche-first-failure-${task.taskId}-execution.json`,
    );
    const first = readFileSync(path, 'utf8');
    writeProbeLog(
      root,
      {
        operation: 'inspectDraftAbsence',
        searchDiagnostic: { visibleCards: 0, emptyVisible: true },
      },
      task,
    );
    const searchPath = join(root, 'judongche-search-probe.json');
    const search = readFileSync(searchPath, 'utf8');
    writeProbeLog(root, { operation: 'probe', failure: false }, task);
    writeProbeLog(root, { operation: 'probe', failure: true }, task);
    writeProbeLog(root, { operation: 'saveOnce', failure: true }, task);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(readFileSync(searchPath, 'utf8')).toBe(search);
    expect(
      JSON.parse(
        readFileSync(
          join(root, `judongche-first-failure-${task.taskId}-readonly.json`),
          'utf8',
        ),
      ).operation,
    ).toBe('probe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  createRuntimeIdentity,
  writeProbeLog,
} from '../../src/desktop/main/probe-log';
import type { ProbeDiagnostic } from '../../src/infrastructure/platforms/judongche/production-pages';

test('packaged runtime identity hashes archive bytes using the supplied physical archive reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-identity-'));
  const asarPath = join(root, 'app.asar');
  const bytes = Buffer.from([0, 0, 4, 0, 255, 128, 33]);
  writeFileSync(asarPath, bytes);
  const reads: string[] = [];
  try {
    const identity = createRuntimeIdentity(
      { appVersion: '1.2.3', packaged: true, asarPath },
      (path) => {
        reads.push(path);
        return readFileSync(path);
      },
    );
    expect(identity).toEqual({
      appVersion: '1.2.3',
      packaged: true,
      asarSha256: createHash('sha256').update(bytes).digest('hex'),
      asarStatus: 'verified',
    });
    expect(identity.asarSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reads).toEqual([asarPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('development runtime identity does not read an archive', () => {
  let reads = 0;
  expect(
    createRuntimeIdentity(
      { appVersion: '0.1.0-dev', packaged: false, asarPath: 'unused' },
      () => {
        reads++;
        throw Error('must not read in development');
      },
    ),
  ).toEqual({
    appVersion: '0.1.0-dev',
    packaged: false,
    asarSha256: null,
    asarStatus: 'not-packaged',
  });
  expect(reads).toBe(0);
});

test('archive read failures return sanitized unavailable metadata without stopping startup', () => {
  const identity = createRuntimeIdentity(
    { appVersion: '1.2.3', packaged: true, asarPath: 'private/archive' },
    () => {
      throw Error('private/archive cookie=secret');
    },
  );
  expect(identity).toEqual({
    appVersion: '1.2.3',
    packaged: true,
    asarSha256: null,
    asarStatus: 'unavailable',
  });
  expect(JSON.stringify(identity)).not.toMatch(/private|cookie|secret|stack/);
});

test('optional runtime metadata is fixed-field and preserves the first failure across later identities and legacy calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-identity-'));
  const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
  const identity = {
    appVersion: '1.2.3',
    packaged: true,
    asarSha256: 'a'.repeat(64),
    asarStatus: 'verified' as const,
    extra: 'must not be logged',
  };
  try {
    writeProbeLog(
      root,
      { operation: 'appendImage', failure: true },
      task,
      identity,
    );
    const firstPath = join(
      root,
      `judongche-first-failure-${task.taskId}-execution.json`,
    );
    const first = readFileSync(firstPath, 'utf8');
    expect(JSON.parse(first).runtimeIdentity).toEqual({
      appVersion: identity.appVersion,
      packaged: true,
      asarSha256: identity.asarSha256,
      asarStatus: 'verified',
    });
    writeProbeLog(root, { operation: 'probe', failure: true }, task, {
      appVersion: '1.2.4',
      packaged: false,
      asarSha256: null,
      asarStatus: 'not-packaged',
    });
    expect(
      JSON.parse(readFileSync(join(root, 'judongche-probe.json'), 'utf8'))
        .runtimeIdentity.appVersion,
    ).toBe('1.2.4');
    writeProbeLog(root, { operation: 'appendImage', failure: true }, task);
    expect(readFileSync(firstPath, 'utf8')).toBe(first);
    expect(
      JSON.parse(readFileSync(join(root, 'judongche-probe.json'), 'utf8')),
    ).not.toHaveProperty('runtimeIdentity');
    expect(first).not.toMatch(/must not be logged|extra/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('body upload timing and action counts remain in the exclusive first execution failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-log-body-'));
  const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
  const event: ProbeDiagnostic = {
    operation: 'appendImage',
    phase: 'guard-safety',
    check: 'unknown-dialog',
    reason: 'PAGE_CHANGED',
    failure: true,
    bodyImage: {
      index: 1,
      stage: 'preview-visible',
      status: 'failed',
      stageStartedAt: 1120,
      elapsedMs: 120,
      stageElapsedMs: 80,
      failureElapsedMs: 200,
      failureCause: 'guard-rejected',
      fileSelectionCount: 1,
      confirmationCount: 0,
      stages: [
        {
          stage: 'select-file',
          status: 'completed',
          stageStartedAt: 1060,
          startedElapsedMs: 60,
          stageElapsedMs: 60,
        },
        {
          stage: 'preview-visible',
          status: 'failed',
          stageStartedAt: 1120,
          startedElapsedMs: 120,
          stageElapsedMs: 80,
        },
      ],
    },
  };
  try {
    writeProbeLog(root, event, task);
    const path = join(
      root,
      `judongche-first-failure-${task.taskId}-execution.json`,
    );
    const first = readFileSync(path, 'utf8');
    writeProbeLog(root, { operation: 'probe', failure: true }, task);
    writeProbeLog(root, { operation: 'appendImage', failure: true }, task);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(JSON.parse(first).bodyImage).toEqual(event.bodyImage);
    expect(first).not.toMatch(/https:|cookie|stack|body\.png|保存到素材库/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

for (const operation of [
  'uploadLocalCover',
  'saveForOperatorReview',
  'adapterValidation',
]) {
  test(`${operation} retains the execution first error independently of a later probe`, () => {
    const root = mkdtempSync(join(tmpdir(), 'probe-log-'));
    const task = { taskId: '91fb259b-ad99-4128-8138-916ebb5b9091' };
    try {
      writeProbeLog(root, { operation, failure: true }, task);
      const execution = join(
        root,
        `judongche-first-failure-${task.taskId}-execution.json`,
      );
      expect(existsSync(execution)).toBe(true);
      const first = readFileSync(execution, 'utf8');
      writeProbeLog(root, { operation: 'probe', failure: true }, task);
      writeProbeLog(root, { operation, failure: true }, task);
      expect(readFileSync(execution, 'utf8')).toBe(first);
      const record = JSON.parse(first);
      const probe = JSON.parse(
        readFileSync(
          join(root, `judongche-first-failure-${task.taskId}-readonly.json`),
          'utf8',
        ),
      );
      expect(record.operation).toBe(operation);
      expect(probe.operation).toBe('probe');
      expect(probe.task.taskId).toBe(record.task.taskId);
      expect(Date.parse(probe.observedAt)).toBeGreaterThanOrEqual(
        Date.parse(record.observedAt),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

import { prepareEmptyCopiedLedger } from '../fixtures/library-historical-data';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('new process retains 11→10 count, deletion receipt, settled task identity and original assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'library-new-process-'));
  try {
    const run = (phase: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/integration/library-recovery-child.ts'),
          phase,
          root,
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true },
      );
    const seeded = run('seed');
    expect(seeded.status, seeded.stderr).toBe(0);
    const first = JSON.parse(seeded.stdout);
    expect(first).toMatchObject({
      count: 10,
      beforeCount: 11,
      deleted: 'deleted',
      settled: 'draft_saved',
    });
    const reopened = run('reopen');
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      count: 10,
      receipt: 'deleted',
      settled: 'draft_saved',
      sameTask: true,
      sameAssets: true,
      importStatus: 'already_deleted',
      sourceReads: 0,
      reserve: 'stale',
      archiveRecovered: true,
    });
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'library-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});

// Local compatibility evidence runs only where the explicitly authorized immutable backup exists.
import {
  hasSchema6Backup,
  copyHistoricalBusinessData,
  verifyHistoricalUpgrade,
} from '../fixtures/library-historical-data';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
it.runIf(hasSchema6Backup)(
  'historical schema6 business copy preserves every old column/row, asset and source byte through schema7',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'library-schema6-copy-'));
    try {
      const expected = copyHistoricalBusinessData(root);
      const repository = openArticleRepository(
        join(root, 'data/app.sqlite'),
        resolve('src/infrastructure/persistence/migrations'),
      );
      try {
        expect(repository.list!()).toMatchObject({
          status: 'ok',
          page: { totalCount: 1 },
        });
      } finally {
        repository.close();
      }
      expect(verifyHistoricalUpgrade(root, expected)).toMatchObject({
        status: 'PASS',
        schemaVersion: 15,
        historicalArticleCount: 1,
      });
    } finally {
      expect(resolve(root)).toBe(root);
      expect(root.startsWith(join(tmpdir(), 'library-'))).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('valid nonempty schema6 save receipt and settled task survive upgrade in a fresh process', () => {
  const source = mkdtempSync(join(tmpdir(), 'library-valid-schema6-source-'));
  const target = mkdtempSync(join(tmpdir(), 'library-valid-schema6-target-'));
  try {
    const run = (phase: string, root: string, extra?: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/integration/library-recovery-child.ts'),
          phase,
          root,
          ...(extra ? [extra] : []),
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true },
      );
    expect(run('seed', source).status).toBe(0);
    const result = run('upgrade-schema6', target, source);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 15,
      count: 11,
      sameTask: true,
      legacyArticleRevision: null,
      sameAssets: true,
      sameOldRows: true,
      saveReceipt: 2,
      settled: 'draft_saved',
      recovered: true,
    });
  } finally {
    expect(resolve(source)).toBe(source);
    expect(source.startsWith(join(tmpdir(), 'library-'))).toBe(true);
    rmSync(source, { recursive: true, force: true });
    expect(resolve(target)).toBe(target);
    expect(target.startsWith(join(tmpdir(), 'library-'))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  }
});

import { mkdirSync } from 'node:fs';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
it.runIf(hasSchema6Backup)(
  'historical desktop copy prepares its own empty temporary ledger without changing the immutable original',
  async () => {
    const owner = mkdtempSync(join(tmpdir(), 'library-owned-ledger-'));
    const userData = join(owner, 'user-data');
    mkdirSync(userData);
    try {
      const expected = copyHistoricalBusinessData(userData);
      const repository = openArticleRepository(
        join(userData, 'data/app.sqlite'),
        resolve('src/infrastructure/persistence/migrations'),
      );
      repository.close();
      prepareEmptyCopiedLedger(owner, userData, expected);
      expect(await createManualTempStore(userData).recover()).toBe(true);
      expect(verifyHistoricalUpgrade(userData, expected)).toMatchObject({
        status: 'PASS',
      });
    } finally {
      expect(resolve(owner)).toBe(owner);
      expect(owner.startsWith(join(tmpdir(), 'library-'))).toBe(true);
      rmSync(owner, { recursive: true, force: true });
    }
  },
);

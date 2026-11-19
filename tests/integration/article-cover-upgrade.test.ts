import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

for (const version of [6, 7])
  it(`nonempty synthetic schema${version} upgrades to8 with old task/closure/save rows and real cover bytes in a new process`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cover-upgrade-'));
    try {
      const run = (phase: string) =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('tests/integration/cover-upgrade-child.ts'),
            phase,
            root,
            String(version),
          ],
          { encoding: 'utf8', timeout: 30000, windowsHide: true },
        );
      const seeded = run('seed');
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(JSON.parse(seeded.stdout)).toMatchObject({
        sourceSchema: version,
        nonemptyTask: true,
        nonemptyClosure: true,
        nonemptySave: true,
      });
      const upgraded = run('upgrade');
      expect(upgraded.status, upgraded.stderr).toBe(0);
      expect(JSON.parse(upgraded.stdout)).toMatchObject({
        schemaVersion: 15,
        oldRowsExact: true,
        oldAssetsExact: true,
        coverModes: ['single', 'triple'],
        originalBodiesExact: true,
        originalRevisionsExact: true,
        originalSourceRemoved: true,
      });
      const reopened = run('reopen');
      expect(reopened.status, reopened.stderr).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({
        schemaVersion: 15,
        orderedCoverBytesExact: true,
        coverReceiptsExact: true,
        oldRowsExact: true,
        deletedCoverHistoryExact: true,
        taskHistoryExact: true,
        originalBodiesExact: true,
      });
      const archived = run('archive');
      expect(archived.status, archived.stderr).toBe(0);
      expect(JSON.parse(archived.stdout)).toMatchObject({
        deletedCoverHistoryExact: true,
        coverReceiptsExact: true,
        oldRowsExact: true,
      });
    } finally {
      expect(resolve(root)).toBe(root);
      expect(root.startsWith(join(tmpdir(), 'cover-upgrade-'))).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
    // Four fresh Windows processes perform the upgrade/reopen proof; retain every
    // assertion while allowing their startup overhead beyond Vitest's 5s default.
  }, 30000);

import {
  hasSchema6Backup,
  copyHistoricalBusinessData,
  verifyHistoricalUpgrade,
} from '../fixtures/library-historical-data';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
it.runIf(hasSchema6Backup)(
  'actual independent immutable schema6 business copy upgrades to8 with implicit none and exact original bytes',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cover-upgrade-actual6-'));
    try {
      const expected = copyHistoricalBusinessData(root);
      const repository = openArticleRepository(
        join(root, 'data/app.sqlite'),
        resolve('src/infrastructure/persistence/migrations'),
      );
      try {
        const list = repository.list!();
        expect(list).toMatchObject({ status: 'ok', page: { totalCount: 1 } });
        if (list.status !== 'ok') throw Error('list');
        for (const article of list.page.items)
          expect(repository.loadCover(article.articleKey)).toMatchObject({
            coverRevision: 0,
            mode: 'none',
            assets: [],
          });
      } finally {
        repository.close();
      }
      expect(verifyHistoricalUpgrade(root, expected)).toMatchObject({
        status: 'PASS',
        schemaVersion: 15,
        historicalArticleCount: 1,
        originalColumnsRowsExact: true,
      });
    } finally {
      expect(resolve(root)).toBe(root);
      expect(root.startsWith(join(tmpdir(), 'cover-upgrade-actual6-'))).toBe(
        true,
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

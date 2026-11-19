import { checkSharedCoverDesktop } from './batch-cover-desktop-flow';
import { checkLiveManualSkip } from './live-skip-desktop-flow';
import {
  checkCreationCover,
  checkManualSkip,
} from './operator-recovery-desktop-flow';
import { checkBatchRecovery } from './batch-desktop-flow';
import { checkCoverDesktop } from './cover-desktop-flow';
import { hasSchema6Backup } from '../fixtures/library-historical-data';
import {
  checkLibraryManagement,
  checkHistoricalLibraryUpgrade,
} from './library-desktop-flow';
import { checkWebPasteRuntime } from './web-paste-desktop-checks';
import { test } from '@playwright/test';
import { checkDesktop } from './desktop-checks';
import { checkManualDesktop } from './manual-desktop-checks';
import { cpSync } from 'node:fs';
import { checkDraftRecovery } from './draft-desktop-flow';
test('compiled desktop protects its bridge and handles database restart/failure', async () => {
  test.setTimeout(240000);
  const coverEvidence = test.info().outputPath('cover-evidence');
  // Forge's package build is architecture-scoped; its normal development
  // package.json points to .webpack/main/index.cjs. Stage those same compiled files.
  cpSync('.webpack/x64/main', '.webpack/main', { recursive: true });
  cpSync('.webpack/x64/renderer', '.webpack/renderer', { recursive: true });
  await test.step('library/security', () => checkDesktop());
  await test.step('manual', () => checkManualDesktop());
  await test.step('web paste', () => checkWebPasteRuntime());
  await test.step('draft recovery', () => checkDraftRecovery());
  await test.step('batch recovery', () => checkBatchRecovery());
  await test.step('library management', () =>
    checkLibraryManagement(undefined, 'task-6-desktop', coverEvidence));
  await test.step('creation cover combined save/reopen', () =>
    checkCreationCover(undefined, coverEvidence + '/creation'));
  await test.step('manual skip remaining frozen queue', () =>
    checkManualSkip(undefined, coverEvidence + '/skip'));
  await test.step('live manual skip same browser', () =>
    checkLiveManualSkip(undefined, coverEvidence + '/live-skip'));
  await test.step('local cover native/new process', () =>
    checkCoverDesktop(undefined, coverEvidence));
  await checkSharedCoverDesktop();
  if (hasSchema6Backup)
    await test.step('historical schema6 business copy', () =>
      checkHistoricalLibraryUpgrade(
        undefined,
        'task-6-desktop',
        coverEvidence,
      ));
  else
    test.info().annotations.push({
      type: 'historical-business-copy',
      description:
        'NOT RUN: explicitly authorized local schema6 backup unavailable',
    });
});

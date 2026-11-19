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
import { test, expect } from '@playwright/test';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkDesktop } from './desktop-checks';
import { checkManualDesktop } from './manual-desktop-checks';
import { createRequire } from 'node:module';
import {
  validatePackageInventory,
  validateNoProfileFiles,
} from '../../scripts/package-inventory';
import {
  checkPackagedBrowser,
  checkPackagedBrowserFailures,
} from './package-browser-checks';
import { checkDraftRecovery } from './draft-desktop-flow';
test('the actual Windows ZIP starts with SQLite, migrations and sandbox intact', async () => {
  test.setTimeout(600000);
  const coverEvidence = test.info().outputPath('cover-evidence');
  const directory = resolve('out/make/zip/win32/x64');
  const archives = readdirSync(directory).filter((name) =>
    name.endsWith('.zip'),
  );
  expect(archives).toHaveLength(1);
  const root = mkdtempSync(join(tmpdir(), 'draft-package-'));
  let checksAndClosuresConfirmed = false;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:DRAFT_TEST_ZIP -DestinationPath $env:DRAFT_TEST_EXTRACT',
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          DRAFT_TEST_ZIP: join(directory, archives[0]),
          DRAFT_TEST_EXTRACT: root,
        },
      },
    );
    const codecs = join(
      root,
      'resources/app.asar.unpacked/.webpack/main/native_modules/lib',
    );
    expect(existsSync(join(codecs, 'libvips-42.dll'))).toBe(true);
    expect(existsSync(join(codecs, 'libvips-cpp-8.18.7.dll'))).toBe(true);
    const forgeRequire = createRequire(
      require.resolve('@electron-forge/shared-types'),
    );
    const packagerRequire = createRequire(
      forgeRequire.resolve('@electron/packager'),
    );
    const { listPackage } = packagerRequire('@electron/asar') as {
      listPackage(path: string): string[];
    };
    validatePackageInventory(listPackage(join(root, 'resources/app.asar')));
    validateNoProfileFiles(readdirSync(root, { recursive: true }) as string[]);
    // Every installed runtime file must survive copying/unpacking byte-for-byte.
    // Loading chromium alone would miss lazily loaded server files and resources.
    const runtimeSource = resolve('node_modules/playwright-core');
    for (const entry of readdirSync(runtimeSource, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const source = join(entry.parentPath, entry.name);
      const target = join(
        root,
        'resources/app.asar.unpacked/node_modules/playwright-core',
        source.slice(runtimeSource.length + 1),
      );
      expect(
        createHash('sha256').update(readFileSync(target)).digest('hex'),
      ).toBe(createHash('sha256').update(readFileSync(source)).digest('hex'));
    }
    await checkPackagedBrowser(root);
    await checkPackagedBrowserFailures(root);
    await checkDesktop(join(root, 'draft-assistant.exe'));
    await checkManualDesktop(join(root, 'draft-assistant.exe'));
    expect(existsSync(join(root, 'resources/web-paste-worker.cjs'))).toBe(true);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    await checkWebPasteRuntime(join(root, 'draft-assistant.exe'));
    await checkDraftRecovery(join(root, 'draft-assistant.exe'));
    await checkBatchRecovery(join(root, 'draft-assistant.exe'));
    await checkLibraryManagement(
      join(root, 'draft-assistant.exe'),
      'task-6-package',
      coverEvidence,
    );
    await checkCreationCover(
      join(root, 'draft-assistant.exe'),
      join(coverEvidence, 'creation'),
    );
    await checkManualSkip(
      join(root, 'draft-assistant.exe'),
      join(coverEvidence, 'skip'),
    );
    await checkCoverDesktop(join(root, 'draft-assistant.exe'), coverEvidence);
    await checkLiveManualSkip(
      join(root, 'draft-assistant.exe'),
      join(coverEvidence, 'live-skip'),
    );
    await checkSharedCoverDesktop(join(root, 'draft-assistant.exe'));
    if (hasSchema6Backup)
      await checkHistoricalLibraryUpgrade(
        join(root, 'draft-assistant.exe'),
        'task-6-package',
        coverEvidence,
      );
    else
      test.info().annotations.push({
        type: 'historical-business-copy',
        description:
          'NOT RUN: explicitly authorized local schema6 backup unavailable',
      });
    // Helpers return only after their acquired contexts/apps confirm closure.
    checksAndClosuresConfirmed = true;
  } finally {
    expect(resolve(root)).toBe(root);
    expect(root.startsWith(join(tmpdir(), 'draft-package-'))).toBe(true);
    if (!checksAndClosuresConfirmed) {
      console.error(
        `PRESERVED owned extraction after failure/unconfirmed closure: ${root}`,
      );
    } else
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
  }
});

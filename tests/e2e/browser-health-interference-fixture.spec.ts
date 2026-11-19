import { expect, test } from '@playwright/test';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkLocalCapabilities,
  type BrowserCapabilityDiagnostic,
} from '../../src/infrastructure/automation/browser-health-check';

test('controlled keyboard insertion after real fill and before readback remains blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'health-interference-owned-'));
  const context = await chromium.launchPersistentContext(
    join(root, 'profile'),
    {
      channel: 'msedge',
      headless: false,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: null,
    },
  );
  const diagnostics: BrowserCapabilityDiagnostic[] = [];
  const realNewPage = context.newPage.bind(context);
  let injected = false;
  context.newPage = async () => {
    const page = await realNewPage();
    const realLocator = page.locator.bind(page);
    page.locator = (...args: Parameters<typeof page.locator>) => {
      const locator = realLocator(...args);
      if (args[0] === '#health-editor') {
        const realFill = locator.fill.bind(locator);
        locator.fill = async (...fillArgs: Parameters<typeof locator.fill>) => {
          await realFill(...fillArgs);
          // Deliberate test-only input, after the actual fill returns and before
          // production readback. This does not hook the internal fill protocol.
          await page.keyboard.press('Control+Home');
          await page.keyboard.insertText('x');
          injected = true;
        };
      }
      return locator;
    };
    return page;
  };
  let contextClosed = false;
  try {
    await expect(
      checkLocalCapabilities(context, new AbortController().signal, (event) =>
        diagnostics.push(event),
      ),
    ).rejects.toMatchObject({ stage: 'editor', reason: 'capability_failed' });
    expect(injected).toBe(true);
    expect(diagnostics).toContainEqual({
      phase: 'evaluate-return',
      editor: expect.objectContaining({
        innerTextMatches: false,
        innerTextLength: 8,
        innerTextLf: 1,
        textContentLength: 7,
        firstMismatchIndex: 0,
        singleDeletionMatches: true,
        extraPosition: 0,
        extraCategory: 'latin',
        selectionAvailable: null,
      }),
    });
  } finally {
    try {
      await context.close();
      contextClosed = true;
      expect(
        resolve(root).startsWith(
          resolve(tmpdir(), 'health-interference-owned-'),
        ),
      ).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      console.info(
        'controlled health interference: ' + JSON.stringify(diagnostics),
      );
      console.info(
        'controlled health interference cleanup: ' +
          JSON.stringify({
            contextClosed,
            temporaryRootRemoved: !existsSync(root),
          }),
      );
    }
  }
});

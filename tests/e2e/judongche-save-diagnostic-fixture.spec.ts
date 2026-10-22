import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createJudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import { installProductionFixture } from '../fixtures/judongche-production';
import { denyExternalNetwork } from './network-policy';

for (const fault of ['http', 'business', 'invalid', 'missing'] as const) {
  test(`save failure preserves bounded diagnostic and never resubmits: ${fault}`, async ({
    context,
    page,
  }) => {
    await denyExternalNetwork(context);
    const fixture = await installProductionFixture(context, {
      observedTrailingParagraphs: true,
    });
    let requests = 0;
    await context.route(
      '**/motor/dealer_admin/go_api/article/create',
      async (route) => {
        requests++;
        if (fault === 'missing') return route.abort();
        if (fault === 'invalid')
          return route.fulfill({
            body: 'private-response',
            contentType: 'text/plain',
          });
        return route.fulfill({
          status: fault === 'http' ? 503 : 200,
          json: { status: 5000, message: 'private-response' },
        });
      },
    );
    await page.goto(fixture.home);
    const diagnostics: unknown[] = [];
    const pages = createJudongchePages(
      {
        open: async () => context,
        current: () => context,
        generation: () => 'fixture-generation',
        close: async () => {},
      },
      (event) => diagnostics.push(event),
      {
        manualReview: true,
        ownerConfirmedPilot: { dealerId: '123456', storeName: '合成门店' },
      },
    );
    expect((await pages.probe()).status).toBe('ready');
    await pages.enterNewEditor('save diagnostic', () => false, randomUUID());
    await pages.fillTitle('save diagnostic');
    await pages.appendParagraph('body');
    expect((await pages.inspectEditor()).known).toBe(true);
    await expect(pages.saveOnce()).rejects.toMatchObject({
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(requests).toBe(1);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        operation: 'saveOnce',
        failure: true,
        check: {
          http: 'save-http-failure',
          business: 'save-business-rejected',
          invalid: 'save-response-invalid',
          missing: 'save-response-missing',
        }[fault],
        saveObservation: {
          responseReceived: fault !== 'missing',
          httpStatus: fault === 'missing' ? null : fault === 'http' ? 503 : 200,
          businessStatus: fault === 'business' ? 5000 : null,
        },
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain('private-response');
    await expect(pages.saveOnce()).rejects.toMatchObject({
      reason: 'RESULT_AMBIGUOUS',
    });
    expect(requests).toBe(1);
  });
}

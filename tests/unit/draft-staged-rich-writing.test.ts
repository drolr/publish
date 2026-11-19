import { describe, expect, it } from 'vitest';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/page-contract';
import { draftHarness } from '../fixtures/draft-adapter';
import { coverDraftHarness } from '../fixtures/cover-draft';
import {
  richCapabilities,
  richDraftHarness,
  richBody,
} from '../fixtures/rich-draft';

const session = {
  open: async () => {
    throw Error('no real browser');
  },
  current: () => undefined,
  close: async () => {},
  generation: () => 'fixture',
};

describe('staged manual writing guards', () => {
  for (const version of [1, 2]) {
    it(`V${version} defers full reads until writing is complete`, async () => {
      const h = version === 2 ? richDraftHarness() : draftHarness();
      Object.assign(h.pages, { manualReview: true });
      h.pages.checkWritingContext = async () => {
        h.calls.push('context');
      };
      const read =
        version === 2 ? h.pages.inspectRichEditor! : h.pages.inspectEditor;
      const counts: number[] = [];
      const inspect = async () => {
        const value = await read();
        counts.push(
          version === 2 ? value.rich!.blocks.length : value.blocks.length,
        );
        return value;
      };
      if (version === 2)
        h.pages.inspectRichEditor = inspect as typeof h.pages.inspectRichEditor;
      else h.pages.inspectEditor = inspect;
      expect(
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks),
      ).toEqual({
        status: 'blocked',
        reason: 'MANUAL_REVIEW_REQUIRED',
      });
      const length =
        version === 2
          ? richBody.blocks.length
          : h.task.snapshot.article.body.length;
      expect(counts.length).toBeGreaterThan(1);
      expect(counts.every((count) => count === 0 || count === length)).toBe(
        true,
      );
      expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
    });
  }

  it('uses the same light guard for operator V2 with a cover plan, retaining the final comparison', async () => {
    const legacy = coverDraftHarness('none');
    const h = richDraftHarness(richBody, legacy.task.coverPlan);
    const diagnostics: unknown[] = [];
    Object.assign(h.pages, {
      reportAdapterFailure: (error: unknown) => diagnostics.push(error),
    });
    Object.assign(h.pages, {
      manualReview: true,
      batchSubmissionReview: 'operator',
    });
    h.hooks.batchSubmissionReview = 'operator';
    h.observed.localCover = {
      known: true,
      mode: 'none',
      items: [],
      pendingUploads: false,
    };
    h.pages.checkWritingContext = async () => {
      h.calls.push('context');
    };
    const counts: number[] = [];
    const read = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const value = await read();
      counts.push(value.rich.blocks.length);
      if (value.rich.blocks.length === richBody.blocks.length)
        value.title = 'final drift';
      return value;
    };
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toMatchObject({
      status: 'blocked',
      reason: 'CONTENT_MISMATCH',
    });
    expect(h.observed.rich.blocks).toHaveLength(richBody.blocks.length);
    expect(
      counts.every((count) => count === 0 || count === richBody.blocks.length),
    ).toBe(true);
    expect(h.calls).not.toContain('save');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toBeInstanceOf(JudongchePageError);
    expect(diagnostics[0]).toMatchObject({ reason: 'CONTENT_MISMATCH' });
  });

  it('a failed adapter diagnostic sink cannot change CONTENT_MISMATCH or authorize a save', async () => {
    const h = richDraftHarness();
    Object.assign(h.pages, {
      reportAdapterFailure: () => {
        throw Error('private sink failure');
      },
    });
    const inspect = h.pages.inspectRichEditor;
    h.pages.inspectRichEditor = async () => {
      const value = await inspect();
      if (value.rich.blocks.length) value.title = 'private changed title';
      return value;
    };
    expect(
      await createAdapterWithPages(session, h.pages, richCapabilities).execute(
        h.task,
        h.hooks,
      ),
    ).toEqual({ status: 'blocked', reason: 'CONTENT_MISMATCH' });
    expect(h.calls).not.toContain('save');
  });

  it('retains intermediate full comparisons outside manual-review mode', async () => {
    const h = richDraftHarness();
    h.pages.checkWritingContext = async () => {};
    const read = h.pages.inspectRichEditor;
    const counts: number[] = [];
    h.pages.inspectRichEditor = async () => {
      const value = await read();
      counts.push(value.rich.blocks.length);
      return value;
    };
    expect(
      (
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks)
      ).status,
    ).toBe('verified');
    expect(
      counts.some((count) => count > 0 && count < richBody.blocks.length),
    ).toBe(true);
  });

  for (const reason of [
    'PAGE_CHANGED',
    'LOGIN_REQUIRED',
    'VERIFICATION_REQUIRED',
    'STOP_REQUESTED',
  ] as const) {
    it(`retains ${reason} checkpoints during V2 writing`, async () => {
      const h = richDraftHarness();
      Object.assign(h.pages, { manualReview: true });
      h.pages.checkWritingContext = async () => {
        if (h.observed.rich.blocks.length) throw new JudongchePageError(reason);
      };
      expect(
        await createAdapterWithPages(
          session,
          h.pages,
          richCapabilities,
        ).execute(h.task, h.hooks),
      ).toEqual({
        status: 'blocked',
        reason,
      });
      expect(h.calls).not.toContain('save');
      expect(h.observed.rich.blocks.length).toBeLessThan(
        richBody.blocks.length,
      );
    });
  }
});

import { describe, expect, it } from 'vitest';
import { classifyBatchTask, batchCounts } from '../../src/domain/draft-batch';
import { makeDraftTask } from '../fixtures/draft-task';

describe('batch results preserve single-task safety evidence', () => {
  it('continues only after an article-local failure without remote effect or occupancy', () => {
    expect(
      classifyBatchTask(
        makeDraftTask({
          state: 'failed',
          reason: 'ASSET_UNAVAILABLE',
          holdsPlatform: false,
        }),
      ),
    ).toEqual({ state: 'failed', pause: false, reason: 'ASSET_UNAVAILABLE' });
    for (const changes of [
      { possibleRemoteEffect: true },
      { holdsPlatform: true },
      { reason: 'PAGE_CHANGED' as const },
      { reason: null },
    ]) {
      expect(
        classifyBatchTask(
          makeDraftTask({
            state: 'failed',
            reason: 'ASSET_UNAVAILABLE',
            holdsPlatform: false,
            ...changes,
          }),
        ).pause,
      ).toBe(true);
    }
  });
  it('never reports a saved result while the single task retains platform ownership', () => {
    expect(
      classifyBatchTask(
        makeDraftTask({
          state: 'draft_saved',
          possibleRemoteEffect: true,
          holdsPlatform: false,
        }),
      ),
    ).toEqual({ state: 'draft_saved', pause: false, reason: null });
    expect(
      classifyBatchTask(
        makeDraftTask({ state: 'draft_saved', possibleRemoteEffect: true }),
      ).pause,
    ).toBe(true);
  });
  it('requires human review after interruption or a manually closed ambiguous save', () => {
    for (const state of [
      'needs_human',
      'interrupted',
      'closed_after_review',
      'closed_without_save',
    ] as const) {
      expect(classifyBatchTask(makeDraftTask({ state })).pause).toBe(true);
    }
  });
  it('counts skipped historical successes separately from successes in this batch', () => {
    expect(
      batchCounts([
        { state: 'draft_saved' },
        { state: 'skipped' },
        { state: 'failed' },
        { state: 'queued' },
      ]),
    ).toEqual({
      total: 4,
      saved: 1,
      attempted: 0,
      failed: 1,
      skipped: 1,
      pending: 1,
      needsHuman: 0,
      stopped: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { reduceTask } from '../../src/domain/draft-task';
import type { DraftEvidence, TaskEvent } from '../../src/contracts/draft-task';
import { makeDraftTask } from '../fixtures/draft-task';
const now = '2026-09-23T01:00:00.000Z';
const running = () => reduceTask(makeDraftTask(), { type: 'begin' }, now);
const entering = () =>
  reduceTask(running(), { type: 'before-effect', stage: 'editor' }, now);
const evidence: DraftEvidence = {
  remote: {
    recordKey: 'synthetic-record',
    editUrl: 'https://example.test/edit/record',
  },
  images: [],
  cover: { source: 'store-material-first', resourceKey: 'a'.repeat(64) },
};
describe('draft state safety', () => {
  it('advances revisions without mutating the source', () => {
    const first = makeDraftTask();
    const next = reduceTask(first, { type: 'begin' }, now);
    expect(next).toMatchObject({
      state: 'running',
      revision: 1,
      updatedAt: now,
    });
    expect(first.state).toBe('queued');
  });
  it('never clears effect checkpoints or continues after stop', () => {
    const active = entering();
    const stopped = reduceTask(active, { type: 'stop' }, now);
    expect(stopped.possibleRemoteEffect).toBe(true);
    expect(stopped.stopRequested).toBe(true);
    expect(() => reduceTask(stopped, { type: 'before-save' }, now)).toThrow();
    expect(() =>
      reduceTask(stopped, { type: 'before-effect', stage: 'body' }, now),
    ).toThrow();
    expect(() =>
      reduceTask(
        active,
        { type: 'settle', state: 'failed', reason: 'PAGE_CHANGED' },
        now,
      ),
    ).toThrow();
    expect(() =>
      reduceTask(
        active,
        { type: 'settle', state: 'stopped', reason: 'STOP_REQUESTED' },
        now,
      ),
    ).toThrow();
    expect(reduceTask(stopped, { type: 'verify' }, now).stopRequested).toBe(
      true,
    );
  });
  it('allows save only once and prevents backwards execution', () => {
    const saved = reduceTask(entering(), { type: 'before-save' }, now);
    expect(saved).toMatchObject({
      saveAttempted: true,
      possibleRemoteEffect: true,
      stage: 'save',
    });
    expect(() => reduceTask(saved, { type: 'before-save' }, now)).toThrow();
    expect(() =>
      reduceTask(saved, { type: 'before-effect', stage: 'body' }, now),
    ).toThrow();
  });
  it('keeps ambiguous and recovered tasks occupied without replay', () => {
    for (const task of [makeDraftTask(), entering()]) {
      const recovered = reduceTask(task, { type: 'recover' }, now);
      expect(recovered).toMatchObject({
        state: 'interrupted',
        holdsPlatform: true,
        reason: 'INTERRUPTED',
      });
      expect(() => reduceTask(recovered, { type: 'begin' }, now)).toThrow();
    }
    expect(
      reduceTask(
        entering(),
        { type: 'settle', state: 'needs_human', reason: 'RESULT_AMBIGUOUS' },
        now,
      ).holdsPlatform,
    ).toBe(true);
    expect(
      reduceTask(
        reduceTask(makeDraftTask(), { type: 'recover' }, now),
        { type: 'settle', state: 'stopped', reason: 'STOP_REQUESTED' },
        now,
      ).holdsPlatform,
    ).toBe(false);
  });
  it('requires complete verified evidence and freezes successful tasks', () => {
    let task = reduceTask(entering(), { type: 'verify' }, now);
    expect(() =>
      reduceTask(
        task,
        { type: 'settle', state: 'draft_saved', reason: null },
        now,
      ),
    ).toThrow();
    task = reduceTask(task, { type: 'evidence', evidence }, now);
    const settled = reduceTask(
      task,
      { type: 'settle', state: 'draft_saved', reason: null },
      now,
    );
    expect(settled).toMatchObject({
      holdsPlatform: false,
      state: 'draft_saved',
      stage: 'settled',
    });
    for (const event of [
      { type: 'begin' },
      { type: 'stop' },
      { type: 'recover' },
      { type: 'settle', state: 'failed', reason: 'PAGE_CHANGED' },
    ] as TaskEvent[])
      expect(() => reduceTask(settled, event, now)).toThrow();
  });
  it('merges evidence monotonically and rejects contradictory associations', () => {
    const task = reduceTask(entering(), { type: 'evidence', evidence }, now);
    expect(
      reduceTask(
        task,
        {
          type: 'evidence',
          evidence: { remote: null, images: [], cover: null },
        },
        now,
      ).evidence,
    ).toEqual(evidence);
    expect(
      reduceTask(task, { type: 'evidence', evidence }, now).evidence,
    ).toEqual(evidence);
    expect(() =>
      reduceTask(
        task,
        {
          type: 'evidence',
          evidence: {
            ...evidence,
            remote: { ...evidence.remote!, recordKey: 'different' },
          },
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      reduceTask(
        task,
        {
          type: 'evidence',
          evidence: {
            ...evidence,
            cover: {
              source: 'store-material-first',
              resourceKey: 'b'.repeat(64),
            },
          },
        },
        now,
      ),
    ).toThrow();
  });
  it('releases only safe failed or stopped tasks and rejects terminal replay', () => {
    for (const state of ['failed', 'stopped'] as const) {
      const task = reduceTask(
        makeDraftTask(),
        { type: 'settle', state, reason: 'STOP_REQUESTED' },
        now,
      );
      expect(task.holdsPlatform).toBe(false);
      expect(() => reduceTask(task, { type: 'begin' }, now)).toThrow();
    }
  });
});

it('matches every repeated image block to its snapshot asset before success', () => {
  const original = makeDraftTask();
  const assetKey = '55555555-5555-4555-8555-555555555555';
  const article = {
    ...original.snapshot.article,
    body: [
      { type: 'image' as const, image_id: 'photo' },
      { type: 'image' as const, image_id: 'photo' },
      { type: 'paragraph' as const, text: '离线测试正文。' },
    ],
    assets: [
      {
        assetKey,
        imageId: 'photo',
        relativePath: `${original.articleKey}/${assetKey}.png`,
        mime: 'image/png' as const,
        byteSize: 100,
        width: 10,
        height: 10,
        sha256: 'c'.repeat(64),
      },
    ],
  };
  let task = makeDraftTask({
    state: 'running',
    stage: 'verify',
    possibleRemoteEffect: true,
    snapshot: { version: 1, article, digest: 'd'.repeat(64) },
  });
  const image = {
    bodyIndex: 0,
    imageId: 'photo',
    assetKey,
    resourceKey: 'b'.repeat(64),
  };
  task = reduceTask(
    task,
    { type: 'evidence', evidence: { ...evidence, images: [image] } },
    now,
  );
  expect(() =>
    reduceTask(
      task,
      { type: 'settle', state: 'draft_saved', reason: null },
      now,
    ),
  ).toThrow();
  for (const bad of [
    { ...image, bodyIndex: 2 },
    { ...image, imageId: 'other' },
    { ...image, assetKey: original.taskId },
    { ...image, resourceKey: 'c'.repeat(64) },
  ])
    expect(() =>
      reduceTask(
        task,
        {
          type: 'evidence',
          evidence: { remote: null, cover: null, images: [bad] },
        },
        now,
      ),
    ).toThrow();
  task = reduceTask(
    task,
    {
      type: 'evidence',
      evidence: {
        remote: null,
        cover: null,
        images: [{ ...image, bodyIndex: 1 }],
      },
    },
    now,
  );
  expect(
    reduceTask(
      task,
      { type: 'settle', state: 'draft_saved', reason: null },
      now,
    ).state,
  ).toBe('draft_saved');
});

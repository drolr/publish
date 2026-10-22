import { expect, it, vi } from 'vitest';
import {
  readArticlePreview,
  resetArticlePreviewReads,
} from '../../src/renderer/library/readArticlePreview';
it('serializes article preview consumers and retires stopped queued reads', async () => {
  let release!: () => void;
  const calls: string[] = [];
  const first = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal('window', {
    desktopApi: {
      getArticlePreview: async (key: string) => {
        calls.push(key);
        if (key === 'first') await first;
        return { status: 'not_found' };
      },
    },
  });
  try {
    const a = readArticlePreview('first', () => true);
    const b = readArticlePreview('second', () => true);
    const c = readArticlePreview('stopped', () => false);
    await Promise.resolve();
    expect(calls).toEqual(['first']);
    release();
    await Promise.all([a, b, c]);
    expect(calls).toEqual(['first', 'second']);
    expect(await c).toBe(null);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('a completed stop starts a fresh read lane without waiting for the retired bridge reply', async () => {
  const calls: string[] = [];
  vi.stubGlobal('window', {
    desktopApi: {
      getArticlePreview: (key: string) => {
        calls.push(key);
        return key === 'retired'
          ? new Promise(() => {})
          : Promise.resolve({ status: 'not_found' });
      },
    },
  });
  try {
    void readArticlePreview('retired', () => true);
    await Promise.resolve();
    resetArticlePreviewReads();
    expect(await readArticlePreview('fresh', () => true)).toEqual({
      status: 'not_found',
    });
    expect(calls).toEqual(['retired', 'fresh']);
  } finally {
    resetArticlePreviewReads();
    vi.unstubAllGlobals();
  }
});

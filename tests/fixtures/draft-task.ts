import { createHash } from 'node:crypto';
import type { StoredArticle } from '../../src/contracts/stored-article';
import type { DraftTask } from '../../src/contracts/draft-task';
export function makeDraftTask(overrides: Partial<DraftTask> = {}): DraftTask {
  const now = '2026-09-23T00:00:00.000Z';
  const article: StoredArticle = {
    articleKey: '11111111-1111-4111-8111-111111111111',
    externalId: 'fixture-article',
    importId: '22222222-2222-4222-8222-222222222222',
    title: '平台离线测试文章',
    body: [{ type: 'paragraph', text: '仅用于离线测试。' }],
    contentDeclaration: 'repost',
    createdAt: now,
    assets: [],
  };
  return {
    taskId: '33333333-3333-4333-8333-333333333333',
    preparationId: '44444444-4444-4444-8444-444444444444',
    articleKey: article.articleKey,
    platform: 'judongche',
    mode: 'draft',
    store: {
      storeKey: '1'.repeat(64),
      displayName: '合成门店',
      identity: { source: 'visible-shop-link', value: 'synthetic-store-01' },
    },
    snapshot: {
      version: 1,
      article,
      digest: createHash('sha256')
        .update(JSON.stringify(article))
        .digest('hex'),
    },
    coverPolicy: 'manual-after-draft',
    state: 'queued',
    stage: 'reserved',
    revision: 0,
    possibleRemoteEffect: false,
    saveAttempted: false,
    stopRequested: false,
    holdsPlatform: true,
    evidence: { remote: null, images: [], cover: null },
    reason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

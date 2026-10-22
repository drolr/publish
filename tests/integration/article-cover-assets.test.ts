import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { executeImportSql } from '../../src/infrastructure/persistence/testing/article-fixtures';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createCoverAssetStore } from '../../src/infrastructure/assets/cover-asset-store';
import { readBoundedFile } from '../../src/infrastructure/assets/local-reader';
import { createCoverRecovery } from '../../src/application/cover-recovery';
import type { CoverSaveIntent } from '../../src/contracts/article-cover';
const roots: string[] = [];
const stores: ReturnType<typeof openArticleRepository>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const base = resolve('.tmp/cover-assets');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  roots.push(root);
  const s = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  stores.push(s);
  const a = s.reserve(randomUUID());
  s.commit(a, {
    articleKey: a.articleKey,
    externalId: a.externalId,
    importId: a.importId,
    title: '文章',
    body: [{ type: 'paragraph', text: '正文' }],
    contentDeclaration: 'original',
    createdAt: a.startedAt,
    assets: [],
  });
  const assets = createCoverAssetStore(root, s);
  const intent: CoverSaveIntent = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    articleKey: a.articleKey,
    expectedArticleRevision: 1,
    expectedCoverRevision: 0,
    draftRevision: 0,
    mode: 'single',
    payloadDigest: 'a'.repeat(64),
    startedAt: '2026-10-09T00:00:00.000Z',
  };
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  return {
    root,
    s,
    assets,
    intent,
    bytes,
    signal: new AbortController().signal,
  };
}
it('source_removed_after_commit and none_version_preserves_old_files retain original bytes', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  const source = join(root, 'source.png');
  writeFileSync(source, bytes);
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(
    intent,
    [{ bytes: await readBoundedFile(root, source, signal) }],
    signal,
  );
  expect(s.commitCoverVersion(intent, files).status).toBe('committed');
  unlinkSync(source);
  const config = s.loadCover(intent.articleKey)!;
  expect(hash(await assets.readCoverAsset(config, files[0].assetKey))).toBe(
    hash(bytes),
  );
  const none = {
    ...intent,
    operationId: randomUUID(),
    expectedCoverRevision: 1,
    mode: 'none' as const,
  };
  s.beginCoverSave(none);
  s.commitCoverVersion(none, []);
  expect(s.loadCover(intent.articleKey)?.mode).toBe('none');
  expect(existsSync(join(root, 'covers', files[0].relativePath))).toBe(true);
  await assets.verifyCoverVersion(
    s.loadArchivedCoverVersion(intent.articleKey, 1)!,
  );
});
it('fake_jpeg_and_oversize_and_webp_and_APNG are rejected without changing head', async () => {
  const { s, assets, intent, bytes, signal } = await setup();
  const webp = await sharp(bytes).webp().toBuffer();
  const apng = Buffer.concat([
    bytes.subarray(0, 33),
    Buffer.from([
      0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]),
    bytes.subarray(33),
  ]);
  for (const bad of [
    Buffer.from('fake jpeg'),
    Buffer.alloc(10_000_001),
    webp,
    apng,
  ]) {
    const op = { ...intent, operationId: randomUUID() };
    s.beginCoverSave(op);
    await expect(
      assets.prepareCoverFiles(op, [{ bytes: bad }], signal),
    ).rejects.toThrow();
    expect(s.loadCover(intent.articleKey)?.coverRevision).toBe(0);
  }
});
it('crash_before_and_after_commit recovers persisted journal through fresh connections and keeps committed head', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  s.close();
  const reopened = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  stores.push(reopened);
  const reopenedAssets = createCoverAssetStore(root, reopened);
  expect(
    await createCoverRecovery(
      reopened,
      reopenedAssets,
    ).recoverCoverOperations(),
  ).toBe(true);
  expect(reopened.loadCover(intent.articleKey)?.coverRevision).toBe(0);
  expect(existsSync(join(root, 'covers', files[0].relativePath))).toBe(false);
  expect(reopened.readCoverSaveResult(intent.operationId).status).toBe(
    'failed',
  );
  const op = { ...intent, operationId: randomUUID() };
  reopened.beginCoverSave(op);
  const committed = await reopenedAssets.prepareCoverFiles(
    op,
    [{ bytes }],
    signal,
  );
  const result = reopened.commitCoverVersion(op, committed);
  reopened.close();
  const afterCommit = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  stores.push(afterCommit);
  const afterAssets = createCoverAssetStore(root, afterCommit);
  const recovery = createCoverRecovery(afterCommit, afterAssets);
  expect(await recovery.recoverCoverOperations()).toBe(true);
  expect(await recovery.recoverCoverOperations()).toBe(true);
  expect(afterCommit.readCoverSaveResult(op.operationId)).toEqual(result);
  expect(afterCommit.loadCover(op.articleKey)?.coverRevision).toBe(1);
  expect(
    hash(readFileSync(join(root, 'covers', committed[0].relativePath))),
  ).toBe(hash(bytes));
});
it('foreign_asset_and_unknown_ownership fail closed without deleting files', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  s.commitCoverVersion(intent, files);
  const config = s.loadCover(intent.articleKey)!;
  await expect(
    assets.readCoverAsset(
      { ...config, articleKey: randomUUID() },
      files[0].assetKey,
    ),
  ).rejects.toThrow();
  const op = { ...intent, operationId: randomUUID(), expectedCoverRevision: 1 };
  s.beginCoverSave(op);
  const abandoned = await assets.prepareCoverFiles(op, [{ bytes }], signal);
  writeFileSync(
    join(root, 'covers', op.articleKey, op.operationId, 'unknown.txt'),
    'foreign',
  );
  const recovery = createCoverRecovery(s, assets);
  expect(await recovery.recoverCoverOperations()).toBe(false);
  expect(recovery.isReady()).toBe(false);
  expect(
    s.listCoverOperations().find((v) => v.operationId === op.operationId)
      ?.status,
  ).toBe('needs_review');
  expect(existsSync(join(root, 'covers', abandoned[0].relativePath))).toBe(
    true,
  );
});
it('symlink_source_and_replaced_owned_file are rejected', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  const sourceDir = join(root, 'source');
  mkdirSync(sourceDir);
  const source = join(sourceDir, 'source.png');
  const link = join(root, 'linked');
  writeFileSync(source, bytes);
  symlinkSync(sourceDir, link, 'junction');
  await expect(
    readBoundedFile(root, join(link, 'source.png'), signal),
  ).rejects.toThrow();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  const target = join(root, 'covers', files[0].relativePath);
  unlinkSync(target);
  writeFileSync(target, bytes);
  const recovery = createCoverRecovery(s, assets);
  expect(await recovery.recoverCoverOperations()).toBe(false);
  expect(existsSync(target)).toBe(true);
});

it.each(['missing_extension', 'bad_snapshot_digest', 'bad_operation'] as const)(
  'unknown reference (%s) keeps every owned file and write admission closed',
  async (kind) => {
    const { root, s, assets, intent, bytes, signal } = await setup();
    s.beginCoverSave(intent);
    const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
    const db = join(root, 'app.sqlite');
    if (kind === 'bad_operation')
      executeImportSql(
        db,
        `UPDATE article_cover_operations SET owned_files_json='[{}]' WHERE operation_id='${intent.operationId}'`,
      );
    else {
      executeImportSql(
        db,
        `INSERT INTO judongche_draft_tasks (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,created_at,updated_at,cover_plan_version) SELECT 'task','p',article_key,'judongche','draft','s','{}','{}','d','manual-after-draft','draft_saved','settled',1,1,1,0,0,'[]',created_at,created_at,1 FROM articles`,
      );
      if (kind === 'bad_snapshot_digest')
        executeImportSql(
          db,
          `INSERT INTO judongche_task_covers VALUES('task','local-upload-v1','{}','digest','{}')`,
        );
    }
    const recovery = createCoverRecovery(s, assets);
    expect(await recovery.recover()).toBe(false);
    expect(recovery.isReady()).toBe(false);
    expect(existsSync(join(root, 'covers', files[0].relativePath))).toBe(true);
    expect(s.loadCover(intent.articleKey)?.coverRevision).toBe(0);
  },
);
it('committed definite file absence retains receipt/head and permits body recovery with per-cover IMAGE_UNAVAILABLE', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  const result = s.commitCoverVersion(intent, files);
  unlinkSync(join(root, 'covers', files[0].relativePath));
  const recovery = createCoverRecovery(s, assets);
  expect(await recovery.recover()).toBe(true);
  await expect(
    assets.verifyCoverVersion(s.loadCover(intent.articleKey)!),
  ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  await expect(
    assets.readCoverAsset(s.loadCover(intent.articleKey)!, files[0].assetKey),
  ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  expect(s.readCoverSaveResult(intent.operationId)).toEqual(result);
  expect(s.loadCover(intent.articleKey)?.coverRevision).toBe(1);
  expect(s.readCoverOperation(intent.operationId)?.status).toBe('committed');
});
it('removed marker never authorizes deletion; aborted pre-copy preparation leaves old head', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  unlinkSync(
    join(root, 'covers', intent.articleKey, intent.operationId, '.owner.json'),
  );
  expect(await createCoverRecovery(s, assets).recover()).toBe(false);
  expect(existsSync(join(root, 'covers', files[0].relativePath))).toBe(true);
  const op = { ...intent, operationId: randomUUID() };
  s.beginCoverSave(op);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    assets.prepareCoverFiles(op, [{ bytes }], aborted.signal),
  ).rejects.toThrow();
  expect(s.loadCover(intent.articleKey)?.coverRevision).toBe(0);
});
it('ordered triple copies JPEG/PNG without body assets or image-count changes', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  const jpeg = await sharp(bytes).jpeg().toBuffer();
  const blue = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  const op = { ...intent, mode: 'triple' as const };
  s.beginCoverSave(op);
  const files = await assets.prepareCoverFiles(
    op,
    [{ bytes }, { bytes: jpeg }, { bytes: blue }],
    signal,
  );
  expect(s.commitCoverVersion(op, files).status).toBe('committed');
  const config = s.loadCover(op.articleKey)!;
  expect(config.assets.map((a) => a.sha256)).toEqual([
    hash(bytes),
    hash(jpeg),
    hash(blue),
  ]);
  for (const file of files)
    expect(hash(await assets.readCoverAsset(config, file.assetKey))).toBe(
      file.sha256,
    );
  expect(s.loadEditableArticle(op.articleKey)?.article.assets).toEqual([]);
  expect(s.list!()).toMatchObject({
    status: 'ok',
    page: { totalCount: 1, items: [{ imageCount: 0, articleRevision: 1 }] },
  });
  expect(
    existsSync(
      join(root, 'covers', op.articleKey, op.operationId, '.owner.json'),
    ),
  ).toBe(true);
});

it('triple definite missing file cannot mask unknown ownership in another committed file', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  const op = { ...intent, mode: 'triple' as const };
  s.beginCoverSave(op);
  const files = await assets.prepareCoverFiles(
    op,
    [{ bytes }, { bytes }, { bytes }],
    signal,
  );
  s.commitCoverVersion(op, files);
  unlinkSync(join(root, 'covers', files[0].relativePath));
  const unknown = join(root, 'covers', files[1].relativePath);
  unlinkSync(unknown);
  writeFileSync(unknown, bytes);
  const recovery = createCoverRecovery(s, assets);
  expect(await recovery.recover()).toBe(false);
  expect(s.readCoverOperation(op.operationId)?.status).toBe('needs_review');
  expect(existsSync(unknown)).toBe(true);
});
it('definite committed file absence cannot mask a malformed task reference', async () => {
  const { root, s, assets, intent, bytes, signal } = await setup();
  s.beginCoverSave(intent);
  const files = await assets.prepareCoverFiles(intent, [{ bytes }], signal);
  s.commitCoverVersion(intent, files);
  unlinkSync(join(root, 'covers', files[0].relativePath));
  executeImportSql(
    join(root, 'app.sqlite'),
    "INSERT INTO judongche_draft_tasks (task_id,preparation_id,article_key,platform,mode,store_key,store_json,snapshot_json,snapshot_digest,cover_policy,state,stage,revision,possible_remote_effect,save_attempted,stop_requested,holds_platform,evidence_json,created_at,updated_at,cover_plan_version) SELECT 'task','p',article_key,'judongche','draft','s','{}','{}','d','manual-after-draft','draft_saved','settled',1,1,1,0,0,'[]',created_at,created_at,1 FROM articles",
  );
  expect(await createCoverRecovery(s, assets).recover()).toBe(false);
  expect(s.readCoverOperation(intent.operationId)?.status).toBe('needs_review');
});
it.each(['changed_identity', 'bad_bytes'] as const)(
  'direct missing-image read verifies remaining committed files before recoverable absence: %s',
  async (damage) => {
    const { root, s, assets, intent, bytes, signal } = await setup();
    const op = { ...intent, mode: 'triple' as const };
    s.beginCoverSave(op);
    const files = await assets.prepareCoverFiles(
      op,
      [{ bytes }, { bytes }, { bytes }],
      signal,
    );
    const committed = s.commitCoverVersion(op, files);
    const config = s.loadCover(op.articleKey)!;
    expect(await createCoverRecovery(s, assets).recover()).toBe(true);
    unlinkSync(join(root, 'covers', files[0].relativePath));
    const damaged = join(root, 'covers', files[1].relativePath);
    if (damage === 'changed_identity') {
      unlinkSync(damaged);
      writeFileSync(damaged, bytes);
    } else {
      writeFileSync(damaged, Buffer.from('corrupt owned cover bytes'));
    }
    let rejection: unknown;
    try {
      await assets.readCoverAsset(config, files[0].assetKey);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    expect(rejection).toMatchObject({
      message:
        damage === 'changed_identity'
          ? 'Cover replaced'
          : 'Cover bytes changed',
    });
    expect(s.readCoverSaveResult(op.operationId)).toEqual(committed);
    expect(s.loadCover(op.articleKey)).toEqual(config);
    expect(s.readCoverOperation(op.operationId)?.status).toBe('committed');
    expect(existsSync(damaged)).toBe(true);
  },
);

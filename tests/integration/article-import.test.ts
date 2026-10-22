import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import {
  authorizeLocalRoot,
  readLocalImage,
} from '../../src/infrastructure/assets/local-reader';
import { createArticleImportService } from '../../src/application/article-import';
import { ImportFailure } from '../../src/domain/import-error';
import { createManualArticleController } from '../../src/application/manual-article';
import { createManualImageSource } from '../../src/infrastructure/assets/manual-image-source';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
import type { ManualState } from '../../src/contracts/manual-article';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
const input = {
  schema_version: 1,
  article_id: 'article',
  title: 'Title',
  body: [
    { type: 'paragraph', text: 'Body' },
    { type: 'image', image_id: 'i' },
    { type: 'image', image_id: 'i' },
  ],
  images: [{ image_id: 'i', source: { type: 'local', path: 'image.png' } }],
};
async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'article-import-'));
  roots.push(root);
  return root;
}
function manualSession(state: ManualState) {
  if (!('sessionId' in state)) throw new Error('Expected manual session');
  return state;
}
async function pastedRuntime(root: string) {
  const temp = createManualTempStore(root);
  expect(await temp.recover()).toBe(true);
  const source = createManualImageSource(temp);
  const repository = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  const assets = createAssetStore(join(root, 'assets'));
  const service = createArticleImportService(repository, assets, {
    read: async (image, capability, signal) => {
      if (image.type !== 'local' || capability?.kind !== 'manual-images')
        throw new ImportFailure('SOURCE_NOT_ALLOWED');
      return source.readCapability(capability, image.path, signal);
    },
  });
  expect(await service.recover()).toBe(true);
  let acquisitions = 0;
  const controller = createManualArticleController({
    newId: randomUUID,
    externalExists: (id) => !!repository.findExternal(id),
    gate: () => 'ready',
    converter: {
      convert: async () => ({
        blocks: [
          { type: 'paragraph', text: '正文' },
          { type: 'image', source: 'https://example.com/private-image' },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async (session, _, signal) => {
        acquisitions++;
        return source.authorizeBytes(session, png, signal);
      },
    },
    fingerprint: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    chooseImage: async () => undefined,
    readImage: source.read,
    retainImages: source.retain,
    releaseImages: source.release,
    save: (value, session, signal) =>
      service.importArticle(value, {
        capability: source.capability(session),
        signal,
      }),
  });
  const initial = manualSession(
    (await controller.beginManualArticle()).snapshot,
  );
  const edited = manualSession(
    (
      await controller.updateManualDraft(initial.sessionId, initial.revision, {
        ...initial.draft,
        title: '保存的图文',
      })
    ).snapshot,
  );
  await controller.startManualPaste(
    {
      sessionId: edited.sessionId,
      expectedRevision: edited.revision,
      commandId: edited.nextPasteCommandId,
    },
    {
      html: '<p>正文</p><img src="https://example.com/private-image">',
      plain: '正文',
    },
  );
  await vi.waitFor(() => expect(controller.isActive()).toBe(false), {
    timeout: 5000,
  });
  const ready = manualSession(controller.getManualArticleState());
  expect(ready.images).toHaveLength(1);
  expect(ready.candidates).toEqual([]);
  return {
    controller,
    repository,
    service,
    ready,
    acquisitions: () => acquisitions,
  };
}
it.each(['preview', 'save'] as const)(
  'fails closed when sealed paste bytes are corrupted before %s',
  async (mode) => {
    const root = await rootDirectory();
    const runtime = await pastedRuntime(root);
    try {
      const { ready, controller, repository } = runtime;
      const directory = join(root, 'data/manual-temp', ready.sessionId);
      const bin = (await readdir(directory)).find((file) =>
        file.endsWith('.bin'),
      )!;
      await writeFile(join(directory, bin), Buffer.alloc(png.length));
      if (mode === 'preview')
        expect(
          await controller.getManualImage(
            ready.sessionId,
            ready.images[0].imageToken,
          ),
        ).toEqual({ status: 'unavailable' });
      else {
        controller.saveManualArticle(ready.sessionId, ready.revision);
        await vi.waitFor(() => expect(controller.isActive()).toBe(false), {
          timeout: 5000,
        });
      }
      expect(controller.isBlocked()).toBe(true);
      expect(
        manualSession(controller.getManualArticleState()).result,
      ).toMatchObject({ status: 'failed', code: 'RECOVERY_REQUIRED' });
      expect((await controller.beginManualArticle()).status).toBe(
        'unavailable',
      );
      expect(repository.findExternal(ready.externalId)).toBeUndefined();
      expect(runtime.acquisitions()).toBe(1);
      expect(JSON.stringify(controller.getManualArticleState())).not.toContain(
        'private-image',
      );
      expect(JSON.stringify(controller.getManualArticleState())).not.toContain(
        root,
      );
    } finally {
      runtime.repository.close();
    }
  },
);
it('saves pasted verified bytes once and reopens formal assets after temporary cleanup', async () => {
  const root = await rootDirectory();
  const runtime = await pastedRuntime(root);
  let key: string;
  try {
    const { controller, ready } = runtime;
    controller.saveManualArticle(ready.sessionId, ready.revision);
    await vi.waitFor(() => expect(controller.isActive()).toBe(false), {
      timeout: 5000,
    });
    const after = manualSession(controller.getManualArticleState());
    expect(after.result?.status).toBe('imported');
    if (after.result?.status !== 'imported') throw new Error('Expected commit');
    key = after.result.articleKey;
    expect(
      controller.saveManualArticle(ready.sessionId, ready.revision).status,
    ).toBe('ok');
    expect(runtime.acquisitions()).toBe(1);
    expect(await readdir(join(root, 'data/manual-temp'))).toEqual([]);
  } finally {
    runtime.repository.close();
  }
  const reopened = open(root);
  try {
    expect(await reopened.service.recover()).toBe(true);
    const article = await reopened.service.load(key);
    expect(article?.body.map((b) => b.type)).toEqual(['paragraph', 'image']);
    expect(
      await readFile(join(root, 'assets', article!.assets[0].relativePath)),
    ).toEqual(png);
    expect(JSON.stringify(article)).not.toContain('manual-temp');
  } finally {
    reopened.repository.close();
  }
});
function open(root: string) {
  const repository = openArticleRepository(
    join(root, 'app.sqlite'),
    resolve('src/infrastructure/persistence/migrations'),
  );
  const assets = createAssetStore(join(root, 'assets'));
  const service = createArticleImportService(repository, assets, {
    read: (source, capability, signal) => {
      if (source.type !== 'local' || capability?.kind !== 'local-root')
        throw new ImportFailure('SOURCE_NOT_ALLOWED');
      return readLocalImage(capability, source.path, signal);
    },
  });
  return { repository, assets, service };
}
it('persists one verified asset for repeated references and survives deletion of source and restart', async () => {
  const root = await rootDirectory();
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'image.png'), png);
  let runtime = open(root);
  let key: string;
  try {
    expect(await runtime.service.recover()).toBe(true);
    const result = await runtime.service.importArticle(input, {
      capability: await authorizeLocalRoot(source),
    });
    expect(result.status).toBe('imported');
    if (result.status !== 'imported') throw new Error('import');
    key = result.article.articleKey;
    expect(result.article.assets).toHaveLength(1);
    expect(JSON.stringify(result.article)).not.toContain(source);
    await rm(source, { recursive: true });
  } finally {
    runtime.repository.close();
  }
  runtime = open(root);
  try {
    expect(await runtime.service.recover()).toBe(true);
    const article = await runtime.service.load(key!);
    expect(article?.body).toEqual(input.body);
    await writeFile(
      join(root, 'assets', article!.assets[0].relativePath),
      Buffer.alloc(png.length),
    );
    await expect(runtime.service.load(key!)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  } finally {
    runtime.repository.close();
  }
});
it('rolls back all assets when the second local image is missing', async () => {
  const root = await rootDirectory();
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'image.png'), png);
  const runtime = open(root);
  try {
    await runtime.service.recover();
    const result = await runtime.service.importArticle(
      {
        ...input,
        body: [...input.body, { type: 'image', image_id: 'missing' }],
        images: [
          ...input.images,
          {
            image_id: 'missing',
            source: { type: 'local', path: 'missing.png' },
          },
        ],
      },
      { capability: await authorizeLocalRoot(source) },
    );
    expect(result).toMatchObject({
      status: 'failed',
      imageIndex: 1,
      code: 'IMAGE_UNAVAILABLE',
    });
    expect(runtime.repository.findExternal('article')).toBeUndefined();
    expect(runtime.repository.attempts()).toEqual([]);
    expect(await readdir(join(root, 'assets', '.staging'))).toEqual([]);
    expect(await readFile(join(source, 'image.png'))).toEqual(png);
  } finally {
    runtime.repository.close();
  }
});
it('preserves durable attempts under a real Windows exclusive lock and recovers after release', async () => {
  const root = await rootDirectory();
  const runtime = open(root);
  const attempt = runtime.repository.reserve('locked');
  await runtime.assets.prepare(attempt, new AbortController().signal);
  const asset = await runtime.assets.put(
    attempt,
    'i',
    png,
    new AbortController().signal,
  );
  const path = join(
    root,
    'assets',
    '.staging',
    attempt.importId,
    asset.relativePath.split('/')[1],
  );
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$stream = [System.IO.File]::Open($env:IMPORT_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); try { [Console]::WriteLine("locked"); [Console]::Out.Flush(); [Console]::ReadLine() } finally { $stream.Dispose() }',
    ],
    {
      env: { ...process.env, IMPORT_LOCK_PATH: path },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('lock timeout')), 10000);
      child.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        if (String(chunk).includes('locked')) done();
        else reject(new Error('lock failed'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('lock exited'));
      });
    });
    expect(await runtime.service.recover()).toBe(false);
    expect(runtime.repository.attempts()).toMatchObject([
      { status: 'cleanup_required' },
    ]);
    expect(await runtime.service.importArticle(input)).toMatchObject({
      status: 'failed',
      code: 'RECOVERY_REQUIRED',
    });
  } finally {
    child.stdin.end('\n');
    await exited;
    runtime.repository.close();
  }
  const restarted = open(root);
  try {
    expect(await restarted.service.recover()).toBe(true);
    expect(restarted.repository.attempts()).toEqual([]);
  } finally {
    restarted.repository.close();
  }
}, 20000);
it.each([
  'reserved',
  'prepared',
  'writing',
  'renamed',
  'before-commit',
  'committed',
])(
  'recovers after externally killed child at %s',
  async (phase) => {
    const root = await rootDirectory();
    const initial = open(root);
    let keptKey: string;
    try {
      await initial.service.recover();
      const kept = await initial.service.importArticle({
        ...input,
        article_id: 'keep',
        body: [input.body[0]],
        images: [],
      });
      if (kept.status !== 'imported') throw new Error('seed failed');
      keptKey = kept.article.articleKey;
    } finally {
      initial.repository.close();
    }
    await mkdir(join(root, 'assets', 'foreign'));
    await writeFile(join(root, 'assets', 'foreign', 'keep.txt'), 'keep');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('tests/integration/import-crash-child.ts'),
        root,
        phase,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<void>((done) =>
      child.once('exit', () => done()),
    );
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`checkpoint timeout ${stderr}`)),
          15000,
        );
        child.once('message', () => {
          clearTimeout(timer);
          done();
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`early exit ${code} ${stderr}`));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const runtime = open(root);
    try {
      expect(await runtime.service.recover()).toBe(true);
      expect(runtime.repository.attempts()).toEqual([]);
      expect(await runtime.service.load(keptKey!)).toMatchObject({
        externalId: 'keep',
      });
      expect(
        await readFile(join(root, 'assets', 'foreign', 'keep.txt'), 'utf8'),
      ).toBe('keep');
      const article = runtime.repository.findExternal('crash');
      if (phase === 'committed') {
        expect(article).toBeDefined();
        await runtime.assets.verify(article!);
      } else {
        expect(article).toBeUndefined();
        const entries = await readdir(join(root, 'assets')).catch(() => []);
        expect(entries.filter((name) => name !== '.staging').sort()).toEqual(
          [keptKey!, 'foreign'].sort(),
        );
      }
    } finally {
      runtime.repository.close();
    }
  },
  20000,
);

it('deleted_external_id_import returns feedback without image reads, resurrection or membership changes', async () => {
  const root = await rootDirectory();
  const path = join(root, 'app.sqlite'),
    migrations = resolve('src/infrastructure/persistence/migrations');
  let repository = openArticleRepository(path, migrations);
  try {
    const assets = createAssetStore(join(root, 'assets'));
    const reader = { read: vi.fn(async () => png) };
    const service = createArticleImportService(repository, assets, reader);
    expect(await service.recover()).toBe(true);
    const imported = await service.importArticle(input);
    if (imported.status !== 'imported') throw new Error('Expected import');
    const operationId = randomUUID(),
      articleKey = imported.article.articleKey;
    const beforeDeletedImport = await service.importArticle(input);
    expect(beforeDeletedImport.status).toBe('already_exists');
    const deletionModule = await import('../../src/application/article-delete');
    const deletion = deletionModule.createArticleDeletion({
      repository,
      gate: () => 'ready',
      now: () => '2026-10-09T00:00:00.000Z',
    });
    const deleted = await deletion.deleteArticle({
      operationId,
      articleKey,
      expectedArticleRevision: 1,
    });
    expect(deleted).toEqual({
      status: 'deleted',
      operationId,
      articleKey,
      articleRevision: 2,
    });
    const page = repository.list!();
    expect(page).toMatchObject({ status: 'ok', page: { totalCount: 0 } });
    repository.close();
    repository = openArticleRepository(path, migrations);
    reader.read.mockClear();
    const restartedImport = createArticleImportService(
      repository,
      assets,
      reader,
    );
    expect(await restartedImport.recover()).toBe(true);
    const result = await restartedImport.importArticle(input);
    expect(result).toMatchObject({
      status: 'already_deleted',
      article: { articleKey, title: 'Title' },
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(repository.list!()).toEqual(page);
    expect(repository.findExternalState('article')?.kind).toBe('deleted');
    expect(repository.loadArchivedEditableArticle(articleKey)).toBeDefined();
    await assets.verify(imported.article);
    const { createImportController } =
      await import('../../src/application/import-controller');
    const controller = createImportController({
      newId: randomUUID,
      choose: async () => ({
        input,
        capability: { kind: 'local-root' as const },
      }),
      importArticle: restartedImport.importArticle,
    });
    controller.start();
    await vi.waitFor(() => expect(controller.isActive()).toBe(false));
    expect(controller.snapshot()).toMatchObject({
      state: 'finished',
      result: { status: 'already_deleted', articleKey, title: 'Title' },
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(repository.list!()).toEqual(page);
    const deleteSpy = vi.spyOn(repository, 'deleteArticle');
    const restartedDeletion = deletionModule.createArticleDeletion({
      repository,
      gate: () => 'unavailable',
      now: () => '2026-10-09T01:00:00.000Z',
    });
    expect(
      await restartedDeletion.getArticleDeletionResult(operationId),
    ).toEqual({
      status: 'deleted',
      operationId,
      articleKey,
      articleRevision: 2,
    });
    expect(deleteSpy).not.toHaveBeenCalled();
    const readyDeletion = deletionModule.createArticleDeletion({
      repository,
      gate: () => 'ready',
      now: () => '2026-10-09T01:00:00.000Z',
    });
    expect(
      await readyDeletion.deleteArticle({
        operationId,
        articleKey,
        expectedArticleRevision: 2,
      }),
    ).toEqual({ status: 'blocked', operationId });
    expect(repository.list!()).toEqual(page);
  } finally {
    repository.close();
  }
});

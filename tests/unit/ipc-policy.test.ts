import { expect, it } from 'vitest';
import { isTrustedSender } from '../../src/desktop/main/ipc-policy';
it('only accepts the owned main frame at the exact entry URL', () => {
  const frame = { url: 'file:///app/index.html' };
  const contents = { mainFrame: frame };
  const event = { sender: contents, senderFrame: frame };
  expect(isTrustedSender(event, contents, frame.url)).toBe(true);
  expect(isTrustedSender(event, { mainFrame: frame }, frame.url)).toBe(false);
  expect(
    isTrustedSender(
      { ...event, senderFrame: { ...frame } },
      contents,
      frame.url,
    ),
  ).toBe(false);
  expect(
    isTrustedSender({ ...event, senderFrame: null }, contents, frame.url),
  ).toBe(false);
  for (const url of [
    'file:///app/index.html?bad=1',
    'file:///app/index.html#bad',
    'https://untrusted.invalid/',
    'file:///app/other.html',
  ]) {
    frame.url = url;
    expect(isTrustedSender(event, contents, 'file:///app/index.html')).toBe(
      false,
    );
  }
});

import {
  createLibraryWriteGate,
  createArticleWriteRecovery,
} from '../../src/desktop/main/library-write-gate';
import { createArticleDeclarations } from '../../src/application/article-declaration';
import { createImportController } from '../../src/application/import-controller';
import { manualFixture, deferred, flush, id } from '../helpers/manual-desktop';
import type { ArticleRepository } from '../../src/domain/ports/article-import';
it('startup recovery opens no write entry until formal-first and temp cleanup both settle', async () => {
  // Parallel or early admission changes must allow a write while recovery is pending.
  const formal = deferred<boolean>();
  const temporary = deferred<boolean>();
  const order: string[] = [];
  const recovery = createArticleWriteRecovery(
    {
      recover: async () => {
        order.push('formal');
        return formal.promise;
      },
    },
    {
      recover: async () => {
        order.push('temporary');
        return temporary.promise;
      },
    },
  );
  const running = recovery.recover();
  expect(recovery.isReady()).toBe(false);
  expect(order).toEqual(['formal']);
  formal.resolve(true);
  await flush();
  expect(order).toEqual(['formal', 'temporary']);
  expect(recovery.isReady()).toBe(false);
  temporary.resolve(true);
  expect(await running).toBe(true);
  expect(recovery.isReady()).toBe(true);
});
it.each(['formal-false', 'temp-false', 'temp-throws'] as const)(
  'startup_temp_recovery_failure_blocks_all_writes: %s',
  async (failure) => {
    const order: string[] = [];
    const recovery = createArticleWriteRecovery(
      {
        recover: async () => {
          order.push('formal');
          return failure !== 'formal-false';
        },
      },
      {
        recover: async () => {
          order.push('temporary');
          if (failure === 'temp-throws') throw new Error('C:/private');
          return false;
        },
      },
    );
    let chosen = false;
    const imports = createImportController({
      newId: () => id(90),
      choose: async () => {
        chosen = true;
        return undefined;
      },
      importArticle: async () => ({ status: 'cancelled' }),
    });
    const { manual } = manualFixture({
      gate: () => (recovery.isReady() ? 'ready' : 'unavailable'),
    });
    const gate = createLibraryWriteGate({
      available: recovery.isReady,
      isClosing: () => false,
      manual,
      imports,
    });
    let declaration: 'original' | 'repost' = 'repost';
    const declarations = createArticleDeclarations(
      {
        setArticleDeclarations: () => {
          declaration = 'original';
          return { status: 'unavailable' };
        },
      } as unknown as ArticleRepository,
      gate.state,
    );
    expect(await recovery.recover()).toBe(false);
    expect(recovery.isReady()).toBe(false);
    expect(order).toEqual(
      failure === 'formal-false' ? ['formal'] : ['formal', 'temporary'],
    );
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
    expect(imports.snapshot()).toEqual({ state: 'idle', revision: 0 });
    expect(chosen).toBe(false);
    expect(
      declarations.setArticleDeclarations({
        targets: [{ articleKey: id(80), expectedDeclaration: 'repost' }],
        declaration: 'original',
      }),
    ).toEqual({ status: 'unavailable' });
    expect(declaration).toBe('repost');
    expect((await manual.beginManualArticle()).status).toBe('unavailable');
    const command = { sessionId: id(1), expectedRevision: 0, commandId: id(4) };
    expect(
      (await manual.startManualPaste(command, { html: '', plain: 'Body' }))
        .status,
    ).toBe('conflict');
    expect((await manual.retryManualPasteImage(command, id(5))).status).toBe(
      'conflict',
    );
    expect(
      (
        await manual.updateManualDraft(id(1), 0, {
          title: 'Body',
          contentDeclaration: 'repost',
          blocks: [],
        })
      ).status,
    ).toBe('unavailable');
    expect(manual.pickManualImage(id(1), 0).status).toBe('unavailable');
    expect(manual.saveManualArticle(id(1), 0).status).toBe('unavailable');
    expect((await manual.discardManualArticle(id(1), 0)).status).toBe(
      'unavailable',
    );
    expect(manual.getManualArticleState()).toEqual({
      state: 'idle',
      revision: 0,
    });
  },
);

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createArticleImportService } from '../../src/application/article-import';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';

it('startup temp recovery preserves an unknown real file after formal service recovery and blocks all article writers', async () => {
  const base = path.resolve('.tmp/task5-startup');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  // The immutable absolute cleanup target must stay in this test's workspace subtree.
  if (!path.resolve(root).startsWith(base + path.sep))
    throw new Error('Unsafe test cleanup');
  try {
    const temporary = path.join(root, 'data/manual-temp');
    await fs.mkdir(temporary, { recursive: true });
    const unknown = path.join(temporary, 'unknown.bin');
    await fs.writeFile(unknown, 'foreign bytes');
    let pending = [
      {
        importId: id(81),
        articleKey: id(80),
        externalId: 'stale',
        startedAt: '2026-10-06T00:00:00.000Z',
        status: 'preparing' as const,
      },
    ];
    let writes = 0;
    const repository: ArticleRepository = {
      attempts: () => pending,
      findExternal: () => undefined,
      findExternalState: () => undefined,
      findImport: () => undefined,
      load: () => undefined,
      reserve: () => {
        writes++;
        throw new Error('Unexpected reserve');
      },
      commit: () => {
        writes++;
      },
      markAttempt: () => {},
      forgetAttempt: () => {
        pending = [];
      },
      getSchemaVersion: () => 2,
      close: () => {},
      setArticleDeclarations: () => {
        writes++;
        return { status: 'unavailable' };
      },
    };
    const service = createArticleImportService(
      repository,
      createAssetStore(path.join(root, 'assets')),
      {
        read: async () => {
          throw new Error('Unexpected fetch');
        },
      },
    );
    const temp = createManualTempStore(root);
    const recovery = createArticleWriteRecovery(service, {
      recover: async () => {
        // Formal cleanup has forgotten the stale reservation before temp touches disk.
        expect(pending).toEqual([]);
        return temp.recover();
      },
    });
    const imports = createImportController({
      newId: () => id(90),
      choose: async () => {
        throw new Error('Unexpected picker');
      },
      importArticle: service.importArticle,
    });
    const { manual } = manualFixture({
      gate: () => (recovery.isReady() ? 'ready' : 'unavailable'),
    });
    const gate = createLibraryWriteGate({
      available: recovery.isReady,
      isClosing: () => false,
      imports,
      manual,
    });
    const declarations = createArticleDeclarations(repository, gate.state);
    expect(await recovery.recover()).toBe(false);
    expect(gate.state()).toBe('unavailable');
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
    expect(
      declarations.setArticleDeclarations({
        targets: [{ articleKey: id(80), expectedDeclaration: 'repost' }],
        declaration: 'original',
      }),
    ).toEqual({ status: 'unavailable' });
    expect((await manual.beginManualArticle()).status).toBe('unavailable');
    expect(writes).toBe(0);
    expect(await fs.readFile(unknown, 'utf8')).toBe('foreign bytes');
    expect(imports.snapshot()).toEqual({ state: 'idle', revision: 0 });
    expect(manual.getManualArticleState()).toEqual({
      state: 'idle',
      revision: 0,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it.each([true, false])(
  'cover recovery settles after formal/body recovery and controls normal admission (%s)',
  async (success) => {
    const order: string[] = [];
    const cover = {
      recover: async () => {
        order.push('cover');
        return success;
      },
    };
    const recovery = createArticleWriteRecovery(
      {
        recover: async () => {
          order.push('formal');
          return true;
        },
      },
      {
        recover: async () => {
          order.push('temporary');
          return true;
        },
      },
      {
        recover: async () => {
          order.push('body');
          return true;
        },
      },
      cover,
    );
    expect(await recovery.recover()).toBe(success);
    expect(recovery.isReady()).toBe(success);
    expect(order).toEqual(
      success
        ? ['formal', 'body', 'cover', 'temporary']
        : ['formal', 'body', 'cover'],
    );
  },
);

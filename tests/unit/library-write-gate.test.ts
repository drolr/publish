import { expect, it } from 'vitest';
import { createManualArticleController } from '../../src/application/manual-article';
import { createImportController } from '../../src/application/import-controller';
import { createArticleDeclarations } from '../../src/application/article-declaration';
import { createLibraryWriteGate } from '../../src/desktop/main/library-write-gate';
import type { ArticleRepository } from '../../src/domain/ports/article-import';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function flush() {
  for (let n = 0; n < 16; n++) await Promise.resolve();
}
it.each(['resolve', 'reject'] as const)(
  'excludes actual JSON and F06 writes through %s successful-save cleanup',
  async (cleanup) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let next = 0;
    const manual = createManualArticleController({
      newId: () => id(++next),
      converter: { convert: async () => ({ blocks: [], plainOnly: true }) },
      pasteImages: {
        acquire: async () => {
          throw new Error('unexpected image');
        },
      },
      fingerprint: JSON.stringify,
      externalExists: () => false,
      gate: () => 'ready',
      chooseImage: async () => undefined,
      readImage: async () => ({
        mime: 'image/png',
        bytes: new Uint8Array([1]),
      }),
      retainImages: async () => {},
      releaseImages: async () => {
        await released;
        if (cleanup === 'reject') throw new Error('private');
      },
      save: async () => ({
        status: 'imported',
        warnings: [],
        article: {
          articleKey: id(80),
          importId: id(81),
          externalId: 'manual-' + id(2),
          title: 'saved',
          contentDeclaration: 'repost',
          createdAt: '2026-10-06T00:00:00.000Z',
          body: [{ type: 'paragraph', text: 'body' }],
          assets: [],
        },
      }),
    });
    const imports = createImportController({
      newId: () => id(90),
      choose: async () => undefined,
      importArticle: async () => ({ status: 'cancelled' }),
    });
    const gate = createLibraryWriteGate({
      available: () => true,
      isClosing: () => false,
      manual,
      imports,
    });
    let declaration: 'original' | 'repost' = 'repost';
    const repository = {
      setArticleDeclarations: () => {
        declaration = 'original';
        return {
          status: 'updated',
          items: [
            {
              articleKey: id(80),
              externalId: 'saved',
              title: 'saved',
              contentDeclaration: declaration,
            },
          ],
          changedCount: 1,
          unchangedCount: 0,
        };
      },
    } as unknown as ArticleRepository;
    const declarations = createArticleDeclarations(repository, gate.state);
    const change = {
      targets: [{ articleKey: id(80), expectedDeclaration: 'repost' as const }],
      declaration: 'original' as const,
    };
    const begun = (await manual.beginManualArticle()).snapshot;
    if (!('sessionId' in begun)) throw new Error('Expected session');
    const edited = (
      await manual.updateManualDraft(begun.sessionId, begun.revision, {
        title: 'saved',
        contentDeclaration: 'repost',
        blocks: [{ blockKey: id(70), type: 'paragraph', text: 'body' }],
      })
    ).snapshot;
    manual.saveManualArticle(begun.sessionId, edited.revision);
    await flush();
    expect(gate.state()).toBe('busy');
    expect(gate.startImport()).toEqual({ status: 'unavailable' });
    expect(imports.snapshot()).toEqual({ state: 'idle', revision: 0 });
    expect(declarations.setArticleDeclarations(change)).toEqual({
      status: 'busy',
    });
    expect(declaration).toBe('repost');
    release();
    // Include the confirmed-finished/active interval before the operation finally
    // relinquishes ownership; hasSession alone must never authorize another writer.
    for (let n = 0; n < 16; n++) {
      if (cleanup === 'resolve' && manual.isActive()) {
        expect(gate.state()).toBe('busy');
        expect(gate.startImport()).toEqual({ status: 'unavailable' });
        expect(declarations.setArticleDeclarations(change)).toEqual({
          status: 'busy',
        });
        expect(imports.snapshot().state).toBe('idle');
        expect(declaration).toBe('repost');
      }
      await Promise.resolve();
    }
    if (cleanup === 'reject') {
      expect(gate.state()).toBe('unavailable');
      expect(gate.startImport()).toEqual({ status: 'unavailable' });
      expect(declarations.setArticleDeclarations(change)).toEqual({
        status: 'unavailable',
      });
      expect(declaration).toBe('repost');
      expect(imports.snapshot().state).toBe('idle');
    } else {
      expect(gate.state()).toBe('ready');
      expect(declarations.setArticleDeclarations(change).status).toBe(
        'updated',
      );
      expect(declaration).toBe('original');
      expect(gate.startImport()).toEqual({ status: 'started', jobId: id(90) });
      expect(imports.snapshot().state).toBe('selecting');
      await imports.stopAndWait();
    }
  },
);

it('fails closed when the trusted platform state cannot be read', () => {
  const gate = createLibraryWriteGate({
    available: () => true,
    isClosing: () => false,
    draft: {
      isActive: () => false,
      isBlocked: () => {
        throw new Error('unknown');
      },
    },
  });
  expect(gate.state()).toBe('unavailable');
});
it.each(['active', 'held', 'closing', 'session', 'unknown'] as const)(
  'trusted %s state blocks the deletion write gate',
  (state) => {
    const gate = createLibraryWriteGate({
      available: () => true,
      isClosing: () => state === 'closing',
      draft: {
        isActive: () => state === 'active',
        isBlocked: () => state === 'held' || state === 'unknown',
      },
      manual: {
        isActive: () => false,
        isBlocked: () => false,
        hasSession: () => state === 'session',
      },
    });
    expect(gate.state()).toBe(
      ['active', 'session'].includes(state) ? 'busy' : 'unavailable',
    );
  },
);

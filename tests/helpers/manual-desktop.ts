import {
  createManualArticleController,
  type ManualArticleControllerPorts,
} from '../../src/application/manual-article';
import type { ManualState } from '../../src/contracts/manual-article';
import type { ImportResult } from '../../src/application/article-import';

export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
export function session(state: ManualState) {
  if (!('sessionId' in state)) throw new Error('Expected session');
  return state;
}
export const imported: ImportResult = {
  status: 'imported',
  warnings: [],
  article: {
    articleKey: id(80),
    importId: id(81),
    externalId: 'manual-' + id(2),
    title: 'Saved article',
    contentDeclaration: 'repost',
    createdAt: '2026-10-06T00:00:00.000Z',
    body: [{ type: 'paragraph', text: 'Body' }],
    assets: [],
  },
};
export function manualFixture(
  overrides: Partial<ManualArticleControllerPorts> = {},
) {
  let next = 0;
  const manual = createManualArticleController({
    newId: () => id(++next),
    externalExists: () => false,
    gate: () => 'ready',
    chooseImage: async () => undefined,
    readImage: async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }),
    retainImages: async () => {},
    releaseImages: async () => {},
    save: async () => imported,
    converter: {
      convert: async () => ({
        version: 2 as const,
        warnings: [],
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text' as const, text: 'Body', marks: [] }],
          },
        ],
        plainOnly: false,
      }),
    },
    pasteImages: {
      acquire: async () => {
        throw new Error('Unexpected image');
      },
    },
    fingerprint: JSON.stringify,
    ...overrides,
  });
  const begin = async () =>
    session((await manual.beginManualArticle()).snapshot);
  const edit = async () => {
    const first = await begin();
    return session(
      (
        await manual.updateManualDraft(first.sessionId, first.revision, {
          bodyVersion: 2 as const,
          title: 'Saved article',
          contentDeclaration: 'repost',
          blocks: [
            {
              type: 'paragraph',
              blockKey: id(70),
              content: [{ type: 'text' as const, text: 'Body', marks: [] }],
            },
          ],
        })
      ).snapshot,
    );
  };
  return { manual, begin, edit };
}
export const command = (state: ReturnType<typeof session>) => ({
  sessionId: state.sessionId,
  expectedRevision: state.revision,
  commandId: state.nextPasteCommandId,
});

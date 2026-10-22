import { createHash, randomUUID } from 'node:crypto';
import { draftHarness } from './draft-adapter';
import { makeDraftTask } from './draft-task';
import { initialCoverReport } from '../../src/domain/cover-task';
import { coverConfigurationDigest } from '../../src/infrastructure/persistence/article-cover-repository';
import type { BrowserSession } from '../../src/infrastructure/automation/browser-session';
export const coverSession: BrowserSession = {
  open: async () => {
    throw Error('no browser');
  },
  close: async () => {},
  current: () => undefined,
  generation: () => 'fixture',
};
export function coverDraftHarness(
  mode: 'none' | 'single' | 'triple' = 'single',
  overrides: Partial<import('../../src/contracts/draft-task').DraftTask> = {},
) {
  const articleKey = makeDraftTask().articleKey;
  const operationId = randomUUID();
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assets = Array.from(
    { length: mode === 'none' ? 0 : mode === 'single' ? 1 : 3 },
    () => {
      const assetKey = randomUUID();
      return {
        assetKey,
        mime: 'image/png' as const,
        width: 1,
        height: 1,
        byteSize: bytes.byteLength,
        sha256,
        relativePath: `${articleKey}/${operationId}/${assetKey}.png`,
      };
    },
  );
  const snapshot = {
    version: 1 as const,
    articleKey,
    coverRevision: mode === 'none' ? 0 : 1,
    mode,
    assets,
    digest: coverConfigurationDigest(
      articleKey,
      mode === 'none' ? 0 : 1,
      mode,
      assets,
    ),
  };
  const h = draftHarness(
    {
      policy: 'local-upload-v1',
      snapshot,
      report: initialCoverReport(snapshot, makeDraftTask().updatedAt),
    },
    overrides,
  );
  h.hooks.readCoverImage = async () => {
    h.calls.push('read-cover');
    return new Uint8Array(bytes);
  };
  h.observed.localCover = {
    known: true,
    mode: 'none',
    items: [],
    pendingUploads: false,
  };
  Object.defineProperty(h.pages, 'localCoverUpload', {
    value: 'supported',
    configurable: true,
  });
  h.pages.uploadLocalCover = async (input) => {
    h.calls.push('upload-cover');
    const items = input.files.map(({ position, assetKey, sha256 }) => ({
      position,
      assetKey,
      sha256,
      resourceKey: sha256,
    }));
    h.observed.localCover = {
      known: true,
      mode: input.mode,
      items: items.map((i) => ({ ...i, loaded: true })),
      pendingUploads: false,
    };
    return { status: 'completed', items, libraryUnchecked: true };
  };
  return h;
}

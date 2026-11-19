import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLocalCoverUploader,
  type CoverPageDriver,
  type CoverPageObservation,
  type CoverUploadInput,
  type CoverUploadTerminal,
} from '../../src/infrastructure/platforms/judongche/cover-pages';
import { unknownEditorEvidence } from '../../src/infrastructure/platforms/judongche/content-evidence';
import type { StoreBinding } from '../../src/contracts/draft-task';

const store: StoreBinding = {
  storeKey: 'a'.repeat(64),
  displayName: '合成门店',
  identity: { source: 'visible-shop-link', value: 'synthetic-store' },
};
const bytes = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  ),
);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const input: CoverUploadInput = {
  mode: 'single',
  files: [
    {
      position: 0,
      assetKey: randomUUID(),
      sha256,
      mime: 'image/png',
      bytes,
    },
  ],
};

function harness(
  script: CoverUploadTerminal[],
  stopOnTimeout = false,
  associateCount?: number,
  associationFault?: 'unloaded' | 'mismatch',
) {
  const editor = {
    ...unknownEditorEvidence(),
    known: true,
    store,
    contextKey: 'context-1',
    editorUrl: 'https://www.autoengine.com/jdc/dealer/info/Article',
    title: '合成标题',
    blocks: [{ type: 'paragraph' as const, text: '合成正文' }],
    pendingUploads: false,
    localCover: {
      known: true,
      mode: 'none' as const,
      items: [],
      pendingUploads: false,
    },
  };
  let modal: 'closed' | 'owned' = 'closed';
  let settlement: 'settled' | 'unknown' = 'settled';
  let result: CoverPageObservation['result'] = null;
  let items: CoverPageObservation['items'] = [];
  let files: CoverUploadInput['files'] = [];
  let mode: 'single' | 'triple' | null = null;
  const calls = { open: 0, upload: 0, cancel: 0, confirm: 0 };
  let stopped = false;
  const driver: CoverPageDriver = {
    async guard() {},
    async inspect(): Promise<CoverPageObservation> {
      return structuredClone({
        generation: 'generation-1',
        editor: { ...editor, pendingUploads: settlement !== 'settled' },
        modal,
        settlement,
        mode,
        result,
        libraryChecked: false,
        items,
      });
    },
    async open(next) {
      calls.open += 1;
      modal = 'owned';
      mode = next;
      settlement = 'settled';
      result = null;
      items = [];
    },
    async upload(next) {
      calls.upload += 1;
      files = next;
    },
    async waitForUpload() {
      const terminal = script.shift() ?? 'timeout';
      if (terminal === 'complete') {
        result = 'complete';
        settlement = 'settled';
        items = files
          .slice(0, associateCount ?? files.length)
          .map(({ position, assetKey, sha256: digest }) => ({
            position,
            assetKey,
            sha256: associationFault === 'mismatch' ? '0'.repeat(64) : digest,
            resourceKey: digest,
            loaded: associationFault !== 'unloaded',
          }));
      } else if (terminal === 'rejected') {
        result = 'rejected';
        settlement = 'unknown';
      } else {
        result = null;
        settlement = 'unknown';
        if (terminal === 'incomplete') modal = 'closed';
        if (terminal === 'timeout' && stopOnTimeout) stopped = true;
      }
      return terminal;
    },
    async uncheckLibrary() {},
    async confirm() {
      calls.confirm += 1;
      modal = 'closed';
      settlement = 'settled';
    },
    async cancel() {
      calls.cancel += 1;
      modal = 'closed';
      settlement = 'settled';
      result = null;
      items = [];
    },
  };
  return {
    driver,
    calls,
    run: createLocalCoverUploader(driver),
    stop: () => stopped,
  };
}

describe('cover upload terminal states', () => {
  it('accepts a complete upload without retrying', async () => {
    const h = harness(['complete']);
    const outcome = await h.run(input, h.stop);
    expect(outcome.status).toBe('completed');
    expect(h.calls).toMatchObject({ open: 1, upload: 1, cancel: 0 });
  });

  it('does not retry a rejected upload', async () => {
    const h = harness(['rejected']);
    const outcome = await h.run(input, h.stop);
    expect(outcome).toMatchObject({
      status: 'recoverable_failure',
      reason: 'UPLOAD_REJECTED',
    });
    expect(h.calls).toMatchObject({ open: 1, upload: 1, cancel: 1 });
  });

  it('retries an incomplete upload once and completes', async () => {
    const h = harness(['incomplete', 'complete']);
    const outcome = await h.run(input, h.stop);
    expect(outcome.status).toBe('completed');
    expect(h.calls).toMatchObject({ open: 2, upload: 2, cancel: 1 });
  });

  it('retries a timeout once and completes', async () => {
    const h = harness(['timeout', 'complete']);
    const outcome = await h.run(input, h.stop);
    expect(outcome.status).toBe('completed');
    expect(h.calls).toMatchObject({ open: 2, upload: 2, cancel: 1 });
  });

  it('blocks with a closed, unchanged editor proof after two timeouts', async () => {
    const h = harness(['timeout', 'timeout']);
    const outcome = await h.run(input, h.stop);
    expect(outcome).toMatchObject({
      status: 'blocked',
      reason: 'COVER_UPLOAD_FAILED',
      safeEditorProof: {
        generation: 'generation-1',
        contextKey: 'context-1',
        storeKey: store.storeKey,
        modalClosed: true,
        uploadsSettled: true,
      },
    });
    if (outcome.status === 'blocked')
      expect(outcome.safeEditorProof?.editorUrl).toBe(
        'https://www.autoengine.com/jdc/dealer/info/Article',
      );
    expect(h.calls).toMatchObject({ open: 2, upload: 2, cancel: 2 });
  });

  it('recovers by cancelling when complete only associates 2 of 3 files', async () => {
    const input3: CoverUploadInput = {
      mode: 'triple',
      files: [0, 1, 2].map((position) => ({
        ...input.files[0],
        position,
        assetKey: randomUUID(),
      })),
    };
    const h = harness(['complete'], false, 2);
    const outcome = await h.run(input3, h.stop);
    expect(outcome).toMatchObject({
      status: 'recoverable_failure',
      reason: 'UPLOAD_INCOMPLETE',
      safeEditorProof: { modalClosed: true, uploadsSettled: true },
    });
    if (outcome.status === 'recoverable_failure')
      expect(outcome.items).toHaveLength(2);
    expect(h.calls).toMatchObject({ open: 1, upload: 1, cancel: 1 });
  });

  it('recovers by cancelling when association validation rejects an item', async () => {
    const h = harness(['complete'], false, 1, 'mismatch');
    const outcome = await h.run(input, h.stop);
    expect(outcome).toMatchObject({
      status: 'recoverable_failure',
      reason: 'UPLOAD_INCOMPLETE',
      safeEditorProof: { modalClosed: true, uploadsSettled: true },
    });
    if (outcome.status === 'recoverable_failure')
      expect(outcome.items).toEqual([]);
    expect(h.calls).toMatchObject({ open: 1, upload: 1, cancel: 1 });
  });

  it('honours a stop request after the first timeout without retrying', async () => {
    const h = harness(['timeout', 'complete'], true);
    const outcome = await h.run(input, h.stop);
    expect(outcome).toMatchObject({
      status: 'blocked',
      reason: 'STOP_REQUESTED',
    });
    expect(h.calls).toMatchObject({ open: 1, upload: 1, cancel: 0 });
  });

  it.each(['modal', 'pending', 'body'] as const)(
    'cannot retry when cancellation does not prove a clean unchanged editor: %s',
    async (fault) => {
      const h = harness(['timeout', 'complete']);
      const inspect = h.driver.inspect;
      h.driver.inspect = async () => {
        const value = await inspect();
        if (h.calls.cancel) {
          if (fault === 'modal') value.modal = 'owned';
          if (fault === 'pending') value.editor.pendingUploads = true;
          if (fault === 'body') value.editor.title = 'changed after cancel';
        }
        return value;
      };
      expect(await h.run(input, h.stop)).toMatchObject({
        status: 'blocked',
        reason: 'PAGE_CHANGED',
      });
      expect(h.calls).toEqual({ open: 1, upload: 1, cancel: 1, confirm: 0 });
    },
  );
});

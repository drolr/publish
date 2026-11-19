import type { ConvertedRichPaste } from '../../src/contracts/rich-web-paste';
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  protectShutdown,
  confirmManualShutdown,
} from '../../src/desktop/main/shutdown';
it('blocks writes while confirming but reopens without stopping when close is cancelled', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let answer!: (value: boolean) => void;
  const confirm = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const operation = {
    isActive: () => false,
    stopAndWait: vi.fn(async () => undefined),
  };
  const close = vi.fn();
  const isClosing = protectShutdown(app, window, operation, close, confirm);
  const event = { preventDefault: vi.fn() };
  window.emit('close', event);
  app.emit('before-quit', event);
  expect(isClosing()).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(operation.stopAndWait).not.toHaveBeenCalled();
  answer(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(isClosing()).toBe(false);
  expect(close).not.toHaveBeenCalled();
  window.emit('close', event);
  answer(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(operation.stopAndWait).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(isClosing()).toBe(true);
});
it('keeps storage open until the active operation settles and handles repeated quit once', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let finish!: () => void;
  const operation = {
    isActive: () => true,
    stopAndWait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const close = vi.fn();
  const isClosing = protectShutdown(app, window, operation, close);
  expect(isClosing()).toBe(false);
  const event = { preventDefault: vi.fn() };
  window.emit('close', event);
  expect(isClosing()).toBe(true);
  app.emit('before-quit', event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(operation.stopAndWait).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalledTimes(1);
  expect(window.destroy).toHaveBeenCalled();
  expect(app.quit).toHaveBeenCalled();
  app.emit('before-quit', event);
  expect(close).toHaveBeenCalledTimes(1);
});
it('closes directly without work when no import is active', () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const close = vi.fn();
  protectShutdown(app, window, undefined, close);
  const event = { preventDefault: vi.fn() };
  app.emit('before-quit', event);
  expect(close).toHaveBeenCalledTimes(1);
  expect(event.preventDefault).not.toHaveBeenCalled();
});
it('closes the start gate even when an initialized controller is idle', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let accepting = true;
  const operation = {
    isActive: () => false,
    stopAndWait: async () => {
      accepting = false;
    },
  };
  const close = vi.fn(() => expect(accepting).toBe(false));
  protectShutdown(app, window, operation, close);
  window.emit('close', { preventDefault: vi.fn() });
  expect(accepting).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalledTimes(1);
});
it('keeps the write gate closed if shutdown settlement fails', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const window = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const close = vi.fn();
  try {
    const isClosing = protectShutdown(
      app,
      window,
      {
        isActive: () => true,
        stopAndWait: async () => {
          throw new Error('private path');
        },
      },
      close,
    );
    window.emit('close', { preventDefault: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isClosing()).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('SHUTDOWN_FAILED');
  } finally {
    report.mockRestore();
  }
});

import {
  command,
  deferred,
  flush,
  manualFixture,
  session,
} from '../helpers/manual-desktop';

function hosts() {
  const events: string[] = [];
  const app = Object.assign(new EventEmitter(), {
    quit: () => events.push('quit'),
  });
  const window = Object.assign(new EventEmitter(), {
    destroy: () => events.push('destroy'),
  });
  return { app, window, events, close: () => events.push('database') };
}
it('quit_waits_paste_and_cleanup_before_database even after parser abort', async () => {
  // Dropping any awaited controller work exposes database/destroy before settlement.
  const parse = deferred<ConvertedRichPaste>();
  const cleanup = deferred<void>();
  let signal!: AbortSignal;
  const { manual, begin } = manualFixture({
    converter: {
      convert: async (_input, abort) => {
        signal = abort;
        return parse.promise;
      },
    },
    releaseImages: () => cleanup.promise,
  });
  const state = await begin();
  await manual.startManualPaste(command(state), {
    html: '<p>Body</p>',
    plain: 'Body',
  });
  await flush();
  const host = hosts();
  const closing = protectShutdown(
    host.app,
    host.window,
    manual,
    host.close,
    async () => true,
  );
  host.window.emit('close', { preventDefault() {} });
  await flush();
  expect(signal.aborted).toBe(true);
  expect(closing()).toBe(true);
  expect(host.events).toEqual([]);
  parse.resolve({
    version: 2 as const,
    warnings: [],
    blocks: [
      {
        type: 'paragraph',
        content: [{ type: 'text' as const, text: 'Body', marks: [] }],
      },
    ],
    plainOnly: false,
  });
  await flush();
  expect(host.events).toEqual([]);
  expect(manual.isActive()).toBe(true);
  cleanup.resolve();
  await flush();
  expect(host.events).toEqual(['database', 'destroy', 'quit']);
});
it('cleanup_failure_prevents_close_database_race with the real controller', async () => {
  // Swallowing release(false) in stopAndWait incorrectly authorizes close.
  const { manual, edit } = manualFixture({
    releaseImages: async () => {
      throw new Error('C:/private-cleanup');
    },
  });
  const state = await edit();
  const host = hosts();
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const closing = protectShutdown(
      host.app,
      host.window,
      manual,
      host.close,
      async () => true,
    );
    host.window.emit('close', { preventDefault() {} });
    await flush();
    expect(host.events).toEqual([]);
    expect(closing()).toBe(true);
    expect(manual.isBlocked()).toBe(true);
    expect(session(manual.getManualArticleState()).draft).toEqual(state.draft);
    expect((await manual.beginManualArticle()).status).toBe('unavailable');
    expect(report).toHaveBeenCalledWith('SHUTDOWN_FAILED');
  } finally {
    report.mockRestore();
  }
});
it('cancel_close_keeps_session and reopens actual controller edits', async () => {
  const host = hosts();
  let closing = () => false;
  const { manual, edit } = manualFixture({
    gate: () => (closing() ? 'unavailable' : 'ready'),
  });
  const state = await edit();
  const answer = deferred<boolean>();
  closing = protectShutdown(
    host.app,
    host.window,
    manual,
    host.close,
    () => answer.promise,
  );
  host.window.emit('close', { preventDefault() {} });
  expect(closing()).toBe(true);
  expect(
    (
      await manual.updateManualDraft(state.sessionId, state.revision, {
        ...state.draft,
        title: 'During confirmation',
      })
    ).status,
  ).toBe('unavailable');
  answer.resolve(false);
  await flush();
  expect(closing()).toBe(false);
  expect(host.events).toEqual([]);
  expect(manual.getManualArticleState()).toEqual(state);
  expect(
    (
      await manual.updateManualDraft(state.sessionId, state.revision, {
        ...state.draft,
        title: 'Continued',
      })
    ).status,
  ).toBe('ok');
});
it.each(['resolve', 'reject'] as const)(
  'committed_save_close_keeps_success during %s cleanup without an unsaved-loss warning',
  async (result) => {
    const cleanup = deferred<void>();
    const { manual, edit } = manualFixture({
      releaseImages: async () => {
        await cleanup.promise;
        if (result === 'reject') throw new Error('private');
      },
    });
    const state = await edit();
    manual.saveManualArticle(state.sessionId, state.revision);
    await flush();
    expect(session(manual.getManualArticleState()).result).toMatchObject({
      status: 'imported',
      articleKey: '00000000-0000-4000-8000-000000000080',
    });
    expect(manual.hasSession()).toBe(true);
    expect(manual.isActive()).toBe(true);
    let lossWarning = false;
    const host = hosts();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      protectShutdown(host.app, host.window, manual, host.close, () =>
        confirmManualShutdown(manual, async () => {
          lossWarning = true;
          return false;
        }),
      );
      host.window.emit('close', { preventDefault() {} });
      await flush();
      expect(lossWarning).toBe(false);
      expect(host.events).toEqual([]);
      cleanup.resolve();
      await flush();
      expect(host.events).toEqual(
        result === 'resolve' ? ['database', 'destroy', 'quit'] : [],
      );
      expect(session(manual.getManualArticleState()).result?.status).toBe(
        'imported',
      );
      expect(
        session(
          manual.saveManualArticle(state.sessionId, state.revision).snapshot,
        ).result?.status,
      ).toBe('imported');
    } finally {
      report.mockRestore();
    }
  },
);

const acquisition = vi.hoisted(() => ({
  read: async (...args: [string, AbortSignal]): Promise<Uint8Array> =>
    new Uint8Array(args[0] ? [1] : []),
  decode: async (): Promise<Uint8Array> => new Uint8Array([1]),
  nativeDestroyed: false,
}));
vi.mock('../../src/infrastructure/assets/remote-reader', () => ({
  readRemoteImage: (url: string, signal: AbortSignal) =>
    acquisition.read(url, signal),
}));
// Replace only native work; validateImage, source ownership, reader and runner remain real.
vi.mock('sharp', () => ({
  default: () => {
    const decoder = {
      timeout: () => decoder,
      metadata: async () => ({
        format: 'jpeg',
        width: 1,
        height: 1,
        channels: 3,
      }),
      raw: () => decoder,
      toBuffer: () => acquisition.decode(),
      destroy: () => {
        acquisition.nativeDestroyed = true;
      },
    };
    return decoder;
  },
}));
import { createWebPasteImageReader } from '../../src/infrastructure/assets/web-paste-image-reader';
import { createManualImageSource } from '../../src/infrastructure/assets/manual-image-source';

it.each(['network', 'decoder'] as const)(
  'quit waits actual acquisition coordination until delayed %s work settles',
  async (stage) => {
    const pending = deferred<Uint8Array>();
    let readingSignal!: AbortSignal;
    let reads = 0;
    let decodeStarted = false;
    acquisition.nativeDestroyed = false;
    acquisition.read = async (_url, signal) => {
      reads++;
      readingSignal = signal;
      return stage === 'network' ? pending.promise : new Uint8Array([1]);
    };
    acquisition.decode = async () => {
      decodeStarted = true;
      return pending.promise;
    };
    let persisted = false;
    const source = createManualImageSource({
      recover: async () => true,
      put: async () => {
        persisted = true;
        throw new Error('Unexpected late authorization');
      },
      read: async () => {
        throw new Error('Unexpected preview');
      },
      remove: async () => {},
    });
    const { manual, begin } = manualFixture({
      converter: {
        convert: async () => ({
          version: 2 as const,
          warnings: [],
          blocks: [
            {
              type: 'paragraph',
              content: [{ type: 'text' as const, text: 'Body', marks: [] }],
            },
            { type: 'image', source: 'https://public.invalid/one.jpg' },
            { type: 'image', source: 'https://public.invalid/two.jpg' },
          ],
          plainOnly: false,
        }),
      },
      pasteImages: createWebPasteImageReader(source),
      retainImages: source.retain,
      releaseImages: source.release,
    });
    const first = await begin();
    await manual.startManualPaste(command(first), {
      html: '<p>Body</p>',
      plain: 'Body',
    });
    await flush();
    expect(reads).toBe(1);
    expect(decodeStarted).toBe(stage === 'decoder');
    const host = hosts();
    protectShutdown(
      host.app,
      host.window,
      manual,
      host.close,
      async () => true,
    );
    host.window.emit('close', { preventDefault() {} });
    await flush();
    expect(readingSignal.aborted).toBe(true);
    if (stage === 'decoder') expect(acquisition.nativeDestroyed).toBe(true);
    expect(manual.isActive()).toBe(true);
    expect(host.events).toEqual([]);
    pending.resolve(new Uint8Array([1]));
    await flush();
    expect(host.events).toEqual(['database', 'destroy', 'quit']);
    expect(reads).toBe(1);
    expect(persisted).toBe(false);
    const after = session(manual.getManualArticleState());
    expect(after.candidates.map((candidate) => candidate.state)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(after.images).toEqual([]);
    expect(after.draft.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'image-pending',
      'image-pending',
    ]);
  },
);
it('quit waits an actual acknowledged-draft mutation before final release and database close', async () => {
  const retained = deferred<void>();
  const events: string[] = [];
  const { manual, begin } = manualFixture({
    retainImages: async () => {
      await retained.promise;
      events.push('retained');
    },
    releaseImages: async () => {
      events.push('released');
    },
  });
  const first = await begin();
  const updating = manual.updateManualDraft(first.sessionId, first.revision, {
    ...first.draft,
    title: 'Updated',
  });
  const host = hosts();
  protectShutdown(
    host.app,
    host.window,
    manual,
    () => {
      events.push('database');
      host.close();
    },
    async () => true,
  );
  host.window.emit('close', { preventDefault() {} });
  await flush();
  expect(events).toEqual([]);
  expect(host.events).toEqual([]);
  expect(manual.getManualArticleState()).toEqual(first);
  retained.resolve();
  expect((await updating).status).toBe('ok');
  await flush();
  expect(events).toEqual(['retained', 'released', 'database']);
  expect(host.events).toEqual(['database', 'destroy', 'quit']);
});

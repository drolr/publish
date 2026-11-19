import { expect, it, vi } from 'vitest';
import {
  parseEdgeVersion,
  checkLocalCapabilities,
} from '../../src/infrastructure/automation/browser-health-check';
import type { BrowserContext } from 'playwright-core';
it.each(['153.0.0.0', '156.0.4314.58', '999.0.0.0', '152.0.0.0'])(
  'parses complete numeric version %s',
  (value) =>
    expect(parseEdgeVersion(value)).toEqual({
      full: value,
      major: Number(value.split('.')[0]),
    }),
);
it.each([
  '153.0.0',
  'NaN.0.0.0',
  '-1.0.0.0',
  ' 153.0.0.0',
  '153.0.0.0 ',
  'Edge/153.0.0.0',
  '9007199254740992.0.0.0',
  null,
])('rejects malformed version %s', (value) =>
  expect(parseEdgeVersion(value)).toBeNull(),
);
it('fails closed and closes its owned page when evaluate fails', async () => {
  const page = {
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      throw Error('private');
    }),
    close: vi.fn(async () => {}),
  };
  const context = {
    route: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
    newPage: vi.fn(async () => page),
  };
  await expect(
    checkLocalCapabilities(
      context as unknown as BrowserContext,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ stage: 'evaluate' });
  expect(page.close).toHaveBeenCalledOnce();
  const route = context.route.mock.calls[0];
  expect(route[0]).toBe('**/*');
});
it('aborted checks cannot create a page', async () => {
  const context = { route: vi.fn(), newPage: vi.fn() };
  const abort = new AbortController();
  abort.abort();
  await expect(
    checkLocalCapabilities(context as unknown as BrowserContext, abort.signal),
  ).rejects.toMatchObject({ reason: 'timeout' });
  expect(context.newPage).not.toHaveBeenCalled();
});
function capabilityFixture(failure?: string) {
  const file = {
    name: 'health.png',
    type: 'image/png',
    size: 68,
    bytes: Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=',
        'base64',
      ),
    ),
  };
  const input = {
    count: vi.fn(async () => (failure === 'locator-count' ? 2 : 1)),
    isVisible: vi.fn(async () => failure !== 'locator-hidden'),
    fill: vi.fn(async () => {}),
    inputValue: vi.fn(async () =>
      failure === 'locator-text' ? 'wrong' : '本地浏览器检查',
    ),
  };
  const editor = {
    fill: vi.fn(async () => {}),
    evaluate: vi.fn(async (callback?: unknown) => {
      void callback;
      return {
        ok: failure !== 'editor',
        snapshot: { innerTextMatches: failure !== 'editor' },
      };
    }),
  };
  const upload = {
    setInputFiles: vi.fn(async (...args: unknown[]) => {
      void args;
      if (failure === 'file-input') throw Error('private');
    }),
    evaluate: vi.fn(async () =>
      failure === 'file-bytes'
        ? { ...file, bytes: [0, ...file.bytes.slice(1)] }
        : failure === 'file-name'
          ? { ...file, name: 'wrong.png' }
          : failure === 'file-type'
            ? { ...file, type: 'text/plain' }
            : failure === 'file-size'
              ? { ...file, size: 67 }
              : file,
    ),
  };
  const page = {
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, value: unknown) =>
      failure === 'nonce' ? 'wrong' : value,
    ),
    locator: (selector: string) =>
      selector === '#health-text'
        ? input
        : selector === '#health-editor'
          ? editor
          : upload,
    close: vi.fn(async () => {
      if (failure === 'cleanup') throw Error('private');
    }),
  };
  const context = {
    route: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
    newPage: vi.fn(async () => page),
  };
  return {
    context: context as unknown as BrowserContext,
    page,
    upload,
    editor,
  };
}
it('optional diagnostics distinguish editor phases without exposing error text', async () => {
  const { context, editor } = capabilityFixture();
  editor.fill.mockRejectedValueOnce(Error('private content and profile path'));
  const diagnostic = vi.fn();
  await expect(
    checkLocalCapabilities(context, new AbortController().signal, diagnostic),
  ).rejects.toMatchObject({ stage: 'editor', reason: 'capability_failed' });
  expect(diagnostic.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'fill-start' },
    { phase: 'exception', operation: 'fill', category: 'error' },
  ]);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private');
});
it('throwing diagnostic output cannot change capability failure or page cleanup', async () => {
  const { context, page } = capabilityFixture('editor');
  const diagnostic = vi.fn(() => {
    throw Error('private observer failure');
  });
  await expect(
    checkLocalCapabilities(context, new AbortController().signal, diagnostic),
  ).rejects.toMatchObject({ stage: 'editor', reason: 'capability_failed' });
  expect(diagnostic).toHaveBeenCalled();
  expect(page.close).toHaveBeenCalledOnce();
});
it('diagnostics classify evaluate exceptions and cannot prevent a passing check', async () => {
  const { context, editor } = capabilityFixture();
  editor.evaluate.mockRejectedValueOnce(Error('private evaluate failure'));
  const diagnostic = vi.fn();
  await expect(
    checkLocalCapabilities(context, new AbortController().signal, diagnostic),
  ).rejects.toMatchObject({ stage: 'editor' });
  expect(diagnostic.mock.calls.map(([event]) => event)).toEqual([
    { phase: 'fill-start' },
    { phase: 'fill-return' },
    { phase: 'evaluate-start' },
    { phase: 'exception', operation: 'evaluate', category: 'error' },
  ]);
  const throwing = vi.fn(() => {
    throw Error('private observer failure');
  });
  await checkLocalCapabilities(context, new AbortController().signal, throwing);
  expect(throwing).toHaveBeenCalledTimes(4);
});
it.each([
  ['whitespace', ' 第一段\n第二段', 0, true, 2, 0],
  ['zero_width', '第一段\n第二段\u200b', 7, true, 1, 1],
  ['latin', '第一段x\n第二段', 3, true, 1, 0],
  ['other', 'different', 0, false, 0, 0],
] as const)(
  'diagnoses %s without selecting or accepting mismatched content',
  async (category, innerText, position, singleDeletion, spaces, zeroWidth) => {
    const { context, editor, page } = capabilityFixture();
    const element = {
      innerText,
      textContent: innerText.replace('\n', ''),
      isConnected: true,
    };
    const createRange = vi.fn();
    vi.stubGlobal('document', {
      activeElement: element,
      hasFocus: () => true,
      visibilityState: 'visible',
      createRange,
    });
    editor.evaluate.mockImplementationOnce(async (callback) =>
      (
        callback as (element: unknown) => {
          ok: boolean;
          snapshot: { innerTextMatches: boolean };
        }
      )(element),
    );
    const diagnostic = vi.fn();
    try {
      await expect(
        checkLocalCapabilities(
          context,
          new AbortController().signal,
          diagnostic,
        ),
      ).rejects.toMatchObject({ stage: 'editor', reason: 'capability_failed' });
      expect(createRange).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenLastCalledWith({
        phase: 'evaluate-return',
        editor: expect.objectContaining({
          innerTextMatches: false,
          firstMismatchIndex: position,
          singleDeletionMatches: singleDeletion,
          extraPosition: singleDeletion ? position : null,
          extraCategory: singleDeletion ? category : null,
          whitespaceCount: spaces,
          zeroWidthCount: zeroWidth,
          selectionAvailable: null,
          selectionMatches: null,
        }),
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(innerText);
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it('local capability success blocks page requests and checks synthetic file exactly', async () => {
  const { context, page, upload } = capabilityFixture();
  await checkLocalCapabilities(context, new AbortController().signal);
  expect(page.close).toHaveBeenCalledOnce();
  expect(upload.setInputFiles.mock.calls[0][0]).toMatchObject({
    name: 'health.png',
    mimeType: 'image/png',
  });
  const input = upload.setInputFiles.mock.calls[0][0] as unknown as {
    buffer: Buffer;
  };
  expect(input.buffer.length).toBe(68);
});
it.each([
  ['nonce', 'evaluate'],
  ['locator-count', 'locator'],
  ['locator-hidden', 'locator'],
  ['locator-text', 'locator'],
  ['editor', 'editor'],
  ['file-input', 'file'],
  ['file-bytes', 'file'],
  ['file-name', 'file'],
  ['file-type', 'file'],
  ['file-size', 'file'],
  ['cleanup', 'cleanup'],
])('fails closed for %s at fixed stage %s', async (failure, stage) => {
  const { context, page } = capabilityFixture(failure);
  await expect(
    checkLocalCapabilities(context, new AbortController().signal),
  ).rejects.toMatchObject({ stage });
  expect(page.close).toHaveBeenCalledOnce();
});
it('step timeout closes owned page and rejects without waiting on stuck evaluate', async () => {
  const { context, page } = capabilityFixture();
  page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const checking = checkLocalCapabilities(
      context,
      new AbortController().signal,
    );
    const rejected = expect(checking).rejects.toMatchObject({
      stage: 'evaluate',
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(page.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

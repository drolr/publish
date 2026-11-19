import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { WebPasteConverter } from '../../src/domain/ports/web-paste';
import { createWebPasteConverter } from '../../src/infrastructure/content/web-paste-converter';
import { buildWebPasteWorker } from '../../scripts/build-web-paste-worker';

let workerPath: string;
async function converter(fixture?: string): Promise<WebPasteConverter> {
  return createWebPasteConverter(
    fixture ? resolve('tests/fixtures/web-paste', fixture) : workerPath,
  );
}
beforeAll(async () => {
  await buildWebPasteWorker();
  workerPath = resolve('.cache/web-paste-worker/web-paste-worker.cjs');
}, 30000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('actual bundled Worker converts order using inlined runtime without network', async () => {
  const result = await (
    await converter()
  ).convert(
    {
      html: readFileSync('tests/fixtures/web-paste/ordered.html', 'utf8'),
      plain: 'unused',
    },
    new AbortController().signal,
  );
  expect(
    result.blocks.map((block) =>
      block.type === 'paragraph' ? block.text : block.source,
    ),
  ).toEqual([
    '标题 😀',
    '甲 乙& 丙',
    '一',
    '二',
    'https://example.test/a?x=1&y=2',
    '说明',
    '外内',
    '段',
    '尾',
  ]);
});
it('actual Worker failures expose only fixed codes', async () => {
  await expect(
    (await converter()).convert(
      { html: '<table>SECRET</table>', plain: 'safe' },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_STRUCTURE',
    message: 'UNSUPPORTED_STRUCTURE',
  });
});
it.each(['malformed-worker.mjs', 'error-worker.mjs', 'exit-worker.mjs'])(
  'rejects malformed reply/error/early exit from real %s',
  async (fixture) => {
    await expect(
      (await converter(fixture)).convert(
        { html: '<p>safe</p>', plain: '' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_FRAGMENT',
      message: 'INVALID_FRAGMENT',
    });
  },
);
it('does not start an already cancelled conversion', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    (await converter()).convert({ html: '<p>x</p>', plain: '' }, abort.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
});
it('abort terminates a CPU-bound real Worker and awaits exit before rejecting', async () => {
  const exits: number[] = [];
  const original = Worker.prototype.terminate;
  // Observe the real termination promise without replacing the operation.
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
    this: Worker,
  ) {
    return original.call(this).then((code) => {
      exits.push(code);
      return code;
    });
  });
  const abort = new AbortController();
  const pending = (await converter('startup-worker.mjs')).convert(
    { html: '<p>x</p>', plain: '' },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 100);
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(exits).toHaveLength(1);
});
it('terminate_at_5000ms includes startup, keeps 4999ms pending and awaits real exit', async () => {
  const instance = await converter('startup-worker.mjs');
  const exits: number[] = [];
  const original = Worker.prototype.terminate;
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
    this: Worker,
  ) {
    return original.call(this).then((code) => {
      exits.push(code);
      return code;
    });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const result = instance
    .convert({ html: '<p>x</p>', plain: '' }, new AbortController().signal)
    .catch((error) => {
      settled = true;
      return error;
    });
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ code: 'PARSE_TIMEOUT' });
  expect(exits).toHaveLength(1);
});
it('abort racing the deadline settles once and terminates once', async () => {
  const instance = await converter('startup-worker.mjs');
  const original = Worker.prototype.terminate;
  let exits = 0;
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
    this: Worker,
  ) {
    return original.call(this).then((code) => {
      exits++;
      return code;
    });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const abort = new AbortController();
  const result = instance
    .convert({ html: '<p>x</p>', plain: '' }, abort.signal)
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(5000);
  abort.abort();
  expect(await result).toMatchObject({ code: 'PARSE_TIMEOUT' });
  expect(exits).toBe(1);
});
it('actual Worker validates malformed requests before conversion', async () => {
  const worker = new Worker(workerPath);
  try {
    const result = new Promise((resolve) => worker.once('message', resolve));
    worker.postMessage({ html: '<p>x</p>', plain: '', extra: 'SECRET' });
    expect(await result).toEqual({ ok: false, code: 'INPUT_LIMIT' });
  } finally {
    await worker.terminate();
  }
});
it.each(['empty', 'blank', 'overbudget', 'unknown', 'extra'])(
  'main revalidates %s Worker replies instead of trusting the thread',
  async (plain) => {
    await expect(
      (await converter('reply-worker.mjs')).convert(
        { html: '<p>x</p>', plain },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FRAGMENT' });
  },
);
it('successful response destroys the thread before release and prevents late resurrection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'web-paste-late-'));
  const marker = join(directory, 'late.txt');
  try {
    const result = await (
      await converter('late-worker.mjs')
    ).convert(
      { html: '<p>x</p>', plain: marker },
      new AbortController().signal,
    );
    expect(result.blocks).toEqual([{ type: 'paragraph', text: 'first' }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('abort interrupts a real Worker already running a CPU-bound job', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'web-paste-busy-'));
  const marker = join(directory, 'started.txt');
  const abort = new AbortController();
  try {
    const result = (await converter('busy-worker.mjs'))
      .convert({ html: '<p>x</p>', plain: marker }, abort.signal)
      .catch((error) => error);
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    abort.abort();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
  } finally {
    abort.abort();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('copied standalone Worker runs outside the repository with no node_modules fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'web-paste-bundle-'));
  const copied = join(directory, 'web-paste-worker.cjs');
  try {
    copyFileSync(workerPath, copied);
    expect(
      await createWebPasteConverter(copied).convert(
        { html: '<p>甲<img src="https://example.test/a">乙</p>', plain: '' },
        new AbortController().signal,
      ),
    ).toEqual({
      plainOnly: false,
      blocks: [
        { type: 'paragraph', text: '甲' },
        { type: 'image', source: 'https://example.test/a' },
        { type: 'paragraph', text: '乙' },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('inert Worker parsing never requests images, linked styles or script resources', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('unexpected');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture server unavailable');
    const source = `http://127.0.0.1:${address.port}/resource`;
    const html = `<head><link href="${source}"></head><script src="${source}">fetch('${source}')</script><p onclick="fetch('${source}')">甲<img src="${source}"></p>`;
    expect(
      await (
        await converter()
      ).convert({ html, plain: '' }, new AbortController().signal),
    ).toEqual({
      plainOnly: false,
      blocks: [
        { type: 'paragraph', text: '甲' },
        { type: 'image', source },
      ],
    });
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('rich bundled Worker preserves V2 structure and safe warnings while old converter remains V1', async () => {
  const { createRichWebPasteConverter } =
    await import('../../src/infrastructure/content/web-paste-converter');
  const input = {
    html: '<h2 class="source"><b>甲</b><span style="font-weight:normal">乙</span></h2><img src="relative">',
    plain: '',
  };
  expect(
    await createRichWebPasteConverter(workerPath).convert(
      input,
      new AbortController().signal,
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: ['HEADING_NORMALIZED', 'STYLE_NORMALIZED'],
    blocks: [
      {
        type: 'heading',
        content: [
          { type: 'text', text: '甲', marks: ['bold'] },
          { type: 'text', text: '乙', marks: [] },
        ],
      },
      { type: 'image', source: 'relative' },
    ],
  });
  expect(
    await createWebPasteConverter(workerPath).convert(
      input,
      new AbortController().signal,
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲乙' },
      { type: 'image', source: 'relative' },
    ],
  });
});
it.each([
  'error-worker.mjs',
  'malformed-worker.mjs',
  'exit-worker.mjs',
  'reply-worker.mjs',
])(
  'rich rejects unsafe or V1 replies from %s with fixed reason',
  async (fixture) => {
    const { createRichWebPasteConverter } =
      await import('../../src/infrastructure/content/web-paste-converter');
    await expect(
      createRichWebPasteConverter(
        resolve('tests/fixtures/web-paste', fixture),
      ).convert({ html: '<p>x</p>', plain: '' }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'INVALID_FRAGMENT',
      message: 'INVALID_FRAGMENT',
    });
  },
);
it('rich worker shares startup deadline and abort disposal', async () => {
  const { createRichWebPasteConverter } =
    await import('../../src/infrastructure/content/web-paste-converter');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const convert = createRichWebPasteConverter(
    resolve('tests/fixtures/web-paste/startup-worker.mjs'),
  );
  const result = convert
    .convert({ html: '<p>x</p>', plain: '' }, new AbortController().signal)
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toMatchObject({
    code: 'PARSE_TIMEOUT',
    message: 'PARSE_TIMEOUT',
  });
  const abort = new AbortController();
  const cancelled = convert
    .convert({ html: '<p>x</p>', plain: '' }, abort.signal)
    .catch((error) => error);
  abort.abort();
  expect(await cancelled).toMatchObject({ code: 'CANCELLED' });
});

it.each(['warning', 'html', 'nested'])(
  'rich revalidates trusted-thread V2 %s payloads',
  async (plain) => {
    const { createRichWebPasteConverter } =
      await import('../../src/infrastructure/content/web-paste-converter');
    await expect(
      createRichWebPasteConverter(
        resolve('tests/fixtures/web-paste/rich-reply-worker.mjs'),
      ).convert({ html: '<p>x</p>', plain }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_FRAGMENT' });
  },
);
it('rich actual worker never executes or requests linked resources', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('unexpected');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('fixture unavailable');
    const source = `http://127.0.0.1:${address.port}/resource`;
    const { createRichWebPasteConverter } =
      await import('../../src/infrastructure/content/web-paste-converter');
    const result = await createRichWebPasteConverter(workerPath).convert(
      {
        html: `<link href="${source}"><script src="${source}">fetch('${source}')</script><p onclick="fetch('${source}')"><b>甲</b><img src="${source}"></p>`,
        plain: '',
      },
      new AbortController().signal,
    );
    expect(result.blocks).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '甲', marks: ['bold'] }],
      },
      { type: 'image', source },
    ]);
    expect(result.warnings).toEqual(['STYLE_NORMALIZED']);
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  { version: 2, input: { html: '<p>x</p>', plain: '', htmlSource: 'SECRET' } },
  { version: 2, input: { html: '<p>x</p>', plain: '' }, extra: 'SECRET' },
  { version: 3, input: { html: '<p>x</p>', plain: '' } },
])(
  'rich worker rejects malformed versioned requests with a fixed code',
  async (request) => {
    const worker = new Worker(workerPath);
    try {
      const reply = new Promise((resolve) => worker.once('message', resolve));
      worker.postMessage(request);
      expect(await reply).toEqual({ ok: false, code: 'INPUT_LIMIT' });
    } finally {
      await worker.terminate();
    }
  },
);

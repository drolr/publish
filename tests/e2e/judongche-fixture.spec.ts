import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { BrowserSession } from '../../src/infrastructure/automation/browser-session';
import {
  createJudongchePages,
  readEditorEvidence,
} from '../../src/infrastructure/platforms/judongche/page-contract';
import { denyExternalNetwork } from './network-policy';
const editorFixture = readFileSync(
  'tests/fixtures/judongche-pages/editor.html',
  'utf8',
);
const uploadedEditorFixture = readFileSync(
  'tests/fixtures/judongche-pages/editor-uploaded.html',
  'utf8',
);
test.beforeEach(async ({ context }) => {
  await denyExternalNetwork(context);
});
test('extracts DOM order and preserves genuine repeated images, never hidden templates or identity claims', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  const value = await readEditorEvidence(page);
  expect(value.blocks.map((block) => block.type)).toEqual([
    'paragraph',
    'image',
    'image',
    'paragraph',
  ]);
  expect(value.blocks.filter((block) => block.type === 'image')).toHaveLength(
    2,
  );
  expect(value.blocks[0]).toEqual({ type: 'paragraph', text: '  开始 原文  ' });
  expect(value.title).toBe('  合成标题  ');
  expect(value.blocks.filter((block) => block.type === 'image')).toEqual([
    { type: 'image', resourceKey: '', loaded: true },
    { type: 'image', resourceKey: '', loaded: true },
  ]);
  expect(value).toMatchObject({
    known: false,
    store: null,
    remote: null,
    cover: null,
    isDraft: false,
  });
});
test('uploaded editor image has one visible stable resource across CDN renditions', async ({
  page,
}) => {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await page.route('https://www.autoengine.com/fixture-image.png*', (route) =>
    route.fulfill({ body: pixel, contentType: 'image/png' }),
  );
  await page.setContent(uploadedEditorFixture);
  const first = await readEditorEvidence(page);
  expect(first.title).toBe('合成单篇标题');
  expect(first.blocks.map((block) => block.type)).toEqual([
    'paragraph',
    'paragraph',
    'image',
    'paragraph',
  ]);
  expect(first.blocks[0]).toEqual({ type: 'paragraph', text: '第一段' });
  expect(first.blocks[1]).toEqual({ type: 'paragraph', text: '' });
  expect(first.blocks[3]).toEqual({ type: 'paragraph', text: '第二段' });
  const image = first.blocks[2];
  expect(image?.type).toBe('image');
  if (image?.type !== 'image') throw new Error('fixture image missing');
  expect(image.loaded).toBe(true);
  expect(image.resourceKey).toMatch(/^[a-f0-9]{64}$/);
  expect(first).toMatchObject({
    known: false,
    store: null,
    remote: null,
    cover: null,
    isDraft: false,
  });

  await page.locator('.pgc-image img').evaluate((node) => {
    (node as HTMLImageElement).src =
      'https://www.autoengine.com/fixture-image.png?web_uri=synthetic%2Fbody-resource&rendition=another';
  });
  await expect
    .poll(() =>
      page
        .locator('.pgc-image img')
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const second = await readEditorEvidence(page);
  expect(second.blocks[2]).toEqual(image);

  await page.locator('div[__syl_tag] img').evaluateAll((nodes) => {
    for (const node of nodes) {
      node.setAttribute('web_uri', 'synthetic/different-resource');
      (node as HTMLImageElement).src =
        'https://www.autoengine.com/fixture-image.png?web_uri=synthetic%2Fdifferent-resource&rendition=visible';
    }
  });
  await expect
    .poll(() =>
      page
        .locator('.pgc-image img')
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const third = await readEditorEvidence(page);
  expect(third.blocks[2]?.type).toBe('image');
  expect(third.blocks[2]).not.toEqual(image);
  if (third.blocks[2]?.type !== 'image')
    throw new Error('fixture image missing');
  expect(third.blocks[2].resourceKey).toMatch(/^[a-f0-9]{64}$/);
  expect(third.blocks[2].resourceKey).not.toBe(image.resourceKey);
});
test('mismatched uploaded image attribute and URL cannot claim a resource', async ({
  page,
}) => {
  await page.setContent(uploadedEditorFixture);
  await page.locator('.pgc-image img').evaluate((node) => {
    node.setAttribute('web_uri', 'synthetic/other-resource');
  });
  const observed = await readEditorEvidence(page);
  expect(observed.blocks[2]).toEqual({
    type: 'image',
    resourceKey: '',
    loaded: false,
  });
  expect(observed.known).toBe(false);
});
test('uploaded image wrapper with two visible images is unsupported', async ({
  page,
}) => {
  await page.setContent(uploadedEditorFixture);
  await page.locator('.pgc-img-wrapper').evaluate((wrapper) => {
    wrapper.appendChild(wrapper.querySelector('img')!.cloneNode(true));
  });
  expect(await readEditorEvidence(page)).toMatchObject({
    known: false,
    title: '',
    blocks: [],
  });
});
test('missing and ambiguous main containers cannot leak a partial content match', async ({
  page,
}) => {
  for (const html of [
    editorFixture.replace('contenteditable="true"', 'contenteditable="false"'),
    editorFixture + '<div contenteditable="true"><p>陌生正文</p></div>',
  ]) {
    await page.setContent(html);
    expect((await readEditorEvidence(page)).blocks).toEqual([]);
  }
});
test('interior ProseMirror empty paragraphs are content, not trailing editor padding', async ({
  page,
}) => {
  await page.setContent(
    '<textarea></textarea><div contenteditable="true"><p>first</p><p><br class="ProseMirror-trailingBreak"></p><p><br class="ProseMirror-trailingBreak"></p><p>last</p><p><br class="ProseMirror-trailingBreak"></p></div>',
  );
  expect((await readEditorEvidence(page)).blocks).toEqual([
    { type: 'paragraph', text: 'first' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: 'last' },
  ]);
});

test('visible line breaks and empty paragraphs retain their body positions', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div[contenteditable="true"]:not([role])')
    .evaluate((body) => {
      body.innerHTML = '<p>first<br>second</p><p></p><p><br></p><p>last</p>';
    });
  expect((await readEditorEvidence(page)).blocks).toEqual([
    { type: 'paragraph', text: 'first\nsecond' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '\n' },
    { type: 'paragraph', text: 'last' },
  ]);
});
test('real empty editor widget is presentation, while changed or nonempty shapes remain content', async ({
  page,
}) => {
  const placeholder =
    '<p><span class="syl-placeholder ProseMirror-widget" ignoreel="true" contenteditable="false">请输入正文</span><img class="ProseMirror-separator" alt=""><br class="ProseMirror-trailingBreak"></p>';
  await page.setContent(
    '<textarea></textarea><div contenteditable="true">' +
      placeholder +
      '</div>',
  );
  expect(await readEditorEvidence(page, true)).toMatchObject({
    known: true,
    title: '',
    blocks: [],
  });
  for (const changed of [
    placeholder.replace('请输入正文', '真实正文'),
    placeholder.replace('contenteditable="false"', 'contenteditable="true"'),
    placeholder.replace('<img class=', '<img src="/real-image.png" class='),
    placeholder.replace('</p>', '额外正文</p>'),
  ]) {
    await page.setContent(
      '<textarea></textarea><div contenteditable="true">' + changed + '</div>',
    );
    const value = await readEditorEvidence(page, true);
    expect(value.known && value.blocks.length === 0).toBe(false);
  }
});
test('hidden-only paragraph contents do not create phantom empty blocks', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div[contenteditable="true"]:not([role])')
    .evaluate((body) => {
      body.innerHTML =
        '<p>first</p><p><img style="display:none"></p><p><span style="display:none">hidden</span></p><p></p><p><br></p><p>last</p>';
    });
  expect((await readEditorEvidence(page)).blocks).toEqual([
    { type: 'paragraph', text: 'first' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '\n' },
    { type: 'paragraph', text: 'last' },
  ]);
});
test('visible empty span wrappers survive without adding text around images', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div[contenteditable="true"]:not([role])')
    .evaluate((body) => {
      body.innerHTML =
        '<p><span></span></p><p><span><span></span></span></p><p><span><span style="display:none">hidden</span></span></p><p><span style="display:none">hidden</span></p><p><span></span><img></p><p><span><img></span></p><p><span></span><img style="width:0"></p><p><img style="width:0"></p><p><span style="display:none">hidden</span><span></span></p>';
    });
  expect((await readEditorEvidence(page)).blocks).toEqual([
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '' },
    { type: 'image', resourceKey: '', loaded: false },
    { type: 'image', resourceKey: '', loaded: false },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: '' },
  ]);
});
test('zero-size image templates do not split visible paragraph text', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div[contenteditable="true"]:not([role])')
    .evaluate((body) => {
      body.innerHTML = '<p>before<img style="width:0">after</p>';
    });
  expect((await readEditorEvidence(page)).blocks).toEqual([
    { type: 'paragraph', text: 'beforeafter' },
  ]);
});
test('unexpected root text makes the entire editor observation unknown', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div[contenteditable="true"]:not([role])')
    .evaluate((body) => {
      body.innerHTML = '<p>first</p>unexpected text<p>second</p>';
    });
  expect(await readEditorEvidence(page)).toMatchObject({
    known: false,
    title: '',
    blocks: [],
  });
});
test('zero size images excluded and unloaded images remain visibly unverified', async ({
  page,
}) => {
  await page.setContent(editorFixture);
  await page
    .locator('div:not([role]) > p img')
    .first()
    .evaluate((img) => ((img as HTMLElement).style.width = '0'));
  await page
    .locator('div:not([role]) > p img')
    .nth(1)
    .evaluate(
      (img) => ((img as HTMLImageElement).src = 'data:image/png;base64,broken'),
    );
  const value = await readEditorEvidence(page);
  expect(value.blocks.filter((block) => block.type === 'image')).toEqual([
    { type: 'image', resourceKey: '', loaded: false },
  ]);
  expect(value.known).toBe(false);
});
test('synthetic overlays, unfamiliar bodies and same title cannot become draft evidence', async ({
  page,
  context,
}) => {
  const session: BrowserSession = {
    current: () => context,
    generation: () => 'generation',
    open: async () => {
      throw Error('must not open');
    },
    close: async () => {
      throw Error('must not close');
    },
  };
  const pages = createJudongchePages(session);
  const overlayUrl = 'https://www.autoengine.com/jdc/dealer/info/Article';
  for (const suffix of [
    '<div role="dialog">验证码</div>',
    '<div style="position:fixed;inset:0">未知遮罩</div>',
    '<div>权限不足</div>',
    '<div>同名门店 同名门店</div>',
    '<div>陌生正文</div>',
  ]) {
    await context.route(overlayUrl, (route) =>
      route.fulfill({ body: editorFixture + suffix, contentType: 'text/html' }),
    );
    await page.goto(overlayUrl);
    expect(await pages.probe()).toEqual({
      status: 'blocked',
      reason: suffix.includes('验证码')
        ? 'VERIFICATION_REQUIRED'
        : suffix.includes('权限不足')
          ? 'PERMISSION_DENIED'
          : 'PAGE_CHANGED',
    });
    expect((await pages.inspectEditor()).known).toBe(false);
    expect(
      await pages.inspectDraft({
        recordKey: 'other-record',
        editUrl:
          'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=other&pgc_status=3',
      }),
    ).toBeUndefined();
    expect(page.url()).toBe(overlayUrl);
  }
});
test('external attempted navigation is denied before unknown-page recognition', async ({
  page,
}) => {
  const failed = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url() === 'https://example.invalid/unknown',
  });
  await page.goto('https://example.invalid/unknown').catch(() => undefined);
  expect((await failed).failure()?.errorText).toMatch(
    /^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/,
  );
  expect((await readEditorEvidence(page)).known).toBe(false);
});
test('expected-origin observed login is blocked without reading credential values', async ({
  page,
  context,
}) => {
  const html = readFileSync(
    'tests/fixtures/judongche-pages/login.html',
    'utf8',
  );
  await context.route('https://www.autoengine.com/', (route) =>
    route.fulfill({ body: html, contentType: 'text/html' }),
  );
  await page.goto('https://www.autoengine.com/');
  const session: BrowserSession = {
    current: () => context,
    generation: () => 'g',
    open: async () => context,
    close: async () => {},
  };
  expect(await createJudongchePages(session).probe()).toEqual({
    status: 'blocked',
    reason: 'LOGIN_REQUIRED',
  });
});
test('synthetic expected-origin state never acquires store or record identity even with plausible query and same-name stores', async ({
  page,
  context,
}) => {
  const url =
    'https://www.autoengine.com/jdc/dealer/info/Article?pgc_id=123&pgc_status=3';
  await context.route(url, (route) =>
    route.fulfill({
      body: editorFixture + '<div>同名门店 同名门店</div>',
      contentType: 'text/html',
    }),
  );
  await page.goto(url);
  const session: BrowserSession = {
    current: () => context,
    generation: () => 'g',
    open: async () => context,
    close: async () => {},
  };
  const pages = createJudongchePages(session);
  expect(await pages.probe()).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  expect(await pages.inspectEditor()).toMatchObject({
    known: false,
    store: null,
    isDraft: false,
    remote: null,
    cover: null,
  });
  expect(
    await pages.inspectDraft({ recordKey: '123', editUrl: url }),
  ).toBeUndefined();
  expect(page.url()).toBe(url);
  const second = await context.newPage();
  expect(await pages.probe()).toEqual({
    status: 'blocked',
    reason: 'PAGE_CHANGED',
  });
  await second.close();
});
test('observed list and synthetic cover fragments cannot verify same-title records or first material', async ({
  page,
  context,
}) => {
  const listUrl =
    'https://www.autoengine.com/jdc/dealer/info/contentPublish/content/index';
  const editorUrl = 'https://www.autoengine.com/jdc/dealer/info/Article';
  const session: BrowserSession = {
    current: () => context,
    generation: () => 'g',
    open: async () => context,
    close: async () => {},
  };
  const pages = createJudongchePages(session);
  for (const [url, file] of [
    [listUrl, 'content-list.html'],
    [editorUrl, 'cover.html'],
  ] as const) {
    const fixture = readFileSync(
      'tests/fixtures/judongche-pages/' + file,
      'utf8',
    );
    await context.route(url, (route) =>
      route.fulfill({ body: fixture, contentType: 'text/html' }),
    );
    await page.goto(url);
    expect(await pages.probe()).toEqual({
      status: 'blocked',
      reason: 'PAGE_CHANGED',
    });
    expect(
      await pages.inspectDraft({
        recordKey: 'same-title-other-record',
        editUrl: editorUrl + '?pgc_id=456&pgc_status=3',
      }),
    ).toBeUndefined();
    expect(await pages.inspectEditor()).toMatchObject({
      known: false,
      remote: null,
      cover: null,
      isDraft: false,
    });
    expect(page.url()).toBe(url);
  }
});
test('closed session never launches implicitly and foreign login imitation remains page changed', async ({
  page,
  context,
}) => {
  const session: BrowserSession = {
    current: () => undefined,
    generation: () => 'g',
    open: async () => {
      throw Error('implicit open');
    },
    close: async () => {},
  };
  expect(await createJudongchePages(session).probe()).toEqual({
    status: 'blocked',
    reason: 'BROWSER_UNAVAILABLE',
  });
  const url = 'https://example.invalid/login';
  await context.route(url, (route) =>
    route.fulfill({
      body: readFileSync('tests/fixtures/judongche-pages/login.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  await page.goto(url);
  expect(
    await createJudongchePages({ ...session, current: () => context }).probe(),
  ).toEqual({ status: 'blocked', reason: 'PAGE_CHANGED' });
});

import { draftHarness } from '../fixtures/draft-adapter';
import { createAdapterWithPages } from '../../src/infrastructure/platforms/judongche/draft-adapter';
test('controlled normal inputs preserve A-image-image-B with one save and no other actions', async ({
  page,
  context,
}) => {
  const h = draftHarness();
  await page.setContent(
    readFileSync('tests/fixtures/judongche-pages/actions.html', 'utf8'),
  );
  const session: BrowserSession = {
    open: async () => context,
    current: () => context,
    generation: () => 'fixture',
    close: async () => {},
  };
  const inspect = h.pages.inspectEditor;
  h.pages.inspectEditor = async () => ({
    ...(await inspect()),
    title: await page
      .getByLabel('Synthetic title', { exact: true })
      .inputValue(),
    blocks: await page.locator('#body').evaluate((body) =>
      Array.from(body.children).map((node) =>
        node instanceof HTMLImageElement
          ? {
              type: 'image' as const,
              resourceKey: node.dataset.resource!,
              loaded: node.complete && node.naturalWidth > 0,
            }
          : { type: 'paragraph' as const, text: node.textContent ?? '' },
      ),
    ),
  });
  h.pages.fillTitle = (text) =>
    page.getByLabel('Synthetic title', { exact: true }).fill(text);
  h.pages.appendParagraph = async (text) => {
    await page.getByLabel('Synthetic paragraph', { exact: true }).fill(text);
    await page.locator('#append').click();
  };
  h.pages.appendImage = async (bytes, mime) => {
    await page.getByLabel('Synthetic image', { exact: true }).setInputFiles({
      name: 'fixture.png',
      mimeType: mime,
      buffer: Buffer.from(bytes),
    });
    const img = page.locator('#body img').last();
    await expect
      .poll(() =>
        img.evaluate(
          (node) =>
            (node as HTMLImageElement).complete &&
            (node as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
    return (await img.getAttribute('data-resource'))!;
  };
  h.pages.chooseFirstCover = async () => {
    throw Error('cover selection is outside this draft path');
  };
  const save = h.pages.saveOnce;
  h.pages.saveOnce = async () => {
    await page.locator('#save').click();
    await save();
  };
  h.pages.inspectDraft = async () => ({
    ...(await h.pages.inspectEditor()),
    isDraft: true,
  });
  expect(
    (await createAdapterWithPages(session, h.pages).execute(h.task, h.hooks))
      .status,
  ).toBe('verified');
  expect(await page.locator('#events').textContent()).toBe(
    'paragraph|image|image|paragraph|save|',
  );
  expect(h.durable().evidence.images.map((image) => image.bodyIndex)).toEqual([
    1, 2,
  ]);
});

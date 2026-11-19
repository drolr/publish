import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { readEditorEvidence } from '../../src/infrastructure/platforms/judongche/page-contract';
import { readRichEditorBlocks } from '../../src/infrastructure/platforms/judongche/rich-editor-dom';
import { denyExternalNetwork } from './network-policy';

type Mark = 'bold' | 'italic' | 'underline';
type Run = { type: 'text'; text: string; marks: Mark[] };
type Leaf = { type: 'paragraph'; content: Run[] };

const text = (value: string, marks: Mark[] = []): Run => ({
  type: 'text',
  text: value,
  marks,
});
const paragraph = (...content: Run[]): Leaf => ({ type: 'paragraph', content });
const bullet = (...items: Leaf[]) => ({
  type: 'list' as const,
  kind: 'bullet' as const,
  items,
});
const ordered = (start: number, ...items: Leaf[]) => ({
  type: 'list' as const,
  kind: 'ordered' as const,
  start,
  items,
});
const blockquote = (...paragraphs: Leaf[]) => ({
  type: 'blockquote' as const,
  paragraphs,
});
const image = (resourceKey: string) => ({
  type: 'image' as const,
  resourceKey,
  loaded: true,
});

const dump = (name: string): string =>
  readFileSync(`tests/fixtures/judongche-rich-dom/${name}.html`, 'utf8');

const shell = (draft: string): string =>
  [
    '<!doctype html><meta charset="utf-8" />',
    '<style>[contenteditable="true"]{min-height:20px}.pgc-image img{width:20px;height:20px}</style>',
    '<textarea>合成标题</textarea>',
    `<div contenteditable="true">${draft}</div>`,
    '<div contenteditable="true" role="textbox"><p><br /></p></div>',
  ].join('');

test.beforeEach(async ({ context }) => {
  await denyExternalNetwork(context);
});

test('reads the eight-block production draft', async ({ page }) => {
  await page.setContent(shell(dump('B08-final')));
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('段一')),
    bullet(paragraph(text('项目一')), paragraph(text('项目二'))),
    paragraph(text('段二')),
    ordered(1, paragraph(text('有序一')), paragraph(text('有序二'))),
    blockquote(paragraph(text('引用一')), paragraph(text('引用二'))),
    paragraph(text('段三')),
    { type: 'heading', content: [text('标题一')] },
    paragraph(text('段四')),
  ]);
});

test('reads headings, lists and quotes that the legacy block reader refuses', async ({
  page,
}) => {
  await page.setContent(shell(dump('B08-final')));
  const legacy = await readEditorEvidence(page);
  expect(legacy.blocks).toEqual([]);
  expect(legacy.known).toBe(false);
  expect(await readRichEditorBlocks(page)).toHaveLength(8);
  await page.setContent(shell(dump('B05-blockquote')));
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('段一')),
    bullet(paragraph(text('项目一')), paragraph(text('项目二'))),
    paragraph(text('段二')),
    ordered(1, paragraph(text('有序一')), paragraph(text('有序二'))),
    blockquote(paragraph(text('引用一')), paragraph(text('引用二'))),
  ]);
});

test('keeps inline marks ordered, merged and transparent through spans and breaks', async ({
  page,
}) => {
  await page.setContent(
    shell(
      '<p>甲<strong>乙</strong><strong>丙</strong>丁</p>' +
        '<p><u><i><strong>全</strong></i></u><strong><em>斜粗</em></strong><strong>粗</strong>平</p>' +
        '<p><span>前</span><br />后</p>' +
        '<p><br class="ProseMirror-trailingBreak"></p>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('甲'), text('乙丙', ['bold']), text('丁')),
    paragraph(
      text('全', ['bold', 'italic', 'underline']),
      text('斜粗', ['bold', 'italic']),
      text('粗', ['bold']),
      text('平'),
    ),
    paragraph(text('前\n后')),
  ]);
});

test('reads the three-run mark sample verbatim', async ({ page }) => {
  await page.setContent(shell(dump('E04-three-runs')));
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('甲乙'), text('丙丁', ['bold']), text('戊己')),
  ]);
});

test('reads a soft break inside a list item as inline text', async ({
  page,
}) => {
  await page.setContent(shell(dump('D07-li-softbreak')));
  expect(await readRichEditorBlocks(page)).toEqual([
    bullet(paragraph(text('项甲\n项乙'))),
  ]);
});

test('reads the empty draft as no blocks', async ({ page }) => {
  await page.setContent(shell(dump('B00-empty')));
  expect(await readRichEditorBlocks(page)).toEqual([]);
});

test('treats the empty-draft placeholder as absent, not as text', async ({
  page,
}) => {
  await page.setContent(
    shell(
      '<p class="ProseMirror-selectednode" draggable="true"><span class="syl-placeholder ProseMirror-widget" ignoreel="true" contenteditable="false">请输入正文</span><img class="ProseMirror-separator" alt=""><br class="ProseMirror-trailingBreak"></p>' +
        '<p>后</p>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toEqual([paragraph(text('后'))]);
});

test('trims trailing blank list items from real dumps', async ({ page }) => {
  await page.setContent(shell(dump('q3b-b02-ul-2items')));
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('段一')),
    bullet(paragraph(text('项目一项目二'))),
  ]);
  await page.setContent(shell(dump('V2-enter-once-02-exited')));
  expect(await readRichEditorBlocks(page)).toEqual([
    bullet(paragraph(text('甲项目甲')), paragraph(text('项目乙'))),
  ]);
});

test('drops trailing padding paragraphs but keeps an interior blank one', async ({
  page,
}) => {
  await page.setContent(
    shell(
      '<p>前</p><p><br class="ProseMirror-trailingBreak"></p><p>后</p><p><br class="ProseMirror-trailingBreak"></p><p><br class="ProseMirror-trailingBreak"></p>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toEqual([
    paragraph(text('前')),
    paragraph(),
    paragraph(text('后')),
  ]);
});

test('trims empty list and quote padding only at the document end', async ({
  page,
}) => {
  await page.setContent(
    shell(
      '<p>前</p><blockquote><p><br class="ProseMirror-trailingBreak"></p></blockquote><ul><li><br class="ProseMirror-trailingBreak"></li></ul>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toEqual([paragraph(text('前'))]);
  await page.setContent(
    shell(
      '<blockquote><p><br class="ProseMirror-trailingBreak"></p></blockquote><p>后</p>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toBeNull();
});

test('keeps ordered list start and any heading level', async ({ page }) => {
  await page.setContent(
    shell(
      '<h2>二级</h2><h6>六级</h6><ol start="3"><li>三</li><li>四</li></ol><p><br class="ProseMirror-trailingBreak"></p>',
    ),
  );
  expect(await readRichEditorBlocks(page)).toEqual([
    { type: 'heading', content: [text('二级')] },
    { type: 'heading', content: [text('六级')] },
    ordered(3, paragraph(text('三')), paragraph(text('四'))),
  ]);
});

test('reads an uploaded image block with the upload-proof resource key', async ({
  page,
}) => {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await page.route('https://www.autoengine.com/fixture-image.png*', (route) =>
    route.fulfill({ body: pixel, contentType: 'image/png' }),
  );
  await page.setContent(shell(dump('image-uploaded')));
  const expectedKey = createHash('sha256')
    .update('judongche:web_uri\0')
    .update('synthetic/body-resource')
    .digest('hex');
  const blocks = await readRichEditorBlocks(page);
  expect(blocks).toEqual([
    paragraph(text('段一')),
    image(expectedKey),
    paragraph(text('段二')),
  ]);
  const legacy = await readEditorEvidence(page);
  expect(legacy.blocks[1]).toEqual(image(expectedKey));
});

test('fails closed as null for every unsupported editor shape', async ({
  page,
}) => {
  const cases: [string, string][] = [
    ['missing title box', '<div contenteditable="true"><p>正文</p></div>'],
    [
      'two visible title boxes',
      '<textarea>一</textarea><textarea>二</textarea><div contenteditable="true"><p>正文</p></div>',
    ],
    ['missing body', '<textarea>标题</textarea>'],
    [
      'two visible bodies',
      '<textarea>标题</textarea><div contenteditable="true"><p>一</p></div><div contenteditable="true"><p>二</p></div>',
    ],
    [
      'hidden title box',
      '<textarea style="display:none">标题</textarea><div contenteditable="true"><p>正文</p></div>',
    ],
    [
      'hidden body',
      '<textarea>标题</textarea><div contenteditable="true" style="visibility:hidden"><p>正文</p></div>',
    ],
    ['stray root text', shell('裸文本<p>正文</p>')],
    ['unknown block element', shell('<div>卡片</div>')],
    ['unknown inline element', shell('<p><a href="#">链接</a></p>')],
    ['strikethrough inline', shell('<p><s>删除线</s></p>')],
    ['nested list', shell('<ul><li>外层<ul><li>内层</li></ul></li></ul>')],
    [
      'image inside a list',
      shell('<ul><li><img src="https://example.invalid/x.png" /></li></ul>'),
    ],
    [
      'blockquote holding a div',
      shell('<blockquote><div>引用</div></blockquote>'),
    ],
    ['list item holding a paragraph', shell('<ul><li><p>正文</p></li></ul>')],
    [
      'two visible images in one wrapper',
      shell(
        '<div __syl_tag="true" contenteditable="false" draggable="true"><div class="pgc-image"><div class="pgc-img-wrapper"><img src="https://example.invalid/a.png" /><img src="https://example.invalid/b.png" /></div></div></div>',
      ),
    ],
  ];
  for (const [label, html] of cases) {
    await page.setContent(html);
    expect(await readRichEditorBlocks(page), label).toBeNull();
  }
});

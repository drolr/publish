import { createElement } from 'react';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Preview } from '../../src/renderer/library/Preview';
import type { ArticlePreview } from '../../src/contracts/article-library';
it('preview renders authoritative rich semantics, soft breaks, empty paragraphs and escaped text', () => {
  const article: ArticlePreview = {
    articleKey: '11111111-1111-4111-8111-111111111111',
    externalId: 'rich',
    title: 'Title',
    articleRevision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    contentDeclaration: 'original',
    imageCount: 0,
    assets: [],
    body: [{ type: 'paragraph', text: 'lossy projection' }],
    editorBody: {
      version: 2,
      blocks: [
        {
          type: 'heading',
          content: [
            {
              type: 'text',
              text: '小标题',
              marks: ['bold', 'italic', 'underline'],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>bad()</script>\n第二行', marks: [] },
          ],
        },
        { type: 'paragraph', content: [] },
        {
          type: 'list',
          kind: 'ordered',
          start: 7,
          items: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '第七项', marks: [] }],
            },
          ],
        },
        {
          type: 'list',
          kind: 'bullet',
          items: [{ type: 'paragraph', content: [] }],
        },
        {
          type: 'blockquote',
          paragraphs: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '引用', marks: [] }],
            },
          ],
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(Preview, { article, focus: false }),
  );
  expect(html).toContain(
    '<h2 class="body-text"><strong><em><u>小标题</u></em></strong></h2>',
  );
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;<br/>第二行');
  expect(html).toContain('<p class="body-text"><br/></p>');
  expect(html).toContain(
    '<ol start="7" style="white-space:pre-wrap;overflow-wrap:anywhere"><li>第七项</li></ol>',
  );
  expect(html).toContain(
    '<ul style="white-space:pre-wrap;overflow-wrap:anywhere"><li><br/></li></ul>',
  );
  expect(html).toContain(
    '<blockquote><p class="body-text">引用</p></blockquote>',
  );
  expect(html).not.toContain('lossy projection');
  expect(html).not.toContain('<script>');
});

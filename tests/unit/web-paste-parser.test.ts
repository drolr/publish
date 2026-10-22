import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { WebPasteInput } from '../../src/contracts/web-paste';
import { convertWebPaste } from '../../src/infrastructure/content/web-paste-parser';
import { WebPasteFailure } from '../../src/domain/web-paste-error';

// Removing HTML precedence, a budget check, or inert traversal breaks these cases.
async function convert(html: string, plain = '') {
  return convertWebPaste({ html, plain });
}
async function rejects(html: string, code: string, plain = '') {
  await expect(convert(html, plain)).rejects.toMatchObject({
    code,
    message: code,
  });
}
function cfHtml(fragment: string) {
  const header =
    'Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\nSourceURL:https://private.test/\r\n';
  const prefix = '<html><body>前<!--StartFragment-->';
  const suffix = '<!--EndFragment-->后</body></html>';
  const start = Buffer.byteLength(header);
  const fragmentStart = start + Buffer.byteLength(prefix);
  return (
    header
      .replace(
        'StartHTML:0000000000',
        `StartHTML:${String(start).padStart(10, '0')}`,
      )
      .replace(
        'EndHTML:0000000000',
        `EndHTML:${String(fragmentStart + Buffer.byteLength(fragment + suffix)).padStart(10, '0')}`,
      )
      .replace(
        'StartFragment:0000000000',
        `StartFragment:${String(fragmentStart).padStart(10, '0')}`,
      )
      .replace(
        'EndFragment:0000000000',
        `EndFragment:${String(fragmentStart + Buffer.byteLength(fragment)).padStart(10, '0')}`,
      ) +
    prefix +
    fragment +
    suffix
  );
}
it('inline_image_order retains text-image-text and internal br', async () => {
  expect(
    await convert('<p>甲<img src="https://example.test/a">乙<br>丙</p>'),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲' },
      { type: 'image', source: 'https://example.test/a' },
      { type: 'paragraph', text: '乙\n丙' },
    ],
  });
});
it('fixture retains headings, implicit list endings, figure and container order', async () => {
  expect(
    await convert(
      readFileSync('tests/fixtures/web-paste/ordered.html', 'utf8'),
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '标题 😀' },
      { type: 'paragraph', text: '甲 乙& 丙' },
      { type: 'paragraph', text: '一' },
      { type: 'paragraph', text: '二' },
      { type: 'image', source: 'https://example.test/a?x=1&y=2' },
      { type: 'paragraph', text: '说明' },
      { type: 'paragraph', text: '外内' },
      { type: 'paragraph', text: '段' },
      { type: 'paragraph', text: '尾' },
    ],
  });
});
it('html_preferred_no_fallback rejects unsupported HTML even with good plain', async () => {
  await rejects(
    '<table><tr><td>bad</td></tr></table>',
    'UNSUPPORTED_STRUCTURE',
    'safe',
  );
});
it.each([
  'table',
  'pre',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas',
  'svg',
  'form',
  'input',
  'textarea',
  'select',
  'button',
])('hidden_forbidden_still_rejects %s', async (tag) => {
  await rejects(
    `<div hidden><${tag}></${tag}></div><p>safe</p>`,
    'UNSUPPORTED_STRUCTURE',
  );
  await rejects(
    `<head><${tag}></${tag}></head><p>safe</p>`,
    'UNSUPPORTED_STRUCTURE',
  );
});
it('ignores inert subtrees and resources without interpreting CSS or alt', async () => {
  expect(
    await convert(
      '<head><base href="https://private.test/"><link href="https://private.test/a"></head><script>throw Error("bad")</script><style>p{display:none}</style><p style="display:none" onclick="fetch()">甲<!--noise-->乙<span hidden>丢</span><i aria-hidden="true">丢</i><img alt="not text" data-src="https://example.test/a"></p>',
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲乙' },
      { type: 'image', source: undefined },
    ],
  });
});
it('retains every image position and decoded src without base/lazy guessing', async () => {
  expect(
    await convert(
      '<base href="https://example.test/"><img src="/a"><img src="/a"><picture><source srcset="https://example.test/b"><img srcset="https://example.test/c"></picture><img src="data:x"><img src="">',
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'image', source: '/a' },
      { type: 'image', source: '/a' },
      { type: 'image', source: undefined },
      { type: 'image', source: 'data:x' },
      { type: 'image', source: '' },
    ],
  });
});
it('plain-only normalizes line endings and divides only at repeated LF', async () => {
  expect(await convert('', ' 甲\r\n乙 \r\n\r\n\r\n \t\r\r丙😀 ')).toEqual({
    plainOnly: true,
    blocks: [
      { type: 'paragraph', text: ' 甲\n乙 ' },
      { type: 'paragraph', text: '丙😀 ' },
    ],
  });
});
it.each(['', '   ', '<div><br><!--empty--></div>', '<script>x</script>'])(
  'rejects empty effective content %j',
  async (html) => rejects(html, 'EMPTY'),
);
it('collapses ordinary whitespace across inline boundaries without dropping br or Unicode', async () => {
  expect(
    await convert(
      '<p> \t甲<span> \r\n&nbsp; </span>乙<br><br>丙😀 </p><p>丁</p>',
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲 乙\n\n丙😀' },
      { type: 'paragraph', text: '丁' },
    ],
  });
});
it('cf_html_utf8_offsets extracts exact Chinese boundaries', async () => {
  expect(await convert(cfHtml('甲😀<p>乙</p>'))).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲😀' },
      { type: 'paragraph', text: '乙' },
    ],
  });
});
it('rejects explicit byte offsets inside a multibyte character', async () => {
  const input = cfHtml('甲乙');
  const number = Number(input.match(/StartFragment:(\d+)/)![1]);
  await rejects(
    input.replace(
      /StartFragment:\d+/,
      `StartFragment:${String(number + 1).padStart(10, '0')}`,
    ),
    'INVALID_FRAGMENT',
  );
});
it.each([
  '<!--StartFragment--><p>甲</p>',
  '<p>甲</p><!--EndFragment-->',
  '<!--EndFragment-->甲<!--StartFragment-->',
  '<!--StartFragment-->甲<!--StartFragment--><!--EndFragment-->',
])('rejects incomplete or contradictory markers %s', async (html) =>
  rejects(html, 'INVALID_FRAGMENT'),
);
it('markers select the fragment without offset or SourceURL inference', async () => {
  expect(
    await convert(
      'Version:1.0\r\nStartHTML:-1\r\nEndHTML:-1\r\nSourceURL:https://private.test\r\n<html>out<!--StartFragment-->甲<img src="relative"><!--EndFragment-->out</html>',
    ),
  ).toEqual({
    plainOnly: false,
    blocks: [
      { type: 'paragraph', text: '甲' },
      { type: 'image', source: 'relative' },
    ],
  });
});
it.each([
  'StartFragment:bad\r\n',
  'StartFragment:0000000010\r\n',
  'StartHTML:0000000000\r\nEndHTML:9999999999\r\n',
])('explicit damaged boundaries never fall back %s', async (header) =>
  rejects(
    header + '<!--StartFragment-->甲<!--EndFragment-->',
    'INVALID_FRAGMENT',
    'safe',
  ),
);
it('rejects explicit offsets conflicting with intact markers', async () => {
  const input = cfHtml('甲乙');
  const number = Number(input.match(/StartFragment:(\d+)/)![1]);
  await rejects(
    input.replace(
      /StartFragment:\d+/,
      `StartFragment:${String(number + 3).padStart(10, '0')}`,
    ),
    'INVALID_FRAGMENT',
  );
});
it.each([
  '<p>safe<img src="unfinished',
  '<p>safe<!--unfinished',
  '<p>safe</p><butto',
])('rejects unsafe incomplete markup %s', async (html) =>
  rejects(html, 'INVALID_FRAGMENT'),
);
it('node budget counts ignored elements, text and comments at 50000/50001', async () => {
  expect(
    await convert('<span hidden></span>'.repeat(49998) + '<p>甲</p>'),
  ).toEqual({ plainOnly: false, blocks: [{ type: 'paragraph', text: '甲' }] });
  await rejects(
    '<span hidden></span>'.repeat(49999) + '<p>甲</p>',
    'PARSE_LIMIT',
  );
  expect(
    (await convert('<!--x-->'.repeat(49998) + '<p>甲</p>')).blocks,
  ).toHaveLength(1);
  await rejects('<!--x-->'.repeat(49999) + '<p>甲</p>', 'PARSE_LIMIT');
  await rejects('<span hidden>x</span>'.repeat(25000) + '甲', 'PARSE_LIMIT');
});
it('consecutive decoded text callbacks count as one node', async () => {
  expect(
    (
      await convert(
        '<span hidden></span>'.repeat(49998) + '<p>&amp;甲&#x1f600;</p>',
      )
    ).blocks,
  ).toEqual([{ type: 'paragraph', text: '&甲😀' }]);
});
it('depth budget accepts 100 and rejects 101 including ignored trees', async () => {
  expect(
    (await convert('<span>'.repeat(100) + '甲' + '</span>'.repeat(100))).blocks,
  ).toEqual([{ type: 'paragraph', text: '甲' }]);
  await rejects(
    '<span hidden>'.repeat(101) + '甲' + '</span>'.repeat(101),
    'PARSE_LIMIT',
  );
});
it('input bytes count UTF8 of HTML plus plain at 2MiB and plus one', async () => {
  const html = '<p>甲</p>';
  const plain = 'x'.repeat(2097152 - Buffer.byteLength(html));
  expect((await convert(html, plain)).blocks).toEqual([
    { type: 'paragraph', text: '甲' },
  ]);
  await rejects(html, 'INPUT_LIMIT', plain + 'x');
});
it('paragraph code points permit 20000 emoji without treating surrogates as two', async () => {
  expect(
    (await convert('<p>' + '😀'.repeat(20000) + '</p>')).blocks,
  ).toHaveLength(1);
  await rejects('<p>' + '😀'.repeat(20001) + '</p>', 'PARSE_LIMIT');
});
it('full text, block and image budgets reject rather than truncate', async () => {
  expect(
    (await convert('<p>' + '甲'.repeat(20000) + '</p>')).blocks,
  ).toHaveLength(1);
  expect(
    (await convert(('<p>' + 'x'.repeat(20000) + '</p>').repeat(10))).blocks,
  ).toHaveLength(10);
  await rejects(
    ('<p>' + 'x'.repeat(20000) + '</p>').repeat(10) + '<p>x</p>',
    'PARSE_LIMIT',
  );
  expect((await convert('<p>x</p>'.repeat(1000))).blocks).toHaveLength(1000);
  await rejects('<p>x</p>'.repeat(1001), 'PARSE_LIMIT');
  expect((await convert('<img>'.repeat(200))).blocks).toHaveLength(200);
  await rejects('<img>'.repeat(201), 'PARSE_LIMIT');
});
it('fixed-code errors cannot carry original HTML or exceptions', async () => {
  const failure = new WebPasteFailure('INVALID_FRAGMENT');
  expect(failure.message).toBe('INVALID_FRAGMENT');
});
// Input is trusted TypeScript at call sites but runtime validation is still required.
it('rejects unknown input fields', async () => {
  expect(() =>
    convertWebPaste({
      html: '<p>x</p>',
      plain: '',
      extra: 'SECRET',
    } as WebPasteInput),
  ).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
});
it('CF_HTML offsets without markers can select raw UTF8 text', async () => {
  // Hand-counted UTF8 header: two 25-byte lines, followed by six Chinese bytes.
  expect(
    await convert('StartFragment:0000000050\r\nEndFragment:0000000056\r\n甲乙'),
  ).toEqual({
    plainOnly: false,
    blocks: [{ type: 'paragraph', text: '甲乙' }],
  });
});
it('rejects explicit fragment offsets into CF_HTML header text', async () => {
  await rejects(
    'StartFragment:0000000000\r\nEndFragment:0000000003\r\n<p>x</p>',
    'INVALID_FRAGMENT',
  );
});
it('drops an all-Unicode-whitespace HTML paragraph as empty', async () => {
  await rejects('<p>\u2003\u3000</p>', 'EMPTY');
});

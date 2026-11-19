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

// Rich V2 conversion is opt-in; changing mark scope, flattening a structure or
// dropping an empty paragraph must fail these semantic assertions.
const richConvert = async (html: string, plain = '') => {
  const parser =
    await import('../../src/infrastructure/content/web-paste-parser');
  return parser.convertRichWebPaste({ html, plain });
};
const run = (text: string, marks: string[] = []) => ({
  type: 'text',
  text,
  marks,
});
const paragraph = (...content: ReturnType<typeof run>[]) => ({
  type: 'paragraph',
  content,
});
it('rich keeps nested mark cancellation local and merges adjacent equivalent runs', async () => {
  expect(
    await richConvert(
      '<p><strong>甲<span style="font-weight:normal">乙<i>丙</i></span>丁</strong><b>戊</b><u><em>己</em></u></p>',
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: [],
    blocks: [
      paragraph(
        run('甲', ['bold']),
        run('乙'),
        run('丙', ['italic']),
        run('丁戊', ['bold']),
        run('己', ['italic', 'underline']),
      ),
    ],
  });
});
it.each(['bold', 'bolder', '600', '700', '1000'])(
  'rich recognizes explicit bold weight %s',
  async (weight) => {
    expect(
      (await richConvert(`<span style="font-weight:${weight}">甲</span>`))
        .blocks,
    ).toEqual([paragraph(run('甲', ['bold']))]);
  },
);
it.each(['normal', '100', '500'])(
  'rich overrides ancestor bold with %s',
  async (weight) => {
    expect(
      (
        await richConvert(
          `<b><span style="font-weight:${weight}">甲</span>乙</b>`,
        )
      ).blocks,
    ).toEqual([paragraph(run('甲'), run('乙', ['bold']))]);
  },
);
it('rich cancels and restores combined explicit inline styles', async () => {
  expect(
    (
      await richConvert(
        '<b><i><u>甲<span style="font-weight:400;font-style:normal;text-decoration:none">乙</span>丙</u></i></b>丁',
      )
    ).blocks,
  ).toEqual([
    paragraph(
      run('甲', ['bold', 'italic', 'underline']),
      run('乙'),
      run('丙', ['bold', 'italic', 'underline']),
      run('丁'),
    ),
  ]);
});
it('rich preserves soft lines, empty paragraphs and image order without leaking markup', async () => {
  expect(
    await richConvert(
      '<p></p><p><b>甲<br>乙<img src="relative">丙</b></p><p><br><br></p>',
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: [],
    blocks: [
      paragraph(),
      paragraph(run('甲\n乙', ['bold'])),
      { type: 'image', source: 'relative' },
      paragraph(run('丙', ['bold'])),
      paragraph(run('\n\n')),
    ],
  });
});
it('rich normalizes headings once without guessing from bold paragraphs', async () => {
  expect(
    await richConvert('<h1>甲</h1><h6><i>乙</i></h6><p><b>丙</b></p>'),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: ['HEADING_NORMALIZED'],
    blocks: [
      { type: 'heading', content: [run('甲')] },
      { type: 'heading', content: [run('乙', ['italic'])] },
      paragraph(run('丙', ['bold'])),
    ],
  });
});
it('rich retains flat list numbering and multiparagraph quotes', async () => {
  expect(
    (
      await richConvert(
        '<ol start="3"><li><p><b>甲</b><br>乙</p></li><li value="4">丙</li></ol><ul><li>丁</li></ul><blockquote><p>戊</p><p></p><p><u>己</u></p></blockquote>',
      )
    ).blocks,
  ).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 3,
      items: [
        paragraph(run('甲', ['bold']), run('\n乙')),
        paragraph(run('丙')),
      ],
    },
    { type: 'list', kind: 'bullet', items: [paragraph(run('丁'))] },
    {
      type: 'blockquote',
      paragraphs: [
        paragraph(run('戊')),
        paragraph(),
        paragraph(run('己', ['underline'])),
      ],
    },
  ]);
});
it.each([
  '<ul><li>甲<ul><li>乙</li></ul></li></ul>',
  '<blockquote><blockquote>甲</blockquote></blockquote>',
  '<ul><li><img src="x"></li></ul>',
  '<blockquote><img src="x"></blockquote>',
  '<ul><li><h2>甲</h2></li></ul>',
  '<blockquote><h2>甲</h2></blockquote>',
  '<blockquote><ul><li>甲</li></ul></blockquote>',
  '<ul><li><blockquote>甲</blockquote></li></ul>',
  '<ul><li><p>甲</p><p>乙</p></li></ul>',
  '<ol start="0"><li>甲</li></ol>',
  '<ol reversed><li>甲</li></ol>',
  '<ol><li>甲</li><li value="5">乙</li></ol>',
  '<ul><li value="3">甲</li></ul>',
  '<ol start="9007199254740991"><li>甲</li><li>乙</li></ol>',
  '<p style="counter-reset:x">甲</p>',
  '<table><tr><td>甲</td></tr></table>',
  '<pre>甲</pre>',
])(
  'rich rejects entire paste including valid prefix before unsupported tail %s',
  async (html) => {
    await expect(
      richConvert('<p>valid prefix</p>' + html, 'safe fallback'),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
      message: 'UNSUPPORTED_STRUCTURE',
    });
  },
);
it('rich warnings identify visual normalization and unresolved CSS without dropping explicit marks', async () => {
  expect(
    await richConvert(
      '<style>.bold{font-weight:bold}</style><p class="bold" style="font-size:40px;color:red;text-align:center"><b>甲</b><a href="https://unused">乙</a></p>',
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: ['STYLE_NORMALIZED'],
    blocks: [paragraph(run('甲', ['bold']), run('乙'))],
  });
});
it('rich plain-only preserves whitespace, every blank paragraph and LF soft breaks', async () => {
  expect(await richConvert('', ' 甲\r\n乙 \r\n\r\n\r\n\r\n丙 ')).toEqual({
    version: 2,
    plainOnly: true,
    warnings: ['PLAIN_ONLY'],
    blocks: [paragraph(run(' 甲\n乙 ')), paragraph(), paragraph(run('丙 '))],
  });
});
it('rich shares inert CF_HTML, entity, input, tree and semantic budgets', async () => {
  expect((await richConvert(cfHtml('<p><b>甲&amp;😀</b></p>'))).blocks).toEqual(
    [paragraph(run('甲&😀', ['bold']))],
  );
  await expect(
    richConvert('<span>'.repeat(101) + '甲' + '</span>'.repeat(101)),
  ).rejects.toMatchObject({ code: 'PARSE_LIMIT' });
  await expect(
    richConvert('<p>甲</p>', 'x'.repeat(2097152)),
  ).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  await expect(
    richConvert('<p>' + '😀'.repeat(20001) + '</p>'),
  ).rejects.toMatchObject({ code: 'PARSE_LIMIT' });
  await expect(
    richConvert('<ul>' + '<li>x</li>'.repeat(1000) + '</ul>'),
  ).rejects.toMatchObject({ code: 'PARSE_LIMIT' });
  await expect(richConvert('<img>'.repeat(201))).rejects.toMatchObject({
    code: 'PARSE_LIMIT',
  });
  await expect(
    richConvert('<p>safe<img src="unfinished'),
  ).rejects.toMatchObject({ code: 'INVALID_FRAGMENT' });
});

it('rich keeps one paragraph across inline wrappers until the actual image boundary', async () => {
  expect(
    (await richConvert('<p>甲 <b>乙 <img src="x"> 丙</b> 丁</p>')).blocks,
  ).toEqual([
    paragraph(run('甲 '), run('乙', ['bold'])),
    { type: 'image', source: 'x' },
    paragraph(run('丙', ['bold']), run(' 丁')),
  ]);
});
it('rich supports inline whitespace between differently marked runs', async () => {
  expect(
    (await richConvert('<p>甲 <b>乙</b> 丙 <i>丁</i> 戊</p>')).blocks,
  ).toEqual([
    paragraph(
      run('甲 '),
      run('乙', ['bold']),
      run(' 丙 '),
      run('丁', ['italic']),
      run(' 戊'),
    ),
  ]);
});
it.each([
  '<ul><li>甲</li></p><h2>乙</h2></ul>',
  '<blockquote><p>甲</p></li><h2>乙</h2></blockquote>',
])(
  'rich rejects malformed closing attempts to conceal unsupported combinations %s',
  async (html) => {
    await expect(richConvert(html)).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
    });
  },
);

it.each([
  '<dl><dt>甲</dt><dd>乙</dd></dl>',
  '<hr>',
  '<div hidden><ul><li><img src="x"></li></ul></div>',
  '<ol><li style="counter-increment: n 2">甲</li></ol>',
])(
  'rich rejects unsupported hidden structure and generated numbering %s',
  async (html) => {
    await expect(richConvert('<p>prefix</p>' + html)).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
    });
  },
);
it('rich honors important declaration priority and warns about unsupported inline presentation', async () => {
  expect(
    await richConvert(
      '<p><b style="font-weight:normal!important;font-weight:bold">甲</b><sup>乙</sup></p>',
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: ['STYLE_NORMALIZED'],
    blocks: [paragraph(run('甲乙'))],
  });
});

it('rich keeps hidden quoted text inert and accepts empty visible quote paragraphs', async () => {
  expect(
    (
      await richConvert(
        '<blockquote><p hidden>secret</p><p>甲</p><p></p></blockquote>',
      )
    ).blocks,
  ).toEqual([
    { type: 'blockquote', paragraphs: [paragraph(run('甲')), paragraph()] },
  ]);
});
it('rich supports inherited list typography without leaking it to later blocks', async () => {
  expect(
    (
      await richConvert(
        '<ol start="2" style="font-weight:700"><li>甲</li><li><i>乙</i></li></ol><p>丙</p>',
      )
    ).blocks,
  ).toEqual([
    {
      type: 'list',
      kind: 'ordered',
      start: 2,
      items: [
        paragraph(run('甲', ['bold'])),
        paragraph(run('乙', ['bold', 'italic'])),
      ],
    },
    paragraph(run('丙')),
  ]);
});
it.each([1, 2, 3, 4, 5, 6])(
  'rich unifies h%s into the one heading kind',
  async (level) => {
    expect((await richConvert(`<h${level}>甲</h${level}>`)).blocks).toEqual([
      { type: 'heading', content: [run('甲')] },
    ]);
  },
);

it.each([
  '<ol><li value="3">甲</li><li>乙</li></ol>',
  '<ol start="10"><li value="3">甲</li><li value="4">乙</li></ol>',
])(
  'rich preserves actual continuous numbering when first li overrides start: %s',
  async (html) => {
    expect((await richConvert(html)).blocks).toEqual([
      {
        type: 'list',
        kind: 'ordered',
        start: 3,
        items: [paragraph(run('甲')), paragraph(run('乙'))],
      },
    ]);
  },
);
it.each([
  '<ol start="10"><li value="3">甲</li><li value="5">乙</li></ol>',
  '<ol><li value="0">甲</li></ol>',
  '<ol><li value="9007199254740991">甲</li><li>乙</li></ol>',
])(
  'rich rejects jumps, nonpositive or overflow after a first-item start override %s',
  async (html) => {
    await expect(richConvert(html)).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
    });
  },
);

it('rich format fixture retains exact structure and image source without V1 flattening', async () => {
  expect(
    await richConvert(
      readFileSync('tests/fixtures/web-paste/rich-format.html', 'utf8'),
    ),
  ).toEqual({
    version: 2,
    plainOnly: false,
    warnings: ['HEADING_NORMALIZED'],
    blocks: [
      { type: 'heading', content: [run('标题')] },
      paragraph(
        run('甲'),
        run('乙', ['bold']),
        run('丙', ['italic', 'underline']),
        run('\n丁'),
      ),
      {
        type: 'list',
        kind: 'ordered',
        start: 3,
        items: [paragraph(run('一')), paragraph(run('二'))],
      },
      { type: 'blockquote', paragraphs: [paragraph(run('引用')), paragraph()] },
      { type: 'image', source: 'relative.png' },
      paragraph(run('尾')),
    ],
  });
});

it.each([
  '<ul style="list-style-position:inside;list-style-type:square"><li>甲</li></ul>',
  '<ul type="circle"><li>甲</li></ul>',
])(
  'rich normalizes visual bullet shape and indentation without rejecting a flat list: %s',
  async (html) => {
    expect(await richConvert(html)).toEqual({
      version: 2,
      plainOnly: false,
      warnings: ['STYLE_NORMALIZED'],
      blocks: [{ type: 'list', kind: 'bullet', items: [paragraph(run('甲'))] }],
    });
  },
);

it.each([
  '<ol type="a" start="3"><li>甲</li><li>乙</li></ol>',
  '<ol type="i" start="3"><li>甲</li><li>乙</li></ol>',
  '<ol style="list-style-type:lower-roman" start="3"><li>甲</li><li>乙</li></ol>',
])(
  'rich normalizes visual letter or roman numbering while retaining ordered structure/start: %s',
  async (html) => {
    expect(await richConvert(html)).toEqual({
      version: 2,
      plainOnly: false,
      warnings: ['STYLE_NORMALIZED'],
      blocks: [
        {
          type: 'list',
          kind: 'ordered',
          start: 3,
          items: [paragraph(run('甲')), paragraph(run('乙'))],
        },
      ],
    });
  },
);

it.each([
  '<address>A</address><address>B</address>',
  '<p>valid prefix</p><address>A</address><address>B</address>',
])(
  'rich rejects unsupported address block boundaries for the entire paste: %s',
  async (html) => {
    await expect(richConvert(html, 'safe fallback')).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
      message: 'UNSUPPORTED_STRUCTURE',
    });
  },
);
it.each([
  '<p>prefix</p><div hidden><ol reversed><li>A</li></ol></div>',
  '<p>prefix</p><div hidden><ol><li>A</li><li value="5">B</li></ol></div>',
])(
  'rich validates forbidden numbering inside hidden source tails: %s',
  async (html) => {
    await expect(richConvert(html, 'safe fallback')).rejects.toMatchObject({
      code: 'UNSUPPORTED_STRUCTURE',
      message: 'UNSUPPORTED_STRUCTURE',
    });
  },
);

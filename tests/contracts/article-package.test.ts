import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateArticlePackage } from '../../src/contracts/article-package';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(`tests/fixtures/article-packages/${name}.json`, 'utf8'),
  );
const base = () => fixture('minimal');
function failure(input: unknown, code: string) {
  const result = validateArticlePackage(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected failure');
  expect(result.issues.map((issue) => issue.code)).toContain(code);
  expect(result).not.toHaveProperty('article');
  return result.issues;
}
function imageSource(source: unknown) {
  const input = fixture('mixed');
  input.images[0].source = source;
  return input;
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}

describe('ArticlePackageV1 contract', () => {
  it('normalizes title and default declaration without changing paragraph whitespace', () => {
    expect(validateArticlePackage(base())).toEqual({
      ok: true,
      article: {
        schema_version: 1,
        article_id: 'a',
        title: '标题',
        body: [{ type: 'paragraph', text: ' 正文\n' }],
        images: [],
        content_declaration: 'repost',
      },
      warnings: [],
    });
  });
  it('preserves mixed order and repeated image positions', () => {
    const result = validateArticlePackage(fixture('mixed'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected success');
    expect(result.article.body).toEqual([
      { type: 'paragraph', text: '早高峰从城区出发。' },
      { type: 'image', image_id: 'front' },
      { type: 'paragraph', text: '结束后记录了这次体验。' },
      { type: 'image', image_id: 'front' },
    ]);
    expect(result.article.images).toEqual([
      {
        image_id: 'front',
        source: { type: 'local', path: 'images/front.jpg' },
      },
    ]);
  });
  it('preserves explicit original', () => {
    const r = validateArticlePackage(fixture('original'));
    expect(r.ok && r.article.content_declaration).toBe('original');
  });
  it.each([null, 'auto', 1])(
    'rejects invalid declaration %j',
    (value) =>
      void failure(
        { ...base(), content_declaration: value },
        'INVALID_STRUCTURE',
      ),
  );
  it.each([null, [], 1, 'x'].map((value) => ({ value })))(
    'rejects non-object root %j',
    ({ value }) => expect(failure(value, 'INVALID_STRUCTURE')).toHaveLength(1),
  );
  it.each([undefined, '1', 0, 2, null])(
    'rejects unsupported version %j before other errors',
    (value) =>
      expect(
        failure({ schema_version: value }, 'UNSUPPORTED_VERSION'),
      ).toHaveLength(1),
  );
  it('keeps future-version fixture rejected', () =>
    void failure(fixture('future-version'), 'UNSUPPORTED_VERSION'));
  it.each([undefined, '', ' \n\t'])(
    'rejects missing/empty title %j',
    (title) => void failure({ ...base(), title }, 'MISSING_TITLE'),
  );
  it('rejects wrong title type', () =>
    void failure({ ...base(), title: 1 }, 'INVALID_STRUCTURE'));
  it.each(
    [
      [],
      [{ type: 'paragraph', text: ' \n' }],
      [{ type: 'image', image_id: 'x' }],
    ].map((body) => ({ body })),
  )(
    'requires a nonblank paragraph %j',
    ({ body }) => void failure({ ...base(), body }, 'EMPTY_BODY'),
  );
  it.each(['heading', 'video', 'html'])(
    'rejects unsupported block %s',
    (type) =>
      void failure(
        { ...base(), body: [{ type, text: 'body' }] },
        'INVALID_STRUCTURE',
      ),
  );
  it('does not interpret markup', () => {
    const r = validateArticlePackage({
      ...base(),
      body: [{ type: 'paragraph', text: '<script>alert(1)</script> **text**' }],
    });
    expect(r.ok && r.article.body[0]).toEqual({
      type: 'paragraph',
      text: '<script>alert(1)</script> **text**',
    });
  });
  it.each([undefined, '', '../x', 'a/b', '文章', 'a b'])(
    'rejects identifiers %j',
    (article_id) =>
      void failure({ ...base(), article_id }, 'INVALID_IDENTIFIER'),
  );
  it('reports missing image at its body index', () =>
    expect(failure(fixture('missing-image'), 'MISSING_IMAGE')[0].path).toEqual([
      'body',
      1,
      'image_id',
    ]));
  it('reports duplicate images', () => {
    const a = fixture('mixed');
    a.images.push({ ...a.images[0] });
    failure(a, 'DUPLICATE_IMAGE');
  });
  it('rejects unreferenced images', () => {
    const a = fixture('mixed');
    a.body = base().body;
    failure(a, 'UNUSED_IMAGE');
  });
  it('does not perform association checks on malformed structure', () => {
    const a = fixture('missing-image');
    a.title = 0;
    expect(failure(a, 'INVALID_STRUCTURE').map((i) => i.code)).not.toContain(
      'MISSING_IMAGE',
    );
  });
  it.each([
    '../x',
    '/x',
    'a\\b',
    'a//b',
    'a/./b',
    'a/../b',
    'C:/x',
    'a%2fb',
    'a:b',
    'a?b',
    'a*b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    'a\0b',
    'a\u007fb',
    'a.',
    'a ',
    'CON',
    'con.jpg',
    'prn/a',
    'AUX.png',
    'NUL',
    'COM1.jpg',
    'LPT9',
    'COM¹.png',
    'LPT².jpg',
    'COM³',
    '',
  ])(
    'rejects unsafe local path %j',
    (path) =>
      void failure(
        imageSource({ type: 'local', path }),
        'INVALID_IMAGE_SOURCE',
      ),
  );
  it.each(['images/汽车.jpg', 'COM10.jpg', 'a/front.png', '素材/😀.jpg'])(
    'accepts lexical local path %s without file access',
    (path) =>
      expect(
        validateArticlePackage(imageSource({ type: 'local', path })).ok,
      ).toBe(true),
  );
  it.each([
    'file:///x',
    'data:image/png,x',
    'ftp://example.invalid/a',
    'https://user:pw@example.invalid/x',
    'https://user@example.invalid/x',
    'https://example.invalid/x#frag',
    'https://example.invalid/x#',
    '/relative',
    'https:example.invalid',
    ' https://example.invalid/x',
    'https://example.invalid/\nx',
    'https://example.invalid/a\u0000b',
    'https://example.invalid/a\u0001b',
    'https://example.invalid/a\u001fb',
    'https://example.invalid/a\u007fb',
    'https://example.invalid/a\u0000',
    'https://example.invalid/a\u007f',
    'https:\\example.invalid/a',
  ])(
    'rejects unsafe/malformed URL %j',
    (url) =>
      void failure(
        imageSource({ type: 'remote', url }),
        'INVALID_IMAGE_SOURCE',
      ),
  );
  it.each([
    'https://example.invalid/a?sig=a%2Fb&z=1',
    'http://example.invalid/x',
    'https://example.invalid/a%00b?sig=a%2Fb&z=1',
  ])('preserves valid URL %s without fetching', (url) => {
    const r = validateArticlePackage(imageSource({ type: 'remote', url }));
    expect(r.ok && r.article.images[0].source).toEqual({ type: 'remote', url });
  });
  it('rejects unsupported source type', () =>
    void failure(
      imageSource({ type: 'inline', data: 'secret' }),
      'INVALID_IMAGE_SOURCE',
    ));
  it('ignores known metadata once and does not expose it', () => {
    const r = validateArticlePackage(fixture('metadata'));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('Expected success');
    expect(r.warnings).toEqual([
      {
        code: 'SOURCE_METADATA_IGNORED',
        message: '当前版本只处理文章正文和图片，附带的来源信息未保留。',
      },
    ]);
    expect(Object.keys(r.article)).toEqual([
      'schema_version',
      'article_id',
      'title',
      'body',
      'images',
      'content_declaration',
    ]);
    expect(JSON.stringify(r)).not.toContain('do-not-return');
    expect(validateArticlePackage(r.article)).toEqual({ ...r, warnings: [] });
  });
  it.each([
    'source_type',
    'source_platform',
    'source_account',
    'source_url',
    'original_publish_time',
    'publication_history',
    'rights_status',
  ])('allows known metadata key %s', (key) => {
    const r = validateArticlePackage({ ...base(), [key]: null });
    expect(r.ok && r.warnings.length).toBe(1);
  });
  it('rejects unknown keys without echoing their names or values', () => {
    const issues = failure(
      { ...base(), 'C:/secret/token': 'password' },
      'INVALID_STRUCTURE',
    );
    expect(JSON.stringify(issues)).not.toMatch(/secret|token|password/);
    expect(issues[0].path).toEqual([]);
  });
  it('rejects unknown nested fields', () =>
    void failure(
      { ...base(), body: [{ type: 'paragraph', text: 'x', secret: 'x' }] },
      'INVALID_STRUCTURE',
    ));
  it('does not modify frozen inputs', () => {
    const a = fixture('mixed');
    const before = JSON.stringify(a);
    freeze(a);
    const r = validateArticlePackage(a);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(a)).toBe(before);
    if (r.ok) expect(validateArticlePackage(r.article)).toEqual(r);
  });
  it('keeps deterministic error order and limits output', () => {
    const a = {
      ...base(),
      body: Array.from({ length: 100 }, () => ({
        type: 'paragraph',
        text: '',
      })),
    };
    const first = failure(a, 'EMPTY_BODY');
    expect(first).toHaveLength(50);
    expect(first[0].path).toEqual(['body', 0, 'text']);
    expect(first[49].path).toEqual(['body', 49, 'text']);
    expect(validateArticlePackage(a)).toEqual({ ok: false, issues: first });
  });
  it.each([
    ['title', 512, (n: number) => ({ ...base(), title: '😀'.repeat(n) })],
    [
      'identifier',
      128,
      (n: number) => ({ ...base(), article_id: 'a'.repeat(n) }),
    ],
    [
      'paragraph',
      20000,
      (n: number) => ({
        ...base(),
        body: [{ type: 'paragraph', text: '😀'.repeat(n) }],
      }),
    ],
    [
      'body',
      1000,
      (n: number) => ({
        ...base(),
        body: Array.from({ length: n }, () => ({
          type: 'paragraph',
          text: 'x',
        })),
      }),
    ],
    [
      'path',
      240,
      (n: number) => imageSource({ type: 'local', path: 'a'.repeat(n) }),
    ],
    [
      'url',
      2048,
      (n: number) =>
        imageSource({
          type: 'remote',
          url: 'https://example.invalid/' + 'a'.repeat(n - 24),
        }),
    ],
    [
      'images',
      200,
      (n: number) => ({
        ...base(),
        body: [
          ...base().body,
          ...Array.from({ length: n }, (_, i) => ({
            type: 'image',
            image_id: `i${i}`,
          })),
        ],
        images: Array.from({ length: n }, (_, i) => ({
          image_id: `i${i}`,
          source: { type: 'local', path: `${i}.jpg` },
        })),
      }),
    ],
  ] as const)('honors %s limit %i', (_name, limit, build) => {
    expect(validateArticlePackage(build(limit)).ok).toBe(true);
    failure(build(limit + 1), 'INPUT_LIMIT_EXCEEDED');
  });
  it('counts total paragraph budget and rejects overage before association', () => {
    const a = {
      ...base(),
      body: Array.from({ length: 10 }, () => ({
        type: 'paragraph',
        text: '😀'.repeat(20000),
      })),
    };
    expect(validateArticlePackage(a).ok).toBe(true);
    a.body.push({ type: 'paragraph', text: 'x' });
    failure(a, 'INPUT_LIMIT_EXCEEDED');
  });
});

import { z } from 'zod';
import {
  ignoredMetadataWarning,
  mapIssues,
  type ArticleIssue,
  type ArticleIssueCode,
  type ArticleWarning,
} from './article-package-errors';
function issue(code: ArticleIssueCode, path: (string | number)[] = []) {
  return {
    code: 'custom' as const,
    params: { contractCode: code },
    message: code,
    path,
  };
}
// Count code points only as far as the caller's budget requires.
function pointCount(text: string, limit: number): number {
  let count = 0;
  const points = text[Symbol.iterator]();
  while (!points.next().done) {
    if (++count > limit) break;
  }
  return count;
}
function boundedText(limit: number) {
  return z.string().superRefine((text, ctx) => {
    if (pointCount(text, limit) > limit)
      ctx.addIssue(issue('INPUT_LIMIT_EXCEEDED'));
  });
}
function boundedArray<T extends z.ZodType>(element: T, limit: number) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (Array.isArray(value) && value.length > limit)
        ctx.addIssue(issue('INPUT_LIMIT_EXCEEDED'));
    })
    .pipe(z.array(element));
}
export const IdentifierSchema = boundedText(128).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
  { params: { contractCode: 'INVALID_IDENTIFIER' } },
);
export const TitleSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === undefined) ctx.addIssue(issue('MISSING_TITLE'));
  })
  .pipe(
    z
      .string()
      .trim()
      .pipe(boundedText(512))
      .refine((value) => value.length > 0, {
        params: { contractCode: 'MISSING_TITLE' },
      }),
  );
const ParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  text: boundedText(20000).refine((value) => value.trim().length > 0, {
    params: { contractCode: 'EMPTY_BODY' },
  }),
});
const ImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  image_id: IdentifierSchema,
});
const BlockSchema = z.discriminatedUnion('type', [
  ParagraphSchema,
  ImageBlockSchema,
]);
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function isLocalReference(path: string): boolean {
  if (!path || /[\\:%<>"|?*]/.test(path) || hasControlCharacters(path))
    return false;
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/[ .]$/.test(segment) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment),
    );
}
function isRemoteReference(value: string): boolean {
  if (
    !/^https?:\/\//i.test(value) ||
    /[\s\\#]/u.test(value) ||
    hasControlCharacters(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
const SourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('local'),
    path: boundedText(240).refine(isLocalReference, {
      params: { contractCode: 'INVALID_IMAGE_SOURCE' },
    }),
  }),
  z.strictObject({
    type: z.literal('remote'),
    url: boundedText(2048).refine(isRemoteReference, {
      params: { contractCode: 'INVALID_IMAGE_SOURCE' },
    }),
  }),
]);
const coreShape = {
  schema_version: z.literal(1),
  article_id: IdentifierSchema,
  title: TitleSchema,
  body: boundedArray(BlockSchema, 1000).refine(
    (body) => body.some((block) => block.type === 'paragraph'),
    { params: { contractCode: 'EMPTY_BODY' } },
  ),
  images: boundedArray(
    z.strictObject({ image_id: IdentifierSchema, source: SourceSchema }),
    200,
  ),
  content_declaration: z.enum(['original', 'repost']).default('repost'),
};
const metadataKeys = [
  'source_type',
  'source_platform',
  'source_account',
  'source_url',
  'original_publish_time',
  'publication_history',
  'rights_status',
] as const;
const InputSchema = z.strictObject({
  ...coreShape,
  source_type: z.unknown().optional(),
  source_platform: z.unknown().optional(),
  source_account: z.unknown().optional(),
  source_url: z.unknown().optional(),
  original_publish_time: z.unknown().optional(),
  publication_history: z.unknown().optional(),
  rights_status: z.unknown().optional(),
});
export type ArticlePackageV1 = Pick<
  z.output<typeof InputSchema>,
  keyof typeof coreShape
>;
export type ArticlePackageValidationResult =
  | { ok: true; article: ArticlePackageV1; warnings: ArticleWarning[] }
  | { ok: false; issues: ArticleIssue[] };
const PackageSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      ctx.addIssue(issue('INVALID_STRUCTURE'));
    else if (!('schema_version' in value) || value.schema_version !== 1)
      ctx.addIssue(issue('UNSUPPORTED_VERSION', ['schema_version']));
  })
  .pipe(InputSchema)
  .transform((value, ctx) => {
    let total = 0;
    for (const block of value.body) {
      if (block.type === 'paragraph')
        total += pointCount(block.text, 200000 - total);
      if (total > 200000) {
        ctx.addIssue(issue('INPUT_LIMIT_EXCEEDED', ['body']));
        return z.NEVER;
      }
    }
    const references = new Set(
      value.body.flatMap((block) =>
        block.type === 'image' ? [block.image_id] : [],
      ),
    );
    const seen = new Set<string>();
    value.images.forEach((image, index) => {
      if (seen.has(image.image_id))
        ctx.addIssue(issue('DUPLICATE_IMAGE', ['images', index, 'image_id']));
      seen.add(image.image_id);
      if (!references.has(image.image_id))
        ctx.addIssue(issue('UNUSED_IMAGE', ['images', index, 'image_id']));
    });
    value.body.forEach((block, index) => {
      if (block.type === 'image' && !seen.has(block.image_id))
        ctx.addIssue(issue('MISSING_IMAGE', ['body', index, 'image_id']));
    });
    const article: ArticlePackageV1 = {
      schema_version: value.schema_version,
      article_id: value.article_id,
      title: value.title,
      body: value.body,
      images: value.images,
      content_declaration: value.content_declaration,
    };
    return {
      article,
      warnings: metadataKeys.some((key) => Object.hasOwn(value, key))
        ? [{ ...ignoredMetadataWarning }]
        : [],
    };
  });
export function validateArticlePackage(
  input: unknown,
): ArticlePackageValidationResult {
  const parsed = PackageSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, issues: mapIssues(parsed.error.issues) };
  return { ok: true, ...parsed.data };
}

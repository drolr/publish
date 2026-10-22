import { z } from 'zod';
import { IdentifierSchema, TitleSchema } from './article-package';
import { StorageIdSchema } from './stored-article';

const DeclarationSchema = z.enum(['original', 'repost']);
export const DeclarationKeysSchema = z
  .array(StorageIdSchema)
  .min(1)
  .max(100)
  .refine((keys) => new Set(keys).size === keys.length);
export const DeclarationItemSchema = z.strictObject({
  articleKey: StorageIdSchema,
  title: z.string().refine((value) => {
    const parsed = TitleSchema.safeParse(value);
    return parsed.success && parsed.data === value;
  }),
  externalId: IdentifierSchema,
  contentDeclaration: DeclarationSchema,
});
export type DeclarationItem = z.infer<typeof DeclarationItemSchema>;
const DeclarationItemsSchema = z
  .array(DeclarationItemSchema)
  .min(1)
  .max(100)
  .refine(
    (items) =>
      new Set(items.map((item) => item.articleKey)).size === items.length,
  );
export const DeclarationChangeSchema = z.strictObject({
  targets: z
    .array(
      z.strictObject({
        articleKey: StorageIdSchema,
        expectedDeclaration: DeclarationSchema,
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (targets) =>
        new Set(targets.map((target) => target.articleKey)).size ===
        targets.length,
    ),
  declaration: DeclarationSchema,
});
export type DeclarationChange = z.infer<typeof DeclarationChangeSchema>;
export const DeclarationReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), items: DeclarationItemsSchema }),
  z.strictObject({
    status: z.literal('not_found'),
    articleKeys: DeclarationKeysSchema,
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type DeclarationReadResult = z.infer<typeof DeclarationReadResultSchema>;
export const DeclarationWriteResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('updated'),
      items: DeclarationItemsSchema,
      changedCount: z.number().int().min(0).max(100),
      unchangedCount: z.number().int().min(0).max(100),
    }),
    z.strictObject({
      status: z.enum(['conflict', 'not_found']),
      articleKeys: DeclarationKeysSchema,
    }),
    z.strictObject({ status: z.enum(['busy', 'unavailable']) }),
  ])
  .refine(
    (result) =>
      result.status !== 'updated' ||
      result.changedCount + result.unchangedCount === result.items.length,
  );
export type DeclarationWriteResult = z.infer<
  typeof DeclarationWriteResultSchema
>;
export interface ArticleDeclarationApi {
  getArticleDeclarations(articleKeys: string[]): Promise<DeclarationReadResult>;
  setArticleDeclarations(
    change: DeclarationChange,
  ): Promise<DeclarationWriteResult>;
}

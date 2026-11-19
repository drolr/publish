import type {
  PersistedEditorBody,
  PersistedEditorBodyV2,
  RichInline,
} from '../contracts/rich-text-body';
import {
  PersistedEditorBodySchema,
  PersistedEditorBodyV2Schema,
} from '../contracts/rich-text-body';
import type { StoredArticle } from '../contracts/stored-article';

export function normalizeRichBody(
  body: PersistedEditorBodyV2,
): PersistedEditorBodyV2 {
  return PersistedEditorBodyV2Schema.parse(body);
}
export function richPlainText(content: RichInline[]): string {
  return content.map((run) => run.text).join('');
}
export function upgradeEditorBody(
  body: PersistedEditorBody | null,
  legacy: StoredArticle['body'],
): PersistedEditorBodyV2 {
  const source =
    body === null
      ? PersistedEditorBodySchema.parse({
          version: 1,
          blocks: legacy.map((block) =>
            block.type === 'image'
              ? { type: 'image', imageId: block.image_id }
              : { ...block },
          ),
        })
      : PersistedEditorBodySchema.parse(body);
  if (source.version === 2) return source;
  return normalizeRichBody({
    version: 2,
    blocks: source.blocks.map((block) =>
      block.type === 'image'
        ? { ...block }
        : {
            type: 'paragraph',
            content: block.text.length
              ? [{ type: 'text', text: block.text, marks: [] }]
              : [],
          },
    ),
  });
}
// Compatibility projection only; rich previews and platform snapshots use V2.
export function projectRichBody(
  body: PersistedEditorBodyV2,
): StoredArticle['body'] {
  return normalizeRichBody(body).blocks.flatMap(
    (block): StoredArticle['body'] => {
      if (block.type === 'image')
        return [{ type: 'image', image_id: block.imageId }];
      const paragraphs =
        block.type === 'list'
          ? block.items
          : block.type === 'blockquote'
            ? block.paragraphs
            : [block];
      return paragraphs.flatMap((paragraph) => {
        const text = richPlainText(paragraph.content);
        return text.trim().length ? [{ type: 'paragraph' as const, text }] : [];
      });
    },
  );
}
export function richBodyEquals(
  a: PersistedEditorBodyV2,
  b: PersistedEditorBodyV2,
): boolean {
  return (
    JSON.stringify(normalizeRichBody(a)) ===
    JSON.stringify(normalizeRichBody(b))
  );
}

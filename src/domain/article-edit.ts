import type { PersistedEditorBody } from '../contracts/rich-text-body';
import { projectRichBody } from './rich-text-body';
import type { PersistedEditorBodyV1 } from '../contracts/manual-edit';
import { PersistedEditorBodyV1Schema } from '../contracts/manual-edit';
import type { StoredArticle } from '../contracts/stored-article';
export function normalizeEditorBody(
  body: PersistedEditorBodyV1,
): PersistedEditorBodyV1 {
  return PersistedEditorBodyV1Schema.parse(body);
}
export function projectEditorBody(
  body: PersistedEditorBody,
): StoredArticle['body'] {
  if (body.version === 2) return projectRichBody(body);
  return normalizeEditorBody(body).blocks.flatMap(
    (block): StoredArticle['body'] =>
      block.type === 'image'
        ? [{ type: 'image', image_id: block.imageId }]
        : block.text.trim().length
          ? [{ type: 'paragraph', text: block.text }]
          : [],
  );
}
export function deriveEditorBody(
  body: StoredArticle['body'],
): PersistedEditorBodyV1 {
  return normalizeEditorBody({
    version: 1,
    blocks: body.map((b) =>
      b.type === 'image' ? { type: 'image', imageId: b.image_id } : { ...b },
    ),
  });
}
export function editorProjectionMatches(
  article: StoredArticle,
  body: PersistedEditorBody,
): boolean {
  return (
    JSON.stringify(projectEditorBody(body)) === JSON.stringify(article.body)
  );
}

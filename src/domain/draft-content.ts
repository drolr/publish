import {
  FormatFeatureSchema,
  type DraftContentCapabilities,
  type ContentSupport,
  type FormatFeature,
} from '../contracts/draft-content';
import type { PersistedEditorBodyV2 } from '../contracts/rich-text-body';
import type { DraftSnapshot } from '../contracts/draft-task';
import { StoredArticleSchema } from '../contracts/stored-article';
import {
  normalizeRichBody,
  upgradeEditorBody,
  richBodyEquals,
} from './rich-text-body';
export function checkContentSupport(
  body: PersistedEditorBodyV2,
  capabilities: DraftContentCapabilities,
): ContentSupport {
  const used = new Set<FormatFeature>();
  for (const block of normalizeRichBody(body).blocks) {
    if (block.type === 'image') continue;
    if (block.type === 'heading') used.add('heading');
    if (block.type === 'list')
      used.add(block.kind === 'ordered' ? 'ordered_list' : 'bullet_list');
    if (block.type === 'blockquote') used.add('blockquote');
    const leaves =
      block.type === 'list'
        ? block.items
        : block.type === 'blockquote'
          ? block.paragraphs
          : [block];
    for (const leaf of leaves)
      for (const run of leaf.content)
        for (const mark of run.marks) used.add(mark);
  }
  const missing = FormatFeatureSchema.options.filter(
    (feature) =>
      used.has(feature) && capabilities.features[feature] !== 'verified',
  );
  return missing.length ? { ok: false, missing } : { ok: true };
}
function articleIdentity(snapshot: DraftSnapshot): string {
  const article = StoredArticleSchema.parse(snapshot.article);
  return JSON.stringify({
    ...article,
    assets: [...article.assets].sort((a, b) =>
      a.assetKey.localeCompare(b.assetKey),
    ),
  });
}
/** Compare only after immutable snapshot integrity has been verified by the caller. */
export function submissionContentEquivalent(
  previous: DraftSnapshot,
  next: DraftSnapshot,
): 'equal' | 'different' | 'unknown' {
  if (articleIdentity(previous) !== articleIdentity(next)) return 'different';
  if (previous.version === 1 && next.version === 1) return 'equal';
  if (previous.version === 2 && next.version === 2)
    return richBodyEquals(previous.editorBody, next.editorBody)
      ? 'equal'
      : 'different';
  const rich =
    previous.version === 2 ? previous : next.version === 2 ? next : undefined;
  const legacy =
    previous.version === 1 ? previous : next.version === 1 ? next : undefined;
  if (!rich || !legacy) return 'unknown';
  if (
    !checkContentSupport(rich.editorBody, {
      revision: 'legacy-plain',
      features: {},
    }).ok
  )
    return 'different';
  return richBodyEquals(
    rich.editorBody,
    upgradeEditorBody(null, legacy.article.body),
  )
    ? 'equal'
    : 'unknown';
}

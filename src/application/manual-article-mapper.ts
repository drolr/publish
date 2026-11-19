import type { ArticlePackageV1 } from '../contracts/article-package';
import {
  ManualDraftSchema,
  type ManualState,
} from '../contracts/manual-article';
import { ImportFailure } from '../domain/import-error';
import type { SaveCommand } from '../contracts/manual-edit';
import type {
  EditableArticle,
  RevisionImageSource,
  RevisionSaveInput,
  EditorCompatibilityLease,
} from '../contracts/article-revision';
import { WebPasteFailure } from '../domain/web-paste-error';
import { requireLegacyManualDraft } from '../domain/manual-draft-version';
import { PersistedEditorBodyV2Schema } from '../contracts/rich-text-body';
import { upgradeEditorBody } from '../domain/rich-text-body';
import type { StoredArticle } from '../contracts/stored-article';
export type ManualSession = Extract<ManualState, { sessionId: string }>;

/** Loaded readonly projection; authorization/reads and session ownership stay in the controller. */
export function manualSessionFromEditable(
  editable: EditableArticle,
  revision: number,
  newId: () => string,
): {
  session: ManualSession;
  imageIds: ReadonlyMap<string, string>;
  assets: StoredArticle['assets'];
} {
  const layout = upgradeEditorBody(editable.editorBody, editable.article.body);
  const referenced = new Set(
    layout.blocks.flatMap((b) => (b.type === 'image' ? [b.imageId] : [])),
  );
  const assets = editable.article.assets.filter((a) =>
    referenced.has(a.imageId),
  );
  if (assets.length !== referenced.size)
    throw new WebPasteFailure('RECOVERY_REQUIRED');
  const imageIds = new Map(assets.map((a) => [a.imageId, newId()]));
  return {
    assets,
    imageIds,
    session: {
      state: 'selecting',
      revision,
      sessionId: newId(),
      externalId: editable.article.externalId,
      target: {
        kind: 'existing',
        articleKey: editable.article.articleKey,
        externalId: editable.article.externalId,
        importId: editable.article.importId,
        baseArticleRevision: editable.articleRevision,
      },
      documentRevision: 0,
      acknowledgedEdit: null,
      nextEditCommandId: newId(),
      nextClientSequence: 1,
      nextSaveOperationId: newId(),
      nextPasteCommandId: newId(),
      draft: ManualDraftSchema.parse({
        bodyVersion: 2,
        title: editable.article.title,
        contentDeclaration: editable.article.contentDeclaration,
        blocks: layout.blocks.map((b) => {
          const blockKey = newId();
          if (b.type === 'image')
            return {
              type: 'image',
              blockKey,
              imageToken: imageIds.get(b.imageId)!,
            };
          if (b.type === 'list')
            return {
              ...b,
              blockKey,
              items: b.items.map((p) => ({ ...p, blockKey: newId() })),
            };
          if (b.type === 'blockquote')
            return {
              ...b,
              blockKey,
              paragraphs: b.paragraphs.map((p) => ({
                ...p,
                blockKey: newId(),
              })),
            };
          return { ...b, blockKey };
        }),
      }),
      images: assets.map((a) => ({
        imageToken: imageIds.get(a.imageId)!,
        mime: a.mime,
        width: a.width,
        height: a.height,
        byteSize: a.byteSize,
      })),
      candidates: [],
      dirty: false,
    },
  };
}

/** Pure projection of main-confirmed content and trusted registry bindings. */
export function manualRevisionInput(
  session: ManualSession,
  command: SaveCommand,
  sources: ReadonlyMap<string, RevisionImageSource>,
  editable: EditableArticle | undefined,
  digest: (value: unknown) => string,
  startedAt: string,
  compatibilityLease?: EditorCompatibilityLease,
): RevisionSaveInput {
  const tokens = [
    ...new Set(
      session.draft.blocks.flatMap((b) =>
        b.type === 'image' ? [b.imageToken] : [],
      ),
    ),
  ];
  const images = tokens.map((token): RevisionImageSource => {
    if (!session.images.some((i) => i.imageToken === token))
      throw new WebPasteFailure('INPUT_LIMIT');
    return (
      sources.get(token) ?? {
        kind: 'temporary',
        imageId: token,
        sessionId: session.sessionId,
        imageToken: token,
      }
    );
  });
  const byToken = new Map(tokens.map((token, n) => [token, images[n]]));
  const draft = ManualDraftSchema.parse(session.draft);
  const editorBody = PersistedEditorBodyV2Schema.parse({
    version: 2,
    blocks: draft.blocks.map((b) => {
      if (b.type === 'image')
        return { type: 'image', imageId: byToken.get(b.imageToken)!.imageId };
      if (b.type === 'image-pending') throw new WebPasteFailure('INPUT_LIMIT');
      const leaf = (p: { content: unknown }) => ({
        type: 'paragraph',
        content: p.content,
      });
      if (b.type === 'list')
        return {
          type: b.type,
          kind: b.kind,
          ...('start' in b ? { start: b.start } : {}),
          items: b.items.map(leaf),
        };
      if (b.type === 'blockquote')
        return { type: b.type, paragraphs: b.paragraphs.map(leaf) };
      return { type: b.type, content: b.content };
    }),
  });
  const content = {
    title: session.draft.title,
    contentDeclaration: session.draft.contentDeclaration,
    editorBody,
    images,
  };
  const payloadDigest = digest({
    externalId: session.externalId,
    target: session.target,
    ...content,
    images: images.map((i) => ({ kind: i.kind, imageId: i.imageId })),
  });
  const common = {
    operationId: command.operationId,
    sessionId: session.sessionId,
    documentRevision: session.documentRevision,
    payloadDigest,
  };
  if (session.target.kind === 'new')
    return {
      kind: 'created',
      command: common,
      externalId: session.externalId,
      ...content,
    };
  if (
    !editable ||
    editable.articleRevision !== session.target.baseArticleRevision
  )
    throw new WebPasteFailure('RECOVERY_REQUIRED');
  const { articleKey, externalId, importId, createdAt } = editable.article;
  if (
    articleKey !== session.target.articleKey ||
    externalId !== session.target.externalId ||
    importId !== session.target.importId
  )
    throw new WebPasteFailure('RECOVERY_REQUIRED');
  return {
    kind: 'updated',
    intent: {
      ...common,
      articleKey,
      externalId,
      kind: 'updated',
      baseRevision: session.target.baseArticleRevision,
      startedAt,
    },
    identity: { articleKey, externalId, importId, createdAt },
    ...(compatibilityLease ? { compatibilityLease } : {}),
    ...content,
  };
}

/** Formal v1 input references only source-issued local capabilities. */
export function manualArticleInput(session: ManualSession): ArticlePackageV1 {
  // No-documents fallback is deliberately lossless-only.
  const draft = requireLegacyManualDraft(session.draft);
  const tokens = [
    ...new Set(
      draft.blocks.flatMap((block) =>
        block.type === 'image' ? [block.imageToken] : [],
      ),
    ),
  ];
  return {
    schema_version: 1,
    article_id: session.externalId,
    title: session.draft.title,
    content_declaration: session.draft.contentDeclaration,
    body: draft.blocks.map((block) => {
      if (block.type === 'paragraph')
        return { type: 'paragraph' as const, text: block.text };
      if (
        block.type === 'image' &&
        session.images.some((image) => image.imageToken === block.imageToken)
      )
        return { type: 'image' as const, image_id: block.imageToken };
      throw new ImportFailure('RECOVERY_REQUIRED');
    }),
    images: tokens.map((token) => ({
      image_id: token,
      source: { type: 'local', path: `${token}.image` },
    })),
  };
}

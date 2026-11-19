import type { ArticleDeletionRepository } from './article-delete';
import type { SaveReceipt } from '../../contracts/article-revision';
import type { PersistedEditorBody } from '../../contracts/rich-text-body';
import type { ArticlePackageV1 } from '../../contracts/article-package';
import type { ManualImageCapability } from './manual-images';
import type {
  DeclarationChange,
  DeclarationReadResult,
  DeclarationWriteResult,
} from '../../contracts/article-declaration';
import type {
  ArticleCursor,
  ListResult,
} from '../../contracts/article-library';
import type {
  StoredArticle,
  StoredAsset,
} from '../../contracts/stored-article';
export type {
  StoredArticle,
  StoredAsset,
} from '../../contracts/stored-article';
export interface ImportAttempt {
  importId: string;
  articleKey: string;
  externalId: string;
  startedAt: string;
  status: 'preparing' | 'cleanup_required' | 'needs_review';
}
export interface ArticleRepository extends Pick<
  ArticleDeletionRepository,
  'findExternalState'
> {
  getArticleDeclarations?(articleKeys: string[]): DeclarationReadResult;
  setArticleDeclarations?(change: DeclarationChange): DeclarationWriteResult;
  list?(cursor?: ArticleCursor): ListResult;
  reserve(
    externalId: string,
    retry?: { revisionOperationId: string },
  ): ImportAttempt;
  findExternal(externalId: string): StoredArticle | undefined;
  findImport(importId: string): StoredArticle | undefined;
  load(articleKey: string): StoredArticle | undefined;
  attempts(): ImportAttempt[];
  commit(
    attempt: ImportAttempt,
    article: StoredArticle,
    context?: { receipt: SaveReceipt; editorBody: PersistedEditorBody },
  ): void;
  markAttempt(importId: string, status: ImportAttempt['status']): void;
  forgetAttempt(importId: string): void;
  getSchemaVersion(): number;
  close(): void;
}
export interface AssetStore {
  readImage?(article: StoredArticle, assetKey: string): Promise<Uint8Array>;
  prepare(attempt: ImportAttempt, signal: AbortSignal): Promise<void>;
  put(
    attempt: ImportAttempt,
    imageId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<StoredAsset>;
  finalize(attempt: ImportAttempt, signal: AbortSignal): Promise<void>;
  cleanup(attempt: ImportAttempt): Promise<void>;
  verify(article: StoredArticle): Promise<void>;
}
export interface LocalRootCapability {
  readonly kind: 'local-root';
}
export type ImageSourceCapability = LocalRootCapability | ManualImageCapability;
export type ImageSource = ArticlePackageV1['images'][number]['source'];
export interface ImageReader {
  read(
    source: ImageSource,
    capability: ImageSourceCapability | undefined,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

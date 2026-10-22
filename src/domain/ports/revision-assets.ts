import type {
  RevisionIntent,
  RevisionOperation,
  RevisionImageSource,
  PreparedRevisionAssets,
  SaveReceipt,
  RevisionSaveInput,
  RevisionSaveResult,
  VerifiedStoredImage,
} from '../../contracts/article-revision';
import type {
  StoredArticle,
  StoredAsset,
} from '../../contracts/stored-article';
import type { ManualImage } from '../../contracts/manual-article';
export interface RevisionAssetStore {
  prepare(
    operation: RevisionIntent,
    images: readonly RevisionImageSource[],
    signal: AbortSignal,
  ): Promise<PreparedRevisionAssets>;
  finalizeNewFiles(
    operation: RevisionIntent,
    signal: AbortSignal,
  ): Promise<void>;
  verify(receipt: SaveReceipt): Promise<void>;
  cleanupOwnedUnreferenced(operation: RevisionOperation): Promise<void>;
}
export type CreateEditedArticle = (
  input: Extract<RevisionSaveInput, { kind: 'created' }>,
  signal: AbortSignal,
) => Promise<RevisionSaveResult>;
export interface StoredImageLeases {
  bindSavedImage(
    sessionId: string,
    article: StoredArticle,
    assetKey: string,
    imageToken: string,
    signal: AbortSignal,
  ): Promise<VerifiedStoredImage>;
  authorizeStored(
    sessionId: string,
    article: StoredArticle,
    assetKey: string,
    signal: AbortSignal,
  ): Promise<{ image: ManualImage; lease: VerifiedStoredImage }>;
  readStored(
    lease: VerifiedStoredImage,
    sessionId: string,
    articleKey: string,
    imageId: string,
    signal: AbortSignal,
  ): Promise<{ asset: StoredAsset; bytes: Uint8Array }>;
}

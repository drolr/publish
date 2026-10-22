import type {
  CoverSaveIntent,
  CoverSaveResult,
  StoredCoverAsset,
  StoredCoverConfiguration,
  CoverOperation,
  CoverOperationPatch,
  CoverImageSource,
} from '../../contracts/article-cover';
export interface ArticleCoverRepository {
  loadCover(articleKey: string): StoredCoverConfiguration | undefined;
  loadArchivedCoverVersion(
    articleKey: string,
    coverRevision: number,
  ): StoredCoverConfiguration | undefined;
  beginCoverSave(intent: CoverSaveIntent): CoverSaveResult;
  commitCoverVersion(
    intent: CoverSaveIntent,
    assets: readonly StoredCoverAsset[],
  ): CoverSaveResult;
  readCoverSaveResult(operationId: string): CoverSaveResult;
  readCoverOperation(operationId: string): CoverOperation | undefined;
  listCoverOperations(): CoverOperation[];
  markCoverOperation(operationId: string, patch: CoverOperationPatch): void;
  isCoverAssetReferenced(
    asset: StoredCoverAsset,
    excludingOperationId: string,
  ): boolean;
}
export interface CoverAssetStore {
  prepareCoverFiles(
    intent: CoverSaveIntent,
    images: readonly CoverImageSource[],
    signal: AbortSignal,
  ): Promise<StoredCoverAsset[]>;
  readCoverAsset(
    configuration: StoredCoverConfiguration,
    assetKey: string,
  ): Promise<Uint8Array>;
  verifyCoverVersion(configuration: StoredCoverConfiguration): Promise<void>;
  cleanupOwnedUnreferenced(operation: CoverOperation): Promise<void>;
}

/** Trusted native selection returns validated bytes, never renderer paths. */
export interface PickedCoverImage extends CoverImageSource {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}
export interface CoverFilePicker {
  pick(
    slotsCount: number,
    signal: AbortSignal,
  ): Promise<readonly PickedCoverImage[] | undefined>;
}

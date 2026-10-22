import type { ManualImage } from '../../contracts/manual-article';

export interface ManualImageCapability {
  readonly kind: 'manual-images';
}

export interface ManualImageSource {
  findEquivalent(
    sessionId: string,
    sha256: string,
    retainedTokens: readonly string[],
  ): ManualImage | undefined;
  authorize(
    sessionId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<ManualImage>;
  read(
    sessionId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ mime: ManualImage['mime']; bytes: Uint8Array }>;
  authorizeBytes(
    sessionId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ManualImage>;
  retain(
    sessionId: string,
    tokens: readonly string[],
    options?: { preserveHistory: boolean },
  ): Promise<void>;
  release(sessionId: string): Promise<void>;
  capability(sessionId: string): ManualImageCapability;
  readCapability(
    capability: ManualImageCapability,
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

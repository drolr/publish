import type { ManualFragmentV2 } from '../../contracts/manual-rich-draft';
import type { ManualImage } from '../../contracts/manual-article';
/** Atomic write of the bounded, main-generated fragment plus normal selected text. */
export interface ClipboardFragmentPort {
  write(grantId: string, selectedText: string): Promise<void>;
}
/** Trusted canonical occupancy; this context is never supplied through renderer IPC. */
export interface ManualPasteCapacity {
  images: readonly ManualImage[];
  candidates: number;
}
export interface ManualClipboard {
  isReady(): boolean;
  copy(
    sessionId: string,
    fragment: ManualFragmentV2,
    images: readonly ManualImage[],
    signal: AbortSignal,
  ): Promise<void>;
  paste(
    grantId: string,
    sessionId: string,
    signal: AbortSignal,
    retainedTokens: readonly string[],
    capacity?: ManualPasteCapacity,
  ): Promise<{ fragment: ManualFragmentV2; images: ManualImage[] }>;
  drain(): Promise<void>;
}

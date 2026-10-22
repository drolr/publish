import type { ManualDraft, ManualImage } from '../../contracts/manual-article';
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
    blocks: ManualDraft['blocks'],
    images: readonly ManualImage[],
    signal: AbortSignal,
  ): Promise<void>;
  paste(
    grantId: string,
    sessionId: string,
    signal: AbortSignal,
    retainedTokens: readonly string[],
    capacity?: ManualPasteCapacity,
  ): Promise<{ blocks: ManualDraft['blocks']; images: ManualImage[] }>;
  drain(): Promise<void>;
}

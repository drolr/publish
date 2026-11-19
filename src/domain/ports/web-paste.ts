import type { ManualImage } from '../../contracts/manual-article';
import type {
  ConvertedPaste,
  PasteErrorCode,
  WebPasteInput,
} from '../../contracts/web-paste';
export type { ConvertedBlock, ConvertedPaste } from '../../contracts/web-paste';

export interface WebPasteConverter {
  convert(input: WebPasteInput, signal: AbortSignal): Promise<ConvertedPaste>;
}
export interface WebPasteImageReader {
  acquire(
    sessionId: string,
    source: string,
    signal: AbortSignal,
  ): Promise<ManualImage>;
}
export interface ManualPasteControllerPorts {
  converter: import('./rich-web-paste').RichWebPasteConverter;
  pasteImages: WebPasteImageReader;
  fingerprint(input: WebPasteInput | { candidateId: string }): string;
}
export type PasteRunItem = { candidateId: string; source?: string };
export type PasteImageEvent = { candidateId: string } & (
  | { type: 'fetching' }
  | { type: 'ready'; image: ManualImage }
  | { type: 'failed'; reason: PasteErrorCode; retryable: boolean }
  | { type: 'cancelled' }
);

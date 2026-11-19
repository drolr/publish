import type { ConvertedRichPaste } from '../../contracts/rich-web-paste';
import type { WebPasteInput } from '../../contracts/web-paste';

export interface RichWebPasteConverter {
  convert(
    input: WebPasteInput,
    signal: AbortSignal,
  ): Promise<ConvertedRichPaste>;
}

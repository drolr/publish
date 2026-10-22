import type { PasteErrorCode } from '../contracts/web-paste';

/** Safe failure identity; original inputs and exception text are never attached. */
export class WebPasteFailure extends Error {
  constructor(readonly code: PasteErrorCode) {
    super(code);
    this.name = 'WebPasteFailure';
  }
}

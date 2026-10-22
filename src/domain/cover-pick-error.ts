import type { CoverImageFailure } from '../contracts/article-cover';
import { ImportFailure } from './import-error';
/** Only trusted native per-file validation supplies this index; never a path or raw error. */
export class CoverPickFailure extends ImportFailure {
  constructor(
    public readonly selectionIndex: number,
    reason: CoverImageFailure['reason'],
  ) {
    super(reason);
    this.name = 'CoverPickFailure';
  }
}

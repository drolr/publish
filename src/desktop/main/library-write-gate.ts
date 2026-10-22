import type { DraftController } from '../../application/draft-controller';
import type { StartImportResult } from '../../contracts/article-library';
import type { createImportController } from '../../application/import-controller';
import type { createManualArticleController } from '../../application/manual-article';

interface LibraryWriteGatePorts {
  available(): boolean;
  isClosing(): boolean;
  cover?: { hasSession(): boolean; isActive(): boolean; isBlocked(): boolean };
  imports?: Pick<
    ReturnType<typeof createImportController>,
    'isActive' | 'isBlocked' | 'start'
  >;
  draft?: Pick<DraftController, 'isActive' | 'isBlocked'>;
  manual?: Pick<
    ReturnType<typeof createManualArticleController>,
    'isActive' | 'isBlocked' | 'hasSession'
  >;
}
export function createLibraryWriteGate(ports: LibraryWriteGatePorts) {
  function state(): 'ready' | 'busy' | 'unavailable' {
    try {
      if (
        !ports.available() ||
        ports.isClosing() ||
        ports.imports?.isBlocked() ||
        ports.manual?.isBlocked() ||
        ports.draft?.isBlocked() ||
        ports.cover?.isBlocked()
      )
        return 'unavailable';
      return ports.cover?.hasSession() ||
        ports.cover?.isActive() ||
        ports.draft?.isActive() ||
        ports.imports?.isActive() ||
        ports.manual?.hasSession() ||
        ports.manual?.isActive()
        ? 'busy'
        : 'ready';
    } catch {
      return 'unavailable';
    }
  }
  function startImport(): StartImportResult {
    if (state() !== 'ready') return { status: 'unavailable' };
    if (
      !ports.available() ||
      ports.isClosing() ||
      ports.imports?.isBlocked() ||
      ports.draft?.isActive() ||
      ports.manual?.isActive() ||
      ports.manual?.hasSession() ||
      ports.manual?.isBlocked() ||
      ports.draft?.isBlocked()
    )
      return { status: 'unavailable' };
    return ports.imports?.start() ?? { status: 'unavailable' };
  }
  return { state, startImport };
}

interface Recoverable {
  recover(): Promise<boolean>;
}
// Never authorize temporary cleanup until formal import recovery has succeeded.
export function createArticleWriteRecovery(
  formal: Recoverable,
  temporary: Recoverable,
  revision?: Recoverable,
  cover?: Recoverable,
) {
  let ready = false;
  return {
    isReady: () => ready,
    async recover(): Promise<boolean> {
      ready = false;
      try {
        ready =
          (await formal.recover()) &&
          (!revision || (await revision.recover())) &&
          (!cover || (await cover.recover())) &&
          (await temporary.recover());
      } catch {
        ready = false;
      }
      return ready;
    },
  };
}

import { Resolver } from 'node:dns/promises';
import { ImportFailure } from '../../domain/import-error';
interface ImageResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}
export interface ImageAddress {
  address: string;
  family: 4 | 6;
}
/**
 * Each invocation owns a c-ares Resolver and both families. Unlike lookup(),
 * this reads DNS rather than hosts/NSS mappings and can cancel outstanding work.
 * Its promise settles only after every started query has settled, including abort.
 */
export function createCancellableImageDns(
  createResolver: () => ImageResolver = () =>
    new Resolver({ timeout: 30000, tries: 1 }),
) {
  return async (
    hostname: string,
    signal: AbortSignal,
  ): Promise<ImageAddress[]> => {
    if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
    const resolver = createResolver();
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      // Promise callbacks also capture synchronous resolver failures, without
      // leaving the other family unobserved or launching work after cancellation.
      const query = (family: 4 | 6) =>
        Promise.resolve().then(() => {
          if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
          return family === 4
            ? resolver.resolve4(hostname)
            : resolver.resolve6(hostname);
        });
      const results = await Promise.allSettled([query(4), query(6)]);
      if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
      const addresses: ImageAddress[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          for (const address of result.value)
            addresses.push({ address, family: index === 0 ? 4 : 6 });
        } else if (
          !['ENODATA', 'ENOTFOUND'].includes(
            (result.reason as NodeJS.ErrnoException)?.code ?? '',
          )
        ) {
          // A failed family is unknown, never permission to accept the other one.
          throw new ImportFailure('IMAGE_UNAVAILABLE');
        }
      }
      if (!addresses.length) throw new ImportFailure('IMAGE_UNAVAILABLE');
      return addresses;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
}
export const resolveImageHost = createCancellableImageDns();

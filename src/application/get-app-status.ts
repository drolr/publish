import type { BaselineStore } from '../domain/ports/baseline-store';
import type { AppStatus } from '../contracts/app-status';
import { STORAGE_SCHEMA_VERSION } from '../contracts/storage-version';
export function getAppStatus(
  store: BaselineStore | undefined,
  appVersion: string,
): AppStatus {
  try {
    if (store?.getSchemaVersion() === STORAGE_SCHEMA_VERSION)
      return {
        state: 'ready',
        appVersion,
        schemaVersion: STORAGE_SCHEMA_VERSION,
      };
  } catch {
    /* The privileged boundary returns no underlying exception data. */
  }
  return { state: 'unavailable', code: 'INITIALIZATION_FAILED' };
}

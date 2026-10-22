import type { BatchApi } from './draft-batch';
import type { ArticleCoverApi } from './article-cover';
import type { OperationControlApi } from './operation-control';
import type { ArticleDeletionApi } from './article-delete';
import { z } from 'zod';
import { STORAGE_SCHEMA_VERSION } from './storage-version';
import type { ArticleLibraryApi } from './article-library';
import type { ManualArticleApi } from './manual-article';
import type { DraftApi } from './draft-task';
import type { EditorCloseEventsApi } from './editor-close';
export const APP_STATUS_CHANNEL = 'app:get-status';
export const NoArgumentsSchema = z.tuple([]);
export const AppStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ready'),
    appVersion: z.string().min(1),
    schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    code: z.literal('INITIALIZATION_FAILED'),
  }),
]);
export type AppStatus = z.infer<typeof AppStatusSchema>;
export interface DesktopApi
  extends
    OperationControlApi,
    ArticleLibraryApi,
    ArticleDeletionApi,
    ArticleCoverApi,
    ManualArticleApi,
    DraftApi,
    EditorCloseEventsApi {
  readonly batch: BatchApi;
  getAppStatus(): Promise<AppStatus>;
}

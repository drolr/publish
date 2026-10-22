import { z } from 'zod';

export const OperationScopeSchema = z.enum([
  'draft',
  'browser',
  'manual',
  'cover',
  'import',
]);
export const OperationOwnerStateSchema = z.enum([
  'idle',
  'active',
  'needs_review',
]);
export const OperationControlViewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    phase: z.enum(['idle', 'stopping', 'stopped', 'needs_review']),
    owners: z
      .array(
        z
          .object({
            scope: OperationScopeSchema,
            state: OperationOwnerStateSchema,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type OperationScope = z.infer<typeof OperationScopeSchema>;
export type OperationOwnerState = z.infer<typeof OperationOwnerStateSchema>;
export type OperationControlView = z.infer<typeof OperationControlViewSchema>;
export interface OperationControlApi {
  requestStopAll(): Promise<OperationControlView>;
  getOperationControlState(): Promise<OperationControlView>;
}
export const operationControlChannels = {
  requestStopAll: 'operations:stop-all',
  getOperationControlState: 'operations:state',
} as const;
export const OperationControlRequestSchema = z.tuple([]);

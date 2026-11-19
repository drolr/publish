import { z } from 'zod';
export const BrowserHealthViewSchema = z
  .object({
    status: z.enum([
      'unchecked',
      'checking',
      'missing',
      'unavailable',
      'too_old',
      'unknown_version',
      'check_failed',
      'busy',
      'passed',
      'update_open',
    ]),
    version: z.string().nullable(),
    stage: z
      .enum([
        'launch',
        'version',
        'evaluate',
        'locator',
        'editor',
        'file',
        'cleanup',
        'update',
      ])
      .nullable(),
    reason: z
      .enum([
        'task_busy',
        'business_open',
        'maintenance_open',
        'ownership_unconfirmed',
        'cleanup_failed',
        'version_changed',
        'timeout',
        'capability_failed',
        'update_unavailable',
      ])
      .nullable(),
  })
  .strict();
export type BrowserHealthView = z.infer<typeof BrowserHealthViewSchema>;
export const BrowserHealthResultSchema = z
  .object({ status: z.enum(['ok', 'blocked']), view: BrowserHealthViewSchema })
  .strict();
export type BrowserHealthResult = z.infer<typeof BrowserHealthResultSchema>;
export const browserHealthRequestSchemas = {
  getBrowserHealth: z.tuple([]),
  checkBrowserHealth: z.tuple([]),
  openBrowserUpdate: z.tuple([]),
};
export interface BrowserHealthApi {
  getBrowserHealth(): Promise<BrowserHealthView>;
  checkBrowserHealth(): Promise<BrowserHealthResult>;
  openBrowserUpdate(): Promise<BrowserHealthResult>;
}

export const browserHealthChannels = {
  getBrowserHealth: 'browser-health:get',
  checkBrowserHealth: 'browser-health:check',
  openBrowserUpdate: 'browser-health:update',
} as const;
export const browserHealthResponseSchemas = {
  getBrowserHealth: BrowserHealthViewSchema,
  checkBrowserHealth: BrowserHealthResultSchema,
  openBrowserUpdate: BrowserHealthResultSchema,
};

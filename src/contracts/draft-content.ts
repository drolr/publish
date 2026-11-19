import { z } from 'zod';
export const FormatFeatureSchema = z.enum([
  'bold',
  'italic',
  'underline',
  'heading',
  'ordered_list',
  'bullet_list',
  'blockquote',
]);
export type FormatFeature = z.infer<typeof FormatFeatureSchema>;
export const DraftContentCapabilitiesSchema = z.strictObject({
  revision: z.string().min(1).max(200),
  features: z.partialRecord(FormatFeatureSchema, z.literal('verified')),
});
export type DraftContentCapabilities = z.infer<
  typeof DraftContentCapabilitiesSchema
>;
export type ContentSupport =
  { ok: true } | { ok: false; missing: FormatFeature[] };

import { z } from 'zod';
export {
  ManualCloseRequestSchema,
  type ManualCloseRequest,
  type EditorCloseEventsApi,
} from './manual-edit';
export const manualCloseChannels = {
  request: 'manual:close-request',
  ready: 'manual:close-ready',
} as const;
export const ManualCloseReadySchema = z.tuple([]);
const fragmentId = z.uuid();
const marker = 'application/x-draft-assistant-fragment:';
/** A private transport marker, not executable/source HTML or a public image URL. */
export function encodeManualClipboardFragment(
  grantId: string,
  selectedText: string,
): string {
  fragmentId.parse(grantId);
  const escaped = selectedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<pre>${escaped}</pre><!--${marker}${grantId}-->`;
}
/** Called only for the HTML already supplied by an active paste/copy event. */
export function parseManualClipboardFragment(html: string): string | undefined {
  if (html.length > 2 * 1024 * 1024) return undefined;
  const matches = [
    ...html.matchAll(
      /<!--application\/x-draft-assistant-fragment:([^<>\s]+)-->/g,
    ),
  ];
  if (matches.length !== 1) return undefined;
  const parsed = fragmentId.safeParse(matches[0][1]);
  return parsed.success ? parsed.data : undefined;
}

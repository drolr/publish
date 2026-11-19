import type {
  RichTextBlock,
  TextMark,
} from '../../../contracts/rich-text-body';
import { PersistedEditorBodyV2Schema } from '../../../contracts/rich-text-body';
import type { EditorEvidence } from './content-evidence';
import type { RichEditorEvidence } from './rich-content-evidence';
import { JudongchePageError } from './production-state';
/** Adapter-internal normal UI actions. T9 must establish each production mapping.
 * No clipboard, HTML injection, private editor API or guessed shortcut is provided. */
export interface RichTextUiPort {
  guard(): Promise<void>;
  resetFormat(): Promise<void>;
  selectBlock(
    kind:
      'paragraph' | 'heading' | 'ordered_list' | 'bullet_list' | 'blockquote',
    start?: number,
  ): Promise<void>;
  setMark(mark: TextMark, active: boolean): Promise<void>;
  typeText(text: string): Promise<void>;
  softBreak(): Promise<void>;
  nextTextLeaf(): Promise<void>;
  exitBlock(): Promise<void>;
}
export async function appendRichTextBlock(
  port: RichTextUiPort,
  block: RichTextBlock,
  stopped: () => boolean,
): Promise<void> {
  const parsed = PersistedEditorBodyV2Schema.parse({
    version: 2,
    blocks: [block],
  }).blocks[0];
  if (!parsed || parsed.type === 'image')
    throw new JudongchePageError('INPUT_UNSUPPORTED');
  const check = async () => {
    if (stopped()) throw new JudongchePageError('STOP_REQUESTED');
    await port.guard();
    if (stopped()) throw new JudongchePageError('STOP_REQUESTED');
  };
  const action = async (fn: () => Promise<void>) => {
    await check();
    await fn();
    await check();
  };
  await action(() => port.resetFormat());
  const kind =
    parsed.type === 'list'
      ? parsed.kind === 'ordered'
        ? 'ordered_list'
        : 'bullet_list'
      : parsed.type;
  await action(() =>
    port.selectBlock(
      kind,
      parsed.type === 'list' && parsed.kind === 'ordered'
        ? parsed.start
        : undefined,
    ),
  );
  const leaves =
    parsed.type === 'list'
      ? parsed.items
      : parsed.type === 'blockquote'
        ? parsed.paragraphs
        : [parsed];
  for (const [index, leaf] of leaves.entries()) {
    if (index) await action(() => port.nextTextLeaf());
    for (const run of leaf.content) {
      for (const mark of ['bold', 'italic', 'underline'] as const)
        await action(() => port.setMark(mark, run.marks.includes(mark)));
      for (const [part, text] of run.text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .entries()) {
        if (part) await action(() => port.softBreak());
        if (text) await action(() => port.typeText(text));
      }
    }
  }
  await action(() => port.exitBlock());
  await action(() => port.resetFormat());
}
export function unknownRichEditorEvidence(
  base: EditorEvidence,
): RichEditorEvidence {
  return { ...base, rich: { formatKnown: false, blocks: [] } };
}
export function unsupportedProductionRichText(): never {
  throw new JudongchePageError('FORMAT_UNSUPPORTED');
}

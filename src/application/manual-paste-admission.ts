import {
  ManualDraftSchema,
  type ManualDraft,
} from '../contracts/manual-article';
import {
  ConvertedPasteSchema,
  type CandidateView,
  type ConvertedPaste,
} from '../contracts/web-paste';
import { WebPasteFailure } from '../domain/web-paste-error';
import type { ManualSession } from './manual-article-mapper';
import type { PasteRunItem } from './manual-paste-runner';
import type { DraftRange } from '../contracts/manual-edit';
import { spliceManualRange } from '../domain/manual-draft-range';

/** Builds a complete proposal; caller atomically confirms it before any IO. */
export function admitManualPaste(
  session: ManualSession,
  value: ConvertedPaste,
  initialBlock: string | undefined,
  newId: () => string,
  range?: DraftRange,
  enforcePositions = range !== undefined,
): {
  draft: ManualDraft;
  candidates: CandidateView[];
  items: PasteRunItem[];
  paragraphs: number;
  plainOnly: boolean;
} {
  const checked = ConvertedPasteSchema.safeParse(value);
  if (!checked.success) throw new WebPasteFailure('INPUT_LIMIT');
  const paste = checked.data;
  if (!paste.blocks.length) throw new WebPasteFailure('EMPTY');
  const candidates: CandidateView[] = [];
  const items: PasteRunItem[] = [];
  const blocks = paste.blocks.map((block) => {
    const blockKey = newId();
    if (block.type === 'paragraph') return { ...block, blockKey };
    const candidateId = newId();
    candidates.push({
      candidateId,
      blockKey,
      state: 'waiting',
      retryable: false,
    });
    items.push({ candidateId, source: block.source });
    return { type: 'image-pending' as const, blockKey, candidateId };
  });
  if (
    session.images.length + session.candidates.length + candidates.length >
    200
  )
    throw new WebPasteFailure('IMAGE_LIMIT');
  const old = session.draft.blocks;
  const replace =
    old.length === 1 &&
    old[0].blockKey === initialBlock &&
    old[0].type === 'paragraph' &&
    old[0].text === '' &&
    paste.blocks.some(
      (block) => block.type === 'paragraph' && block.text.trim() !== '',
    );
  const parsed = ManualDraftSchema.safeParse(
    range
      ? spliceManualRange(session.draft, range, blocks, newId)
      : {
          ...session.draft,
          blocks: [...(replace ? [] : old), ...blocks],
        },
  );
  if (!parsed.success) throw new WebPasteFailure('INPUT_LIMIT');
  if (
    enforcePositions &&
    parsed.data.blocks.filter((b) => b.type !== 'paragraph').length >
      Math.max(
        200,
        session.draft.blocks.filter((b) => b.type !== 'paragraph').length,
      )
  )
    throw new WebPasteFailure('INPUT_LIMIT');
  return {
    draft: parsed.data,
    candidates,
    items,
    paragraphs: paste.blocks.filter((block) => block.type === 'paragraph')
      .length,
    plainOnly: paste.plainOnly,
  };
}

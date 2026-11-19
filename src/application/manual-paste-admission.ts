import {
  ManualDraftV2Schema,
  type ManualDraftV2,
  type ManualFragmentV2,
  type ManualRichBlock,
} from '../contracts/manual-rich-draft';
import {
  ConvertedRichPasteSchema,
  type ConvertedRichPaste,
  type RichPasteWarning,
} from '../contracts/rich-web-paste';
import { webPasteLimits } from '../contracts/web-paste';
import type { ManualImage } from '../contracts/manual-article';
import { isManualImageBlock } from '../contracts/manual-rich-draft';
import {
  ManualDraftV1Schema,
  type ManualDraftV1,
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
  session: Omit<ManualSession, 'draft'> & { draft: ManualDraftV1 },
  value: ConvertedPaste,
  initialBlock: string | undefined,
  newId: () => string,
  range?: DraftRange,
  enforcePositions = range !== undefined,
): {
  draft: ManualDraftV1;
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
  const parsed = ManualDraftV1Schema.safeParse(
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
    parsed.data.blocks.filter(isManualImageBlock).length >
      Math.max(200, session.draft.blocks.filter(isManualImageBlock).length)
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

/** Production V2 admission. The complete candidate is validated before any image IO. */
export function admitRichManualPaste(
  session: {
    draft: ManualDraftV2;
    images: readonly ManualImage[];
    candidates: readonly CandidateView[];
  },
  value: ConvertedRichPaste,
  newId: () => string,
  range?: DraftRange,
  initialBlock?: string,
  enforcePositions = true,
): {
  draft: ManualDraftV2;
  candidates: CandidateView[];
  items: PasteRunItem[];
  paragraphs: number;
  plainOnly: boolean;
  warnings: RichPasteWarning[];
} {
  const checked = ConvertedRichPasteSchema.safeParse(value);
  if (!checked.success) throw new WebPasteFailure('INPUT_LIMIT');
  const paste = checked.data,
    candidates: CandidateView[] = [],
    items: PasteRunItem[] = [];
  const blocks = paste.blocks.map((block): ManualRichBlock => {
    const blockKey = newId();
    if (block.type === 'image') {
      const candidateId = newId();
      candidates.push({
        candidateId,
        blockKey,
        state: 'waiting',
        retryable: false,
      });
      items.push({ candidateId, source: block.source });
      return { type: 'image-pending', blockKey, candidateId };
    }
    if (block.type === 'list')
      return {
        ...block,
        blockKey,
        items: block.items.map((p) => ({ ...p, blockKey: newId() })),
      };
    if (block.type === 'blockquote')
      return {
        ...block,
        blockKey,
        paragraphs: block.paragraphs.map((p) => ({ ...p, blockKey: newId() })),
      };
    return { ...block, blockKey };
  });
  if (
    session.images.length + session.candidates.length + candidates.length >
    webPasteLimits.images
  )
    throw new WebPasteFailure('IMAGE_LIMIT');
  const fragment: ManualFragmentV2 = {
    version: 2,
    blocks,
    openStart: blocks[0]?.type === 'paragraph',
    openEnd: blocks.at(-1)?.type === 'paragraph',
  };
  const proposal = range
    ? spliceManualRange(session.draft, range, fragment, newId)
    : {
        ...session.draft,
        blocks: [
          ...(session.draft.blocks.length === 1 &&
          session.draft.blocks[0].blockKey === initialBlock &&
          session.draft.blocks[0].type === 'paragraph' &&
          session.draft.blocks[0].content.length === 0 &&
          paste.blocks.some(
            (b) =>
              b.type !== 'image' &&
              (b.type !== 'paragraph' || b.content.some((r) => r.text.trim())),
          )
            ? []
            : session.draft.blocks),
          ...blocks,
        ],
      };
  const parsed = ManualDraftV2Schema.safeParse(proposal);
  if (!parsed.success) throw new WebPasteFailure('INPUT_LIMIT');
  const draft = parsed.data;
  for (const candidate of candidates) {
    const placed = draft.blocks.find(
      (b) =>
        b.type === 'image-pending' && b.candidateId === candidate.candidateId,
    );
    if (!placed) throw new WebPasteFailure('INPUT_LIMIT');
    candidate.blockKey = placed.blockKey;
  }
  if (
    enforcePositions &&
    draft.blocks.filter(isManualImageBlock).length >
      Math.max(
        webPasteLimits.images,
        session.draft.blocks.filter(isManualImageBlock).length,
      )
  )
    throw new WebPasteFailure('INPUT_LIMIT');
  return {
    draft,
    candidates,
    items,
    paragraphs: paste.blocks.reduce(
      (n, b) =>
        n +
        (b.type === 'list'
          ? b.items.length
          : b.type === 'blockquote'
            ? b.paragraphs.length
            : b.type === 'image'
              ? 0
              : 1),
      0,
    ),
    plainOnly: paste.plainOnly,
    warnings: [...paste.warnings],
  };
}

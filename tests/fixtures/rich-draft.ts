import type { RichEditorEvidence } from '../../src/infrastructure/platforms/judongche/rich-content-evidence';
import type { JudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type { PersistedEditorBodyV2 } from '../../src/contracts/rich-text-body';
import { projectRichBody } from '../../src/domain/rich-text-body';
import { createDraftSnapshotV2Digest } from '../../src/infrastructure/draft-snapshot-integrity';
import { makeDraftTask } from './draft-task';
import { draftHarness } from './draft-adapter';
export const richCapabilities = {
  revision: 'controlled-rich-v1',
  features: {
    bold: 'verified',
    italic: 'verified',
    underline: 'verified',
    heading: 'verified',
    ordered_list: 'verified',
    bullet_list: 'verified',
    blockquote: 'verified',
  },
} as const;
export const richBody: PersistedEditorBodyV2 = {
  version: 2,
  blocks: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'AB', marks: ['bold', 'italic', 'underline'] },
        { type: 'text', text: '\nB', marks: [] },
      ],
    },
    { type: 'paragraph', content: [] },
    {
      type: 'heading',
      content: [{ type: 'text', text: 'Heading', marks: [] }],
    },
    {
      type: 'list',
      kind: 'ordered',
      start: 1,
      items: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Item', marks: [] }],
        },
      ],
    },
    {
      type: 'blockquote',
      paragraphs: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Quote', marks: [] }],
        },
      ],
    },
  ],
};
export function richDraftHarness(
  body: PersistedEditorBodyV2 = richBody,
  coverPlan?: import('../../src/contracts/cover-task').CoverPlan,
) {
  const article = structuredClone(makeDraftTask().snapshot.article);
  article.body = projectRichBody(body);
  article.assets = body.blocks.some((b) => b.type === 'image')
    ? draftHarness().task.snapshot.article.assets
    : [];
  const snapshot = {
    version: 2 as const,
    article,
    editorBody: structuredClone(body),
    digest: createDraftSnapshotV2Digest(article, body),
  };
  const h = draftHarness(coverPlan, { snapshot });
  const observed = Object.assign(h.observed, {
    rich: {
      formatKnown: true,
      blocks: [] as RichEditorEvidence['rich']['blocks'],
    },
  });
  const pages = h.pages as JudongchePages &
    Required<
      Pick<
        JudongchePages,
        'inspectRichEditor' | 'inspectRichDraft' | 'appendTextBlock'
      >
    >;
  Object.assign(pages, {
    inspectRichEditor: async () => structuredClone(observed),
    inspectRichDraft: async () => ({
      ...structuredClone(observed),
      isDraft: true,
    }),
    appendTextBlock: async (
      block: import('../../src/contracts/rich-text-body').RichTextBlock,
    ) => {
      h.calls.push('rich');
      observed.rich.blocks.push(structuredClone(block));
    },
  });
  const appendImage = pages.appendImage;
  pages.appendImage = async (...args) => {
    const resourceKey = await appendImage(...args);
    observed.rich.blocks.push({ type: 'image', resourceKey, loaded: true });
    return resourceKey;
  };
  return { ...h, observed, pages };
}

import type { PreviewResult } from '../../contracts/article-library';
// The privileged preview reader verifies assets in one lane; every renderer consumer shares it.
let tail: Promise<unknown> = Promise.resolve();
let generation = 0;
// Only invoked after main has confirmed stop settlement. Does not replay writes.
export function resetArticlePreviewReads() {
  generation++;
  tail = Promise.resolve();
}
export function readArticlePreview(
  key: string,
  current: () => boolean,
): Promise<PreviewResult | null> {
  const ticket = generation;
  const next = tail
    .then(() =>
      ticket === generation && current()
        ? window.desktopApi.getArticlePreview(key)
        : null,
    )
    .then((result) => (ticket === generation && current() ? result : null));
  tail = next.catch(() => null);
  return next;
}

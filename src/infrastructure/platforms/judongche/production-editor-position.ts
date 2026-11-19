import { defaultUploadWaits } from './upload-waits';
import type { Page, ElementHandle } from 'playwright-core';
import {
  JudongchePageError,
  type BlockEdgeCallsite,
  type BlockEdgeDiagnostic,
  type BlockEdgeAttempt,
  type BlockEdgeTag,
  type BlockEdgeKind,
  type BlockEdgeRelation,
  exceptionCategory,
} from './production-state';

/** Shared normal positioning for plain image/text tails and rich-text leaves.
 * Read-only Range geometry locates the final visual line; selection is changed
 * only by the bound element's actionable click and normal keyboard keys.
 */
export async function clickEditorLeafEnd(
  page: Page,
  editorSelector: string,
  blockIndex: number,
  leafIndex: number,
  context?: {
    callsite: BlockEdgeCallsite;
    clickTimeout?: number;
    /** A caller-validated identity; the caller retains ownership of its handle. */
    identity?: ElementHandle<Element>;
    diagnostic?: (value: BlockEdgeDiagnostic) => void;
    stop?: () => void;
  },
): Promise<void> {
  const diagnostic: BlockEdgeDiagnostic = {
    callsite: context?.callsite ?? 'unspecified',
    blockIndex,
    leafIndex,
    attempts: [],
  };
  context?.stop?.();
  const report = () => {
    try {
      context?.diagnostic?.(diagnostic);
    } catch {
      /* Diagnostic only. */
    }
  };
  // Bind the DOM identity once. Re-resolving nth(index) after observing geometry
  // could silently choose a different leaf when the editor re-renders.
  const identityHandle =
    context?.identity ??
    (await page.evaluateHandle(
      ({ selector, blockIndex, leafIndex }) => {
        const editors = document.querySelectorAll(selector);
        const block =
          editors.length === 1 ? editors[0].children[blockIndex] : null;
        return block && ['UL', 'OL', 'BLOCKQUOTE'].includes(block.tagName)
          ? (block.children[leafIndex] ?? null)
          : leafIndex === 0
            ? block
            : null;
      },
      { selector: editorSelector, blockIndex, leafIndex },
    ));
  const identity = identityHandle.asElement();
  const sameIdentity = async () =>
    !!identity &&
    (await identity.evaluate(
      (node, { selector, blockIndex, leafIndex }) => {
        const editors = document.querySelectorAll(selector);
        const block =
          editors.length === 1 ? editors[0].children[blockIndex] : null;
        const target =
          block && ['UL', 'OL', 'BLOCKQUOTE'].includes(block.tagName)
            ? block.children[leafIndex]
            : leafIndex === 0
              ? block
              : null;
        return node.isConnected && node === target;
      },
      { selector: editorSelector, blockIndex, leafIndex },
    ));
  const changed = () =>
    new JudongchePageError(
      'PAGE_CHANGED',
      'block-edge-target-changed',
      undefined,
      diagnostic,
    );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      context?.stop?.();
      const observed = await page.evaluate(
        ({ selector, blockIndex, leafIndex, attempt, identity }) => {
          const editors = document.querySelectorAll(selector);
          const pm = editors.length === 1 ? editors[0] : null;
          const block = pm?.children[blockIndex];
          const container =
            block && ['UL', 'OL', 'BLOCKQUOTE'].includes(block.tagName);
          const target = container
            ? block.children[leafIndex]
            : leafIndex === 0
              ? block
              : null;
          if (
            !block ||
            !target ||
            target !== identity ||
            (container &&
              target.tagName !==
                (block.tagName === 'BLOCKQUOTE' ? 'P' : 'LI')) ||
            (!container && !/^(P|H[1-6])$/.test(target.tagName))
          )
            return {
              hit: null,
              diagnostic: {
                attempt,
                status: 'block-missing',
                blockKind: 'absent',
                targetKind: 'absent',
              } satisfies BlockEdgeAttempt,
            };
          const rect = target.getBoundingClientRect();
          // Only read Range geometry. End is a visual-line key, so clicking the
          // first line of a wrapped leaf cannot seat its actual text end.
          const endRect = () => {
            const noise = '.syl-placeholder, img.ProseMirror-separator';
            const walker = document.createTreeWalker(
              target,
              NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
            );
            let last: Node | null = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const element =
                node.nodeType === Node.ELEMENT_NODE
                  ? (node as Element)
                  : node.parentElement;
              if (element?.closest(noise)) continue;
              if (
                (node.nodeType === Node.TEXT_NODE &&
                  node.textContent?.length) ||
                element?.tagName === 'BR'
              )
                last = node;
            }
            if (!last) return null;
            const range = document.createRange();
            if (last.nodeType === Node.TEXT_NODE) {
              range.setStart(last, last.textContent!.length);
              range.collapse(true);
            } else range.selectNode(last);
            return (
              Array.from(range.getClientRects())
                .filter((r) => r.height > 0)
                .at(-1) ?? null
            );
          };
          const line = endRect();
          const visible =
            (line ?? rect).top >= 0 &&
            (line ?? rect).bottom <=
              (window.innerHeight || document.documentElement.clientHeight);
          if (!visible || attempt > 1) {
            target.scrollIntoView({
              block: 'center',
              inline: 'nearest',
              behavior: 'instant',
            });
            // A tall leaf may be larger than its scrolling ancestor. Center its
            // final line by normal scrolling, refreshing Range geometry each time.
            for (
              let parent = target.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              if (
                parent === document.scrollingElement ||
                parent.scrollHeight <= parent.clientHeight
              )
                continue;
              const r = parent.getBoundingClientRect();
              const terminal = endRect();
              if (terminal)
                parent.scrollBy({
                  top:
                    terminal.y +
                    terminal.height / 2 -
                    (r.y + parent.clientTop + parent.clientHeight / 2),
                  behavior: 'instant',
                });
            }
            const terminal = endRect();
            if (terminal)
              window.scrollBy({
                top: terminal.y + terminal.height / 2 - window.innerHeight / 2,
                behavior: 'instant',
              });
          }
          const box = target.getBoundingClientRect();
          const terminal = endRect();
          const hasPlaceholder = !!target.querySelector(
            ':scope > span.syl-placeholder[contenteditable="false"]',
          );
          const x = hasPlaceholder
            ? box.right - Math.min(8, box.width / 2)
            : terminal
              ? Math.min(
                  box.right - 1,
                  Math.max(box.left + 1, terminal.right + 1),
                )
              : box.right - 8;
          const y = terminal
            ? terminal.top + terminal.height / 2
            : box.top + Math.min(box.height / 2, 12);
          const hit = document.elementFromPoint(x, y);
          const popup = document.querySelector('div.plugin-helper');
          const decision = {
            x,
            y,
            position: {
              x: x - box.left - target.clientLeft,
              y: y - box.top - target.clientTop,
            },
            container,
            inside: !!hit && target.contains(hit),
            blocked:
              (!!popup && !!hit && popup.contains(hit)) ||
              !!hit?.closest('label.byte-radio'),
          };
          // All operation reads/decisions above retain their original failure
          // semantics. Only diagnostic work is protected by this catch.
          let detail: BlockEdgeAttempt = { attempt, status: 'unavailable' };
          try {
            const geometry = (r: DOMRect) => ({
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
            });
            const tag = (element: Element | null): BlockEdgeTag => {
              if (!element) return 'absent';
              switch (element.localName) {
                case 'div':
                case 'p':
                case 'span':
                case 'br':
                case 'ul':
                case 'ol':
                case 'li':
                case 'blockquote':
                case 'h1':
                case 'h2':
                case 'h3':
                case 'h4':
                case 'h5':
                case 'h6':
                case 'img':
                case 'label':
                case 'input':
                case 'button':
                case 'body':
                case 'html':
                  return element.localName;
                default:
                  return 'other';
              }
            };
            const kind = (element: Element): BlockEdgeKind => {
              switch (tag(element)) {
                case 'p':
                  return 'paragraph';
                case 'h1':
                case 'h2':
                case 'h3':
                case 'h4':
                case 'h5':
                case 'h6':
                  return 'heading';
                case 'ul':
                  return 'bullet-list';
                case 'ol':
                  return 'ordered-list';
                case 'blockquote':
                  return 'blockquote';
                case 'li':
                  return 'list-item';
                case 'img':
                  return 'image';
                default:
                  return 'other';
              }
            };
            const relation = (node: Node | null): BlockEdgeRelation => {
              if (!node) return 'absent';
              if (target.contains(node)) return 'target-descendant';
              if (pm?.contains(node)) return 'editor';
              if (node.contains(target)) return 'ancestor';
              return 'other';
            };
            const ancestors: NonNullable<BlockEdgeAttempt['ancestors']> = [];
            let parent = target.parentElement;
            for (
              let depth = 1;
              parent && depth <= 8 && ancestors.length < 6;
              depth++, parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const clipsX = ['hidden', 'clip', 'scroll', 'auto'].includes(
                style.overflowX,
              );
              const clipsY = ['hidden', 'clip', 'scroll', 'auto'].includes(
                style.overflowY,
              );
              const scrolls =
                parent.scrollWidth > parent.clientWidth ||
                parent.scrollHeight > parent.clientHeight;
              if (!clipsX && !clipsY && !scrolls) continue;
              const r = parent.getBoundingClientRect();
              ancestors.push({
                depth,
                tag: tag(parent),
                rect: geometry(r),
                clipsX,
                clipsY,
                pointOutsideX:
                  x < r.left + parent.clientLeft ||
                  x >= r.left + parent.clientLeft + parent.clientWidth,
                pointOutsideY:
                  y < r.top + parent.clientTop ||
                  y >= r.top + parent.clientTop + parent.clientHeight,
                scrollLeft: parent.scrollLeft,
                scrollTop: parent.scrollTop,
                clientWidth: parent.clientWidth,
                clientHeight: parent.clientHeight,
                scrollWidth: parent.scrollWidth,
                scrollHeight: parent.scrollHeight,
              });
            }
            const siblings: NonNullable<BlockEdgeAttempt['siblings']> = [];
            for (const [side, sibling] of [
              ['previous', target.previousElementSibling],
              ['next', target.nextElementSibling],
            ] as const) {
              if (sibling)
                siblings.push({
                  side,
                  tag: tag(sibling),
                  rect: geometry(sibling.getBoundingClientRect()),
                });
            }
            const selection = window.getSelection();
            detail = {
              attempt,
              status: 'observed',
              sample: 'sampled-before-click',
              clickStage: 'not-started',
              positionStage: 'before-click',
              clickCompleted: false,
              documentVisibility:
                document.visibilityState === 'visible'
                  ? 'visible'
                  : document.visibilityState === 'hidden'
                    ? 'hidden'
                    : 'unknown',
              documentHasFocus: document.hasFocus(),
              blockKind: kind(block),
              targetKind: kind(target),
              targetTag: tag(target),
              beforeScroll: geometry(rect),
              afterScroll: geometry(box),
              scrolled: rect.x !== box.x || rect.y !== box.y,
              viewport: {
                width:
                  window.innerWidth || document.documentElement.clientWidth,
                height:
                  window.innerHeight || document.documentElement.clientHeight,
              },
              point: { x, y },
              inside: decision.inside,
              blocked: decision.blocked,
              hitCategory: !hit
                ? 'absent'
                : popup?.contains(hit)
                  ? 'popup'
                  : hit.closest('label.byte-radio')
                    ? 'radio'
                    : 'element',
              hitTag: tag(hit),
              hitRelation: relation(hit),
              ancestors,
              siblings,
              focus: {
                active: relation(document.activeElement),
                anchor: relation(selection?.anchorNode ?? null),
                focus: relation(selection?.focusNode ?? null),
                collapsed: selection?.isCollapsed ?? null,
                rangeCount: Math.min(selection?.rangeCount ?? 0, 2),
              },
            };
          } catch {
            // Neither exception messages nor arbitrary page strings escape.
          }
          return { hit: decision, diagnostic: detail };
        },
        {
          selector: editorSelector,
          blockIndex,
          leafIndex,
          attempt: attempt + 1,
          identity,
        },
      );
      diagnostic.attempts.push(observed.diagnostic);
      report();
      const box = observed.hit;
      if (!box)
        throw new JudongchePageError(
          'PAGE_CHANGED',
          'block-missing',
          undefined,
          diagnostic,
        );
      if (!box.blocked && box.inside) {
        if (!(await sameIdentity())) throw changed();
        const clickStarted = performance.now();
        observed.diagnostic.clickStage = 'started';
        observed.diagnostic.positionStage = 'click';
        observed.diagnostic.clickCompleted = false;
        report();
        try {
          context?.stop?.();
          // ElementHandle.click retains Playwright's normal actionability checks
          // while refusing to retarget a replacement node at the same index.
          await identity!.click({
            position: box.position,
            timeout: context?.clickTimeout ?? defaultUploadWaits.caretClick,
          });
          observed.diagnostic.clickStage = 'completed';
          observed.diagnostic.clickCompleted = true;
          observed.diagnostic.clickElapsedMs = performance.now() - clickStarted;
          report();
          observed.diagnostic.positionStage = 'settle';
          report();
          const settleStarted = performance.now();
          try {
            while (performance.now() - settleStarted < 160) {
              context?.stop?.();
              await page.waitForTimeout(
                Math.min(
                  40,
                  Math.max(1, 160 - (performance.now() - settleStarted)),
                ),
              );
            }
            context?.stop?.();
          } finally {
            observed.diagnostic.settleElapsedMs =
              performance.now() - settleStarted;
          }
          observed.diagnostic.positionStage = 'post-identity';
          report();
          const identityStarted = performance.now();
          try {
            context?.stop?.();
            if (!(await sameIdentity())) throw changed();
          } finally {
            observed.diagnostic.postIdentityElapsedMs =
              performance.now() - identityStarted;
          }
          observed.diagnostic.positionStage = 'completed';
          report();
          return;
        } catch (error) {
          report();
          if (!observed.diagnostic.clickCompleted) {
            observed.diagnostic.clickStage = 'exception';
            observed.diagnostic.clickElapsedMs =
              performance.now() - clickStarted;
            observed.diagnostic.clickExceptionCategory =
              exceptionCategory(error);
            report();
          }
          if (!(await sameIdentity())) throw changed();
          if (observed.diagnostic.clickCompleted) throw error;
          if (!(error instanceof Error) || error.name !== 'TimeoutError')
            throw error;
        }
      }
      context?.stop?.();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
    throw new JudongchePageError(
      'PAGE_CHANGED',
      'block-edge-blocked',
      undefined,
      diagnostic,
    );
  } finally {
    if (!context?.identity) await identityHandle.dispose();
  }
}

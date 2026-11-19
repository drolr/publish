import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { emptyEditorPlaceholderSelector } from './content-evidence';
import type { ObservedRichBlock } from './rich-content-evidence';

// Mirrors page-contract.ts:96-99: one visible title box, one visible body. The
// role-tagged AI composer is deliberately not a body candidate.
const titleSelector = 'textarea';
const bodySelector = 'div[contenteditable="true"]:not([role])';
// page-contract.ts:199-231 / report.md §11.1: editor widgets are presentation.
const ignoredSelector = [
  'span.syl-placeholder.ProseMirror-widget',
  'img.ProseMirror-separator',
  'br.ProseMirror-trailingBreak',
].join(',');
const imageBlockSelector =
  'div[__syl_tag="true"][contenteditable="false"][draggable="true"]';
// Same salt as page-contract.ts:309-312 so image keys stay comparable to upload proof.
const resourceSalt = 'judongche:web_uri\0';

/**
 * Normalizes the production editor DOM into observed blocks.
 * A null result means the shape is unrecognized or ambiguous; callers fail closed.
 */
export async function readRichEditorBlocks(
  page: Page,
): Promise<ObservedRichBlock[] | null> {
  const before = page.url();
  try {
    const observed = await page.evaluate(
      ({
        titleSelector,
        bodySelector,
        ignoredSelector,
        imageBlockSelector,
        placeholderSelector,
      }) => {
        type Mark = 'bold' | 'italic' | 'underline';
        type RawRun = { type: 'text'; text: string; marks: Mark[] };
        type RawLeaf = { type: 'paragraph'; content: RawRun[] };
        type RawBlock =
          | { type: 'paragraph'; content: RawRun[] }
          | { type: 'heading'; content: RawRun[] }
          | { type: 'list'; kind: 'bullet'; items: RawLeaf[] }
          | { type: 'list'; kind: 'ordered'; start: number; items: RawLeaf[] }
          | { type: 'blockquote'; paragraphs: RawLeaf[] }
          | { type: 'image'; token: string; loaded: boolean };
        /** A list or quote whose leaves were all trailing padding. */
        type RawEmpty = { type: 'empty' };
        const styleVisible = (node: Element): boolean => {
          for (
            let cursor: Element | null = node;
            cursor;
            cursor = cursor.parentElement
          ) {
            const style = getComputedStyle(cursor);
            if (
              style.display === 'none' ||
              style.visibility !== 'visible' ||
              Number(style.opacity) === 0 ||
              cursor.hasAttribute('hidden')
            )
              return false;
          }
          return true;
        };
        const visibleWithBox = (node: Element): boolean => {
          if (!styleVisible(node)) return false;
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const titles = Array.from(
          document.querySelectorAll(titleSelector),
        ).filter(visibleWithBox);
        const bodies = Array.from(
          document.querySelectorAll<HTMLElement>(bodySelector),
        ).filter(visibleWithBox);
        if (titles.length !== 1 || bodies.length !== 1) return null;
        const root = bodies[0]!;

        const markOrder: Mark[] = ['bold', 'italic', 'underline'];
        const markByTag: Record<string, Mark | undefined> = {
          STRONG: 'bold',
          B: 'bold',
          EM: 'italic',
          I: 'italic',
          U: 'underline',
        };
        const normalizedMarks = (marks: Mark[]): Mark[] =>
          markOrder.filter((mark) => marks.includes(mark));
        const pushRun = (runs: RawRun[], text: string, marks: Mark[]) => {
          if (!text) return;
          const order = normalizedMarks(marks);
          const last = runs[runs.length - 1];
          if (
            last &&
            last.marks.length === order.length &&
            last.marks.every((mark, index) => mark === order[index])
          ) {
            last.text += text;
            return;
          }
          runs.push({ type: 'text', text, marks: order });
        };
        const readInline = (
          node: Node,
          marks: Mark[],
          runs: RawRun[],
        ): boolean => {
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
              pushRun(runs, child.nodeValue ?? '', marks);
              continue;
            }
            if (!(child instanceof Element)) continue;
            if (child.matches(ignoredSelector)) continue;
            if (child.tagName === 'BR') {
              pushRun(runs, '\n', marks);
              continue;
            }
            if (child.tagName === 'SPAN') {
              if (!readInline(child, marks, runs)) return false;
              continue;
            }
            const mark = markByTag[child.tagName];
            if (!mark) return false;
            if (!readInline(child, [...marks, mark], runs)) return false;
          }
          return true;
        };
        const readLeaf = (node: Node): RawLeaf | null => {
          const content: RawRun[] = [];
          if (!readInline(node, [], content)) return null;
          return { type: 'paragraph', content };
        };
        const isEmptyLeaf = (leaf: RawLeaf): boolean =>
          leaf.content.length === 0;
        const trimTrailingLeaves = (leaves: RawLeaf[]) => {
          while (leaves.length && isEmptyLeaf(leaves[leaves.length - 1]!))
            leaves.pop();
        };
        /** Children of a container: whitespace/comments are noise, text is an anomaly. */
        const childElements = (node: Element): Element[] | null => {
          const elements: Element[] = [];
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
              if (child.nodeValue?.trim()) return null;
              continue;
            }
            if (!(child instanceof Element)) continue;
            if (child.matches(ignoredSelector)) continue;
            elements.push(child);
          }
          return elements;
        };
        const resourceToken = (node: HTMLImageElement): string => {
          const attribute = node.getAttribute('web_uri');
          if (!attribute) return '';
          try {
            const url = new URL(node.currentSrc || node.src);
            return url.protocol === 'https:' &&
              url.searchParams.getAll('web_uri').length === 1 &&
              url.searchParams.get('web_uri') === attribute
              ? attribute
              : '';
          } catch {
            return '';
          }
        };
        const readImage = (node: Element): RawBlock | null => {
          if (!visibleWithBox(node)) return null;
          const visibleImages = Array.from(
            node.querySelectorAll<HTMLImageElement>('img'),
          ).filter(visibleWithBox);
          const displayed = Array.from(
            node.querySelectorAll<HTMLImageElement>(
              '.pgc-image .pgc-img-wrapper img',
            ),
          ).filter(visibleWithBox);
          if (
            visibleImages.length !== 1 ||
            displayed.length !== 1 ||
            visibleImages[0] !== displayed[0]
          )
            return null;
          const visible = displayed[0]!;
          const hidden = Array.from(
            node.querySelectorAll<HTMLImageElement>('templ img'),
          );
          const token = resourceToken(visible);
          return {
            type: 'image',
            token:
              hidden.length === 1 && resourceToken(hidden[0]!) === token
                ? token
                : '',
            loaded:
              visible.complete &&
              visible.naturalWidth > 0 &&
              visible.naturalHeight > 0,
          };
        };
        const readList = (node: Element): RawBlock | RawEmpty | null => {
          const kind = node.tagName === 'OL' ? 'ordered' : 'bullet';
          const children = childElements(node);
          if (!children) return null;
          const items: RawLeaf[] = [];
          for (const child of children) {
            if (child.tagName !== 'LI') return null;
            const leaf = readLeaf(child);
            if (!leaf) return null;
            items.push(leaf);
          }
          trimTrailingLeaves(items);
          if (!items.length) return { type: 'empty' };
          if (kind === 'bullet') return { type: 'list', kind, items };
          const attribute = node.getAttribute('start');
          const start =
            attribute === null || attribute === '' ? 1 : Number(attribute);
          if (
            !Number.isSafeInteger(start) ||
            start < 1 ||
            start + items.length - 1 > Number.MAX_SAFE_INTEGER
          )
            return null;
          return { type: 'list', kind, start, items };
        };
        const readBlockquote = (node: Element): RawBlock | RawEmpty | null => {
          const children = childElements(node);
          if (!children) return null;
          const paragraphs: RawLeaf[] = [];
          for (const child of children) {
            if (child.tagName !== 'P') return null;
            const leaf = readLeaf(child);
            if (!leaf) return null;
            paragraphs.push(leaf);
          }
          trimTrailingLeaves(paragraphs);
          if (!paragraphs.length) return { type: 'empty' };
          return { type: 'blockquote', paragraphs };
        };
        // E68: this widget trio is presentation, not body text.
        const isPlaceholder = (node: Element): boolean =>
          node.matches(placeholderSelector) &&
          node.childNodes.length === 3 &&
          node.children[0]?.childElementCount === 0 &&
          node.textContent === '请输入正文';

        const blocks: (RawBlock | RawEmpty)[] = [];
        for (const child of Array.from(root.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            if (child.nodeValue?.trim()) return null;
            continue;
          }
          if (!(child instanceof Element)) continue;
          if (child.matches(ignoredSelector)) continue;
          const tag = child.tagName;
          if (tag === 'P') {
            if (isPlaceholder(child)) continue;
            const leaf = readLeaf(child);
            if (!leaf) return null;
            blocks.push({ type: 'paragraph', content: leaf.content });
            continue;
          }
          if (/^H[1-6]$/.test(tag)) {
            const leaf = readLeaf(child);
            if (!leaf) return null;
            blocks.push({ type: 'heading', content: leaf.content });
            continue;
          }
          if (tag === 'UL' || tag === 'OL') {
            const block = readList(child);
            if (!block) return null;
            blocks.push(block);
            continue;
          }
          if (tag === 'BLOCKQUOTE') {
            const block = readBlockquote(child);
            if (!block) return null;
            blocks.push(block);
            continue;
          }
          if (child.matches(imageBlockSelector)) {
            const block = readImage(child);
            if (!block) return null;
            blocks.push(block);
            continue;
          }
          return null;
        }
        // report.md §11.4: the editor caret paragraph is not a document block.
        while (blocks.length) {
          const last = blocks[blocks.length - 1]!;
          if (
            last.type === 'empty' ||
            (last.type === 'paragraph' && last.content.length === 0)
          )
            blocks.pop();
          else break;
        }
        const result: RawBlock[] = [];
        for (const block of blocks) {
          if (block.type === 'empty') return null;
          result.push(block);
        }
        return result;
      },
      {
        titleSelector,
        bodySelector,
        ignoredSelector,
        imageBlockSelector,
        placeholderSelector: emptyEditorPlaceholderSelector,
      },
    );
    if (!observed || page.url() !== before) return null;
    return observed.map((block): ObservedRichBlock =>
      block.type === 'image'
        ? {
            type: 'image',
            resourceKey: block.token
              ? createHash('sha256')
                  .update(resourceSalt)
                  .update(block.token)
                  .digest('hex')
              : '',
            loaded: block.loaded,
          }
        : block,
    );
  } catch {
    return null;
  }
}

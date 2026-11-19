import type { RichInline, TextMark } from '../../contracts/rich-text-body';
import type {
  ConvertedRichBlock,
  RichPasteWarning,
} from '../../contracts/rich-web-paste';
import { WebPasteFailure } from '../../domain/web-paste-error';
import type { PasteNode, PasteElement } from './web-paste-parser';

const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const wrappers = new Set([
  'html',
  'body',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'figure',
  'figcaption',
]);
const unsupportedTags = new Set([
  'address',
  'center',
  'dl',
  'dt',
  'dd',
  'hr',
  'details',
  'summary',
  'menu',
  'math',
  'ruby',
  'rt',
  'rp',
]);
const normalizedInline = new Set([
  's',
  'strike',
  'del',
  'ins',
  'font',
  'small',
  'big',
  'sub',
  'sup',
  'code',
  'mark',
]);
const containers = new Set(['ol', 'ul', 'blockquote']);
const markOrder: TextMark[] = ['bold', 'italic', 'underline'];
const unsupported = (): never => {
  throw new WebPasteFailure('UNSUPPORTED_STRUCTURE');
};
const isElement = (node: PasteNode): node is PasteElement =>
  node.type === 'element';

/** Inert traversal: no DOM, CSSOM, URL resolution, scripts, or resource requests. */
export function normalizeRichNodes(nodes: readonly PasteNode[]): {
  blocks: ConvertedRichBlock[];
  warnings: RichPasteWarning[];
} {
  const warnings = new Set<RichPasteWarning>();
  function marksFor(
    node: PasteElement,
    inherited: readonly TextMark[],
  ): TextMark[] {
    const marks = new Set(inherited);
    if (node.name === 'b' || node.name === 'strong') marks.add('bold');
    if (node.name === 'i' || node.name === 'em') marks.add('italic');
    if (node.name === 'u') marks.add('underline');
    if (
      node.name === 'style' ||
      node.name === 'link' ||
      node.attributes.class ||
      normalizedInline.has(node.name) ||
      node.attributes.align ||
      node.attributes.color ||
      node.attributes.face ||
      node.attributes.size
    )
      warnings.add('STYLE_NORMALIZED');
    // Only a small explicit declaration grammar is evidence. Unknown CSS is
    // normalized with a warning, never evaluated or described as preserved.
    const priorities = new Map<string, boolean>();
    for (const declaration of (node.attributes.style ?? '').split(';')) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(':');
      if (colon < 0) {
        warnings.add('STYLE_NORMALIZED');
        continue;
      }
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const rawValue = declaration
        .slice(colon + 1)
        .trim()
        .toLowerCase();
      const important = /!important\s*$/.test(rawValue);
      const priorityKey =
        property === 'text-decoration' ? 'text-decoration-line' : property;
      if (priorities.get(priorityKey) && !important) continue;
      priorities.set(priorityKey, important);
      const value = rawValue.replace(/\s*!important\s*$/, '').trim();
      if (property.startsWith('counter-') || property === 'content')
        unsupported();
      if (property === 'list-style-position') {
        warnings.add('STYLE_NORMALIZED');
      } else if (property.startsWith('list-style')) {
        const tokens = value.split(/\s+/);
        const markers =
          property === 'list-style'
            ? tokens.filter(
                (token) => token !== 'inside' && token !== 'outside',
              )
            : tokens;
        const allowed = [
          'decimal',
          'decimal-leading-zero',
          'lower-alpha',
          'upper-alpha',
          'lower-latin',
          'upper-latin',
          'lower-roman',
          'upper-roman',
          'disc',
          'circle',
          'square',
        ];
        if (
          !['ol', 'ul', 'li'].includes(node.name) ||
          (property !== 'list-style-type' && property !== 'list-style') ||
          markers.length !== 1 ||
          !allowed.includes(markers[0])
        )
          unsupported();
        const defaultMarker =
          node.name === 'ol'
            ? 'decimal'
            : node.name === 'ul'
              ? 'disc'
              : undefined;
        if (tokens.length !== markers.length || markers[0] !== defaultMarker)
          warnings.add('STYLE_NORMALIZED');
      } else if (property === 'font-weight') {
        if (
          value === 'bold' ||
          value === 'bolder' ||
          /^(?:[6-9]\d{2}|1000)$/.test(value)
        )
          marks.add('bold');
        else if (value === 'normal' || /^(?:[1-4]\d{2}|500)$/.test(value))
          marks.delete('bold');
        else warnings.add('STYLE_NORMALIZED');
      } else if (property === 'font-style') {
        if (value === 'italic') marks.add('italic');
        else if (value === 'normal') marks.delete('italic');
        else warnings.add('STYLE_NORMALIZED');
      } else if (
        property === 'text-decoration' ||
        property === 'text-decoration-line'
      ) {
        if (value === 'none') marks.delete('underline');
        else if (value === 'underline') marks.add('underline');
        else {
          if (value.split(/\s+/).includes('underline')) marks.add('underline');
          warnings.add('STYLE_NORMALIZED');
        }
      } else warnings.add('STYLE_NORMALIZED');
    }
    return markOrder.filter((mark) => marks.has(mark));
  }
  // Validate all source nodes before emitting anything, including hidden trees.
  // HTML parser repairs must not turn an unsupported container into plain text.
  function preflight(
    list: readonly PasteNode[],
    scope: 'top' | 'list' | 'restricted' = 'top',
  ): void {
    for (const node of list) {
      if (!isElement(node)) {
        if (scope === 'list' && node.type === 'text' && node.text.trim())
          unsupported();
        continue;
      }
      if (unsupportedTags.has(node.name)) unsupported();
      marksFor(node, []);
      if (node.name === 'ol' || node.name === 'ul')
        validateList(node, node.children);
      if (scope === 'list' && node.name !== 'li') {
        if (!['script', 'style', 'head'].includes(node.name)) unsupported();
      }
      if (
        scope === 'restricted' &&
        (containers.has(node.name) ||
          headings.has(node.name) ||
          node.name === 'img')
      )
        unsupported();
      if (node.name === 'li' && scope !== 'list') unsupported();
      preflight(
        node.children,
        node.name === 'ol' || node.name === 'ul'
          ? 'list'
          : node.name === 'blockquote' || node.name === 'li'
            ? 'restricted'
            : scope,
      );
    }
  }
  preflight(nodes);
  const visible = (node: PasteNode) =>
    node.type !== 'comment' && !(isElement(node) && node.hidden);
  const meaningful = (node: PasteNode) =>
    visible(node) && !(node.type === 'text' && !node.text.trim());
  function inline(
    list: readonly PasteNode[],
    inherited: readonly TextMark[],
  ): RichInline[] {
    const result: RichInline[] = [];
    const append = (text: string, marks: TextMark[]) => {
      if (!text) return;
      const previous = result.at(-1);
      if (previous && previous.marks.join() === marks.join())
        previous.text += text;
      else result.push({ type: 'text', text, marks: [...marks] });
    };
    const visit = (list: readonly PasteNode[], marks: readonly TextMark[]) => {
      for (const node of list) {
        if (!visible(node)) {
          if (
            isElement(node) &&
            (node.name === 'style' || node.name === 'head')
          )
            warnings.add('STYLE_NORMALIZED');
          continue;
        }
        if (node.type === 'text') {
          append(node.text.replace(/[\t\r\n ]+/g, ' '), [...marks]);
          continue;
        }
        if (!isElement(node)) continue;
        if (node.name === 'br') append('\n', [...marks]);
        else {
          if (
            node.name === 'img' ||
            node.name === 'p' ||
            headings.has(node.name) ||
            containers.has(node.name) ||
            wrappers.has(node.name) ||
            node.name === 'li'
          )
            unsupported();
          visit(node.children, marksFor(node, marks));
        }
      }
    };
    visit(list, inherited);
    return tidy(result);
  }
  function tidy(result: RichInline[]): RichInline[] {
    // Collapse HTML whitespace across inline boundaries without erasing explicit
    // br runs or user-authored empty paragraphs. Plain input bypasses this path.
    let previousSpace = true;
    for (const run of result) {
      let text = '';
      for (const char of run.text) {
        if (char === ' ' && previousSpace) continue;
        text += char;
        previousSpace = char === ' ' || char === '\n';
      }
      run.text = text;
    }
    for (let index = result.length - 1; index >= 0; index--) {
      result[index].text = result[index].text.replace(/ +$/, '');
      if (result[index].text) break;
    }
    return result.filter((run) => run.text.length > 0);
  }
  function listItem(node: PasteElement, marks: TextMark[]) {
    const children = node.children.filter(meaningful);
    const paragraphs = children.filter(
      (child) => isElement(child) && child.name === 'p',
    );
    if (paragraphs.length) {
      if (paragraphs.length !== 1 || children.length !== 1) unsupported();
      const paragraph = paragraphs[0] as PasteElement;
      return {
        type: 'paragraph' as const,
        content: inline(paragraph.children, marksFor(paragraph, marks)),
      };
    }
    return {
      type: 'paragraph' as const,
      content: inline(node.children, marks),
    };
  }
  function positive(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value.trim())) unsupported();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) unsupported();
    return number;
  }
  // Shared source/output list validation: hidden source nodes are validated
  // before projection, and visible lists use the same numbering rules.
  function validateList(
    node: PasteElement,
    source: readonly PasteNode[],
  ): { start: number; items: PasteElement[] } {
    if (
      Object.hasOwn(node.attributes, 'reversed') ||
      (node.attributes.type !== undefined &&
        !(
          node.name === 'ol'
            ? ['1', 'a', 'A', 'i', 'I']
            : ['disc', 'circle', 'square']
        ).includes(node.attributes.type))
    )
      unsupported();
    const declaredStart = positive(node.attributes.start, 1);
    if (node.name === 'ul' && node.attributes.start !== undefined)
      unsupported();
    const children = source.filter((child) =>
      child.type === 'text'
        ? child.text.trim().length > 0
        : isElement(child) && !['head', 'script', 'style'].includes(child.name),
    );
    if (!children.length) unsupported();
    const items = children.map((child) => {
      if (!isElement(child) || child.name !== 'li') return unsupported();
      return child;
    });
    const start =
      node.name === 'ol'
        ? positive(items[0].attributes.value, declaredStart)
        : declaredStart;
    for (const [index, item] of items.entries()) {
      if (start > Number.MAX_SAFE_INTEGER - index) unsupported();
      if (
        item.attributes.value !== undefined &&
        (node.name === 'ul' ||
          positive(item.attributes.value, 1) !== start + index)
      )
        unsupported();
    }
    return { start, items };
  }
  function structural(
    node: PasteElement,
    marks: TextMark[],
  ): ConvertedRichBlock {
    if (node.name === 'ol' || node.name === 'ul') {
      if (
        node.name === 'ul' &&
        ['circle', 'square'].includes(node.attributes.type)
      )
        warnings.add('STYLE_NORMALIZED');
      if (
        node.name === 'ol' &&
        node.attributes.type !== undefined &&
        node.attributes.type !== '1'
      )
        warnings.add('STYLE_NORMALIZED');
      const { start, items: children } = validateList(
        node,
        node.children.filter(visible),
      );
      const items = children.map((child) =>
        listItem(child, marksFor(child, marks)),
      );
      return node.name === 'ol'
        ? { type: 'list', kind: 'ordered', start, items }
        : { type: 'list', kind: 'bullet', items };
    }
    const paragraphs: { type: 'paragraph'; content: RichInline[] }[] = [];
    let pending: PasteNode[] = [];
    const flush = () => {
      if (pending.some(meaningful))
        paragraphs.push({ type: 'paragraph', content: inline(pending, marks) });
      pending = [];
    };
    for (const child of node.children) {
      if (!visible(child)) continue;
      if (isElement(child) && child.name === 'p') {
        flush();
        paragraphs.push({
          type: 'paragraph',
          content: inline(child.children, marksFor(child, marks)),
        });
      } else pending.push(child);
    }
    flush();
    if (!paragraphs.length) paragraphs.push({ type: 'paragraph', content: [] });
    return { type: 'blockquote', paragraphs };
  }
  function top(
    list: readonly PasteNode[],
    marks: TextMark[],
    textType: 'paragraph' | 'heading' = 'paragraph',
    keepEmpty = false,
  ): ConvertedRichBlock[] {
    const blocks: ConvertedRichBlock[] = [];
    let pending: RichInline[] = [];
    const flush = () => {
      const content = tidy(pending);
      if (content.length) blocks.push({ type: textType, content });
      pending = [];
    };
    const visit = (list: readonly PasteNode[], inherited: TextMark[]) => {
      for (const node of list) {
        if (!visible(node)) {
          if (
            isElement(node) &&
            (node.name === 'style' || node.name === 'head')
          )
            warnings.add('STYLE_NORMALIZED');
          continue;
        }
        if (node.type === 'text') {
          pending.push({
            type: 'text',
            text: node.text.replace(/[\t\r\n ]+/g, ' '),
            marks: [...inherited],
          });
          continue;
        }
        if (!isElement(node)) continue;
        if (node.name === 'br')
          pending.push({ type: 'text', text: '\n', marks: [...inherited] });
        else if (node.name === 'img') {
          flush();
          blocks.push({ type: 'image', source: node.source });
        } else if (
          node.name === 'p' ||
          headings.has(node.name) ||
          wrappers.has(node.name) ||
          containers.has(node.name)
        ) {
          flush();
          const ownMarks = marksFor(node, inherited);
          if (containers.has(node.name))
            blocks.push(structural(node, ownMarks));
          else {
            const heading = headings.has(node.name);
            if (heading) warnings.add('HEADING_NORMALIZED');
            blocks.push(
              ...top(
                node.children,
                ownMarks,
                heading ? 'heading' : textType,
                node.name === 'p' || heading,
              ),
            );
          }
        } else if (node.name === 'li') unsupported();
        else visit(node.children, marksFor(node, inherited));
      }
    };
    visit(list, marks);
    flush();
    if (keepEmpty && blocks.length === 0)
      blocks.push({ type: textType, content: [] });
    return blocks;
  }
  const blocks = top(nodes, []);
  return {
    blocks,
    warnings: (['HEADING_NORMALIZED', 'STYLE_NORMALIZED'] as const).filter(
      (warning) => warnings.has(warning),
    ),
  };
}

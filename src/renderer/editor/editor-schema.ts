import { Schema } from 'prosemirror-model';
const keyed = { blockKey: { default: null } };
/** Deliberately closed structure: images at top level, one paragraph per list item. */
export const editorSchema = new Schema({
  nodes: {
    doc: {
      content:
        '(paragraph | heading | ordered_list | bullet_list | blockquote | article_image)*',
    },
    paragraph: {
      content: '(text | hard_break)*',
      attrs: keyed,
      toDOM: (node) => ['p', { 'data-block-key': node.attrs.blockKey }, 0],
    },
    heading: {
      content: '(text | hard_break)*',
      attrs: keyed,
      toDOM: (node) => ['h2', { 'data-block-key': node.attrs.blockKey }, 0],
    },
    ordered_list: {
      content: 'list_item+',
      attrs: { ...keyed, start: { default: 1 } },
      toDOM: (node) => [
        'ol',
        { start: node.attrs.start, 'data-block-key': node.attrs.blockKey },
        0,
      ],
    },
    bullet_list: {
      content: 'list_item+',
      attrs: keyed,
      toDOM: (node) => ['ul', { 'data-block-key': node.attrs.blockKey }, 0],
    },
    list_item: { content: 'paragraph', toDOM: () => ['li', 0] },
    blockquote: {
      content: 'paragraph+',
      attrs: keyed,
      toDOM: (node) => [
        'blockquote',
        { 'data-block-key': node.attrs.blockKey },
        0,
      ],
    },
    text: {},
    hard_break: { inline: true, selectable: false, toDOM: () => ['br'] },
    article_image: {
      atom: true,
      selectable: true,
      attrs: { blockKey: {} },
      toDOM: (node) => [
        'div',
        { 'data-block-key': node.attrs.blockKey, 'data-article-image': '' },
      ],
    },
  },
  marks: {
    bold: { toDOM: () => ['strong', 0] },
    italic: { toDOM: () => ['em', 0] },
    underline: { toDOM: () => ['u', 0] },
  },
});

import { Schema } from 'prosemirror-model';
/** No external HTML parser, marks, source URLs or image authorization in nodes. */
export const editorSchema = new Schema({
  nodes: {
    doc: { content: '(paragraph | article_image)*' },
    paragraph: {
      content: '(text | hard_break)*',
      attrs: { blockKey: { default: null } },
      toDOM: (node) => ['p', { 'data-block-key': node.attrs.blockKey }, 0],
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
});

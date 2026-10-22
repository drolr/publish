import { Parser, Tokenizer } from 'htmlparser2';
import {
  ConvertedPasteSchema,
  WebPasteInputSchema,
  webPasteLimits,
  type ConvertedBlock,
  type ConvertedPaste,
  type WebPasteInput,
} from '../../contracts/web-paste';
import { WebPasteFailure } from '../../domain/web-paste-error';

const forbidden = new Set([
  'table',
  'pre',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas',
  'svg',
  'form',
  'input',
  'textarea',
  'select',
  'button',
]);
const boundaries = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'li',
  'figcaption',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'figure',
]);
const ignored = new Set(['script', 'style', 'head']);
type Element = {
  type: 'element';
  name: string;
  hidden: boolean;
  source?: string;
  children: Node[];
};
type Node = Element | { type: 'text'; text: string } | { type: 'comment' };

/** htmlparser2 6.1.0 drops unfinished attributes/tags at EOF. Fail closed instead.
 * The pinned tokenizer exposes its states: Text=1, incomplete entities=62..66.
 * Entities at EOF are valid HTML text; unfinished markup is not a safe fragment.
 */
class FragmentTokenizer extends Tokenizer {
  override end(chunk?: string): void {
    if (chunk) this.write(chunk);
    if (this._state !== 1 && (this._state < 62 || this._state > 66))
      throw new WebPasteFailure('INVALID_FRAGMENT');
    super.end();
  }
}
function invalid(): never {
  throw new WebPasteFailure('INVALID_FRAGMENT');
}
const startMarker = '<!--StartFragment-->';
const endMarker = '<!--EndFragment-->';

function fragment(html: string): string {
  const bytes = Buffer.from(html, 'utf8');
  const boundary = (offset: number) =>
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= bytes.length &&
    (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80);
  let headerLength = 0;
  for (const line of html.split(/\r?\n/)) {
    if (!/^[A-Za-z][A-Za-z0-9]*:/.test(line)) break;
    const lineEnd = headerLength + line.length;
    headerLength =
      lineEnd + (html[lineEnd] === '\r' ? 2 : html[lineEnd] === '\n' ? 1 : 0);
  }
  const header = html.slice(0, headerLength);
  const offsets = new Map<string, number>();
  // This parses CF_HTML header metadata only, never HTML markup.
  for (const line of header.split(/\r?\n/)) {
    const field = /^(StartHTML|EndHTML|StartFragment|EndFragment):(.*)$/.exec(
      line,
    );
    if (!field) continue;
    if (offsets.has(field[1]) || !/^(?:\d+|-1)$/.test(field[2].trim()))
      invalid();
    const value = Number(field[2].trim());
    if (!Number.isSafeInteger(value)) invalid();
    offsets.set(field[1], value);
  }
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  const markers = start >= 0 || end >= 0;
  if (
    markers &&
    (start < 0 ||
      end < start + startMarker.length ||
      html.indexOf(startMarker, start + startMarker.length) >= 0 ||
      html.indexOf(endMarker, end + endMarker.length) >= 0)
  )
    invalid();
  const pair = (a: string, b: string): [number, number] | undefined => {
    const lower = offsets.get(a),
      upper = offsets.get(b);
    if (lower === undefined && upper === undefined) return undefined;
    if (lower === -1 && upper === -1) return undefined;
    if (
      lower === undefined ||
      upper === undefined ||
      !boundary(lower) ||
      !boundary(upper) ||
      lower > upper
    )
      invalid();
    return [lower, upper];
  };
  const htmlRange = pair('StartHTML', 'EndHTML');
  const fragmentRange = pair('StartFragment', 'EndFragment');
  if (htmlRange && htmlRange[0] < Buffer.byteLength(header)) invalid();
  if (fragmentRange && fragmentRange[0] < Buffer.byteLength(header)) invalid();
  if (
    fragmentRange &&
    htmlRange &&
    (fragmentRange[0] < htmlRange[0] || fragmentRange[1] > htmlRange[1])
  )
    invalid();
  if (markers) {
    const markerRange: [number, number] = [
      Buffer.byteLength(html.slice(0, start + startMarker.length)),
      Buffer.byteLength(html.slice(0, end)),
    ];
    if (
      fragmentRange &&
      (fragmentRange[0] !== markerRange[0] ||
        fragmentRange[1] !== markerRange[1])
    )
      invalid();
    if (
      htmlRange &&
      (Buffer.byteLength(html.slice(0, start)) < htmlRange[0] ||
        Buffer.byteLength(html.slice(0, end + endMarker.length)) > htmlRange[1])
    )
      invalid();
    return html.slice(start + startMarker.length, end);
  }
  if (fragmentRange) return bytes.subarray(...fragmentRange).toString('utf8');
  if (htmlRange) return bytes.subarray(...htmlRange).toString('utf8');
  if (offsets.size) invalid();
  return html;
}

function parse(html: string): Node[] {
  const root: Node[] = [];
  const stack: Element[] = [];
  let nodes = 0;
  let pendingTag = false;
  const count = () => {
    if (++nodes > webPasteLimits.nodes)
      throw new WebPasteFailure('PARSE_LIMIT');
  };
  const children = () => stack.at(-1)?.children ?? root;
  const parser = new Parser(
    {
      onopentagname(name) {
        if (forbidden.has(name))
          throw new WebPasteFailure('UNSUPPORTED_STRUCTURE');
        count();
        if (stack.length + 1 > webPasteLimits.depth)
          throw new WebPasteFailure('PARSE_LIMIT');
        pendingTag = true;
      },
      onopentag(name, attributes) {
        const node: Element = {
          type: 'element',
          name,
          hidden:
            ignored.has(name) ||
            Object.hasOwn(attributes, 'hidden') ||
            attributes['aria-hidden']?.toLowerCase() === 'true',
          source: name === 'img' ? attributes.src : undefined,
          children: [],
        };
        children().push(node);
        stack.push(node);
        pendingTag = false;
      },
      onclosetag() {
        stack.pop();
      },
      ontext(text) {
        const list = children();
        const last = list.at(-1);
        if (last?.type === 'text') last.text += text;
        else {
          count();
          list.push({ type: 'text', text });
        }
      },
      oncomment() {
        count();
        children().push({ type: 'comment' });
      },
      onprocessinginstruction() {
        count();
        children().push({ type: 'comment' });
      },
      onerror() {
        invalid();
      },
    },
    {
      xmlMode: false,
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      Tokenizer: FragmentTokenizer,
    },
  );
  parser.end(html);
  if (pendingTag) invalid();
  return root;
}

function normalize(nodes: readonly Node[]): ConvertedBlock[] {
  const blocks: ConvertedBlock[] = [];
  let text = '';
  const flush = () => {
    const paragraph = text.replace(/ +/g, ' ').replace(/^[ \n]+|[ \n]+$/g, '');
    text = '';
    if (paragraph.trim().length > 0)
      blocks.push({ type: 'paragraph', text: paragraph });
    if (blocks.length > webPasteLimits.blocks)
      throw new WebPasteFailure('PARSE_LIMIT');
  };
  const visit = (list: readonly Node[]) => {
    for (const node of list) {
      if (node.type === 'text') {
        text += node.text.replace(/[ \t\r\n\u00a0]+/g, ' ');
        continue;
      }
      if (node.type === 'comment' || node.hidden) continue;
      if (node.name === 'img') {
        flush();
        blocks.push({ type: 'image', source: node.source });
      } else if (node.name === 'br') text += '\n';
      else {
        if (boundaries.has(node.name)) flush();
        visit(node.children);
        if (boundaries.has(node.name)) flush();
      }
    }
  };
  visit(nodes);
  flush();
  return blocks;
}

export function convertWebPaste(input: WebPasteInput): ConvertedPaste {
  const validated = WebPasteInputSchema.safeParse(input);
  if (!validated.success) throw new WebPasteFailure('INPUT_LIMIT');
  const { html, plain } = validated.data;
  const plainOnly = html.length === 0;
  const blocks: ConvertedBlock[] = plainOnly
    ? plain
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .filter((text) => text.trim().length > 0)
        .map((text) => ({ type: 'paragraph', text }))
    : normalize(parse(fragment(html)));
  if (!blocks.length) throw new WebPasteFailure('EMPTY');
  const result = ConvertedPasteSchema.safeParse({ blocks, plainOnly });
  if (!result.success) throw new WebPasteFailure('PARSE_LIMIT');
  return result.data;
}

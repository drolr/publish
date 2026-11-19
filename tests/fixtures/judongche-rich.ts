import type { BrowserContext, Page } from '@playwright/test';
import type { JudongchePages } from '../../src/infrastructure/platforms/judongche/page-contract';
import type {
  RichEditorEvidence,
  ObservedRichBlock,
} from '../../src/infrastructure/platforms/judongche/rich-content-evidence';
import { unknownEditorEvidence } from '../../src/infrastructure/platforms/judongche/content-evidence';
import {
  appendRichTextBlock,
  type RichTextUiPort,
} from '../../src/infrastructure/platforms/judongche/production-rich-text';
import { JudongchePageError } from '../../src/infrastructure/platforms/judongche/page-contract';
import { makeDraftTask } from './draft-task';
const url = 'https://www.autoengine.com/jdc/dealer/info/Article';
/** Synthetic normal-UI fixture only. These tags, controls and gestures assert no production mapping. */
const html = `<!doctype html><html><body data-state="ready"><input aria-label="Title"><input aria-label="List start" value="1">
<button data-kind="paragraph">Paragraph</button><button data-kind="heading">Heading</button><button data-kind="ordered_list">Ordered list</button><button data-kind="bullet_list">Bullet list</button><button data-kind="blockquote">Quote</button>
<button data-mark="bold" aria-pressed="false">Bold</button><button data-mark="italic" aria-pressed="false">Italic</button><button data-mark="underline" aria-pressed="false">Underline</button><button id="reset">Reset format</button><button id="exit">Exit block</button><main id="body"></main>
<script>
(()=>{let active=null,container=null;const marks=new Set();
const focus=()=>{if(active){active.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(active);range.collapse(false);selection.removeAllRanges();selection.addRange(range);}};
const leaf=()=>{const node=document.createElement('p');node.contentEditable='true';if(container.tagName==='OL'||container.tagName==='UL'){const item=document.createElement('li');container.append(item);item.append(node);}else container.append(node);active=node;focus();};
const text=value=>{if(!active)return;const node=document.createElement('span');let target=node;for(const mark of ['bold','italic','underline'])if(marks.has(mark)){const tag=document.createElement({bold:'strong',italic:'em',underline:'u'}[mark]);target.append(tag);target=tag;}target.textContent=value;active.append(node);focus();};
for(const button of document.querySelectorAll('[data-kind]'))button.onclick=()=>{const kind=button.dataset.kind,tag={paragraph:'p',heading:'h2',ordered_list:'ol',bullet_list:'ul',blockquote:'blockquote'}[kind];container=document.createElement(tag);container.dataset.kind=kind;document.querySelector('main').append(container);if(kind==='ordered_list')container.setAttribute('start',document.querySelector('[aria-label="List start"]').value);if(kind==='paragraph'||kind==='heading'){active=container;active.contentEditable='true';focus();}else leaf();};
for(const button of document.querySelectorAll('[data-mark]'))button.onclick=()=>{const mark=button.dataset.mark;marks.has(mark)?marks.delete(mark):marks.add(mark);button.setAttribute('aria-pressed',String(marks.has(mark)));focus();};
document.querySelector('#reset').onclick=()=>{marks.clear();for(const button of document.querySelectorAll('[data-mark]'))button.setAttribute('aria-pressed','false');focus();};
document.querySelector('#exit').onclick=()=>{active=null;container=null;};
document.querySelector('main').addEventListener('beforeinput',event=>{event.preventDefault();if(event.inputType==='insertText')text(event.data||'');});
document.querySelector('main').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();if(event.shiftKey)text(String.fromCharCode(10));else leaf();}});
})();</script></body></html>`;
export async function installRichFixture(context: BrowserContext, page: Page) {
  await context.route('https://www.autoengine.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(url);
  const store = makeDraftTask().store;
  let saves = 0,
    enters = 0,
    remote: RichEditorEvidence['remote'] = null;
  const guard = async () => {
    const state = await page.locator('body').getAttribute('data-state');
    if (state === 'login') throw new JudongchePageError('LOGIN_REQUIRED');
    if (state !== 'ready' || page.url() !== url)
      throw new JudongchePageError('PAGE_CHANGED');
  };
  const port: RichTextUiPort = {
    guard,
    resetFormat: async () => {
      await page.locator('#reset').click();
    },
    selectBlock: async (kind, start) => {
      if (start !== undefined) {
        await page
          .getByRole('textbox', { name: 'List start', exact: true })
          .fill(String(start));
        await guard();
      }
      await page.locator('button[data-kind="' + kind + '"]').click();
    },
    setMark: async (mark, active) => {
      const button = page.locator('[data-mark="' + mark + '"]');
      if ((await button.getAttribute('aria-pressed')) !== String(active))
        await button.click();
    },
    typeText: async (text) => {
      await page.keyboard.insertText(text);
    },
    softBreak: async () => {
      await page.keyboard.press('Shift+Enter');
    },
    nextTextLeaf: async () => {
      await page.keyboard.press('Enter');
    },
    exitBlock: async () => {
      await page.locator('#exit').click();
    },
  };
  const read = async (): Promise<RichEditorEvidence> => {
    await guard();
    const rich = await page.locator('main').evaluate((main) => {
      let formatKnown = true;
      // This owned fixture has no author CSS. An unrecognized cascade cannot prove marks.
      if (
        document.querySelector('style,link[rel~="stylesheet"]') ||
        document.styleSheets.length ||
        document.adoptedStyleSheets.length
      )
        formatKnown = false;
      const attributesKnown = (
        element: Element,
        allowed: Record<string, string | undefined>,
      ) => {
        if (
          element.shadowRoot ||
          Array.from(element.attributes).some(
            (attribute) =>
              !Object.prototype.hasOwnProperty.call(allowed, attribute.name) ||
              (allowed[attribute.name] !== undefined &&
                allowed[attribute.name] !== attribute.value),
          )
        )
          formatKnown = false;
      };
      attributesKnown(document.documentElement, {});
      attributesKnown(document.body, { 'data-state': 'ready' });
      attributesKnown(main, { id: 'body' });
      // Consume every direct node at every structural boundary; no text/comment is discarded as layout.
      const directElements = (
        parent: Element,
        tags: readonly string[],
      ): Element[] => {
        const elements: Element[] = [];
        for (const node of Array.from(parent.childNodes)) {
          if (node instanceof Element && tags.includes(node.tagName))
            elements.push(node);
          else if (!(
            node.nodeType === Node.TEXT_NODE && node.textContent === ''
          ))
            formatKnown = false;
        }
        return elements;
      };
      type Mark = 'bold' | 'italic' | 'underline';
      const paragraph = (p: Element) => {
        attributesKnown(p, {
          contenteditable: 'true',
          'data-kind': p.tagName === 'H2' ? 'heading' : 'paragraph',
        });
        const content: { type: 'text'; text: string; marks: Mark[] }[] = [];
        const visit = (node: Node, marks: Mark[]) => {
          if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent)
              content.push({ type: 'text', text: node.textContent, marks });
            return;
          }
          if (
            !(node instanceof HTMLElement) ||
            !['SPAN', 'STRONG', 'EM', 'U'].includes(node.tagName)
          ) {
            formatKnown = false;
            return;
          }
          attributesKnown(node, {});
          const mark: Mark | undefined =
            node.tagName === 'STRONG'
              ? 'bold'
              : node.tagName === 'EM'
                ? 'italic'
                : node.tagName === 'U'
                  ? 'underline'
                  : undefined;
          for (const child of Array.from(node.childNodes))
            visit(child, mark ? [...marks, mark] : marks);
        };
        for (const child of Array.from(p.childNodes)) visit(child, []);
        return { type: 'paragraph' as const, content };
      };
      const blocks = directElements(main, [
        'P',
        'H2',
        'OL',
        'UL',
        'BLOCKQUOTE',
        'IMG',
      ]).map((node) => {
        if (node.tagName === 'P') return paragraph(node);
        if (node.tagName === 'H2')
          return { ...paragraph(node), type: 'heading' as const };
        if (node.tagName === 'OL' || node.tagName === 'UL') {
          attributesKnown(node, {
            'data-kind': node.tagName === 'OL' ? 'ordered_list' : 'bullet_list',
            ...(node.tagName === 'OL' ? { start: undefined } : {}),
          });
          if (
            node.tagName === 'OL' &&
            !/^[1-9][0-9]*$/.test(node.getAttribute('start') ?? '')
          )
            formatKnown = false;
          return {
            type: 'list' as const,
            kind:
              node.tagName === 'OL'
                ? ('ordered' as const)
                : ('bullet' as const),
            ...(node.tagName === 'OL'
              ? { start: Number(node.getAttribute('start')) }
              : {}),
            items: directElements(node, ['LI']).map((item) => {
              attributesKnown(item, {});
              const paragraphs = directElements(item, ['P']);
              if (paragraphs.length !== 1) formatKnown = false;
              return paragraphs[0]
                ? paragraph(paragraphs[0])
                : { type: 'paragraph' as const, content: [] };
            }),
          };
        }
        if (node.tagName === 'BLOCKQUOTE') {
          attributesKnown(node, { 'data-kind': 'blockquote' });
          return {
            type: 'blockquote' as const,
            paragraphs: directElements(node, ['P']).map(paragraph),
          };
        }
        attributesKnown(node, {
          'data-resource': undefined,
          'data-loaded': undefined,
        });
        if (node.childNodes.length) formatKnown = false;
        return {
          type: 'image' as const,
          resourceKey: node.getAttribute('data-resource') || '',
          loaded: node.getAttribute('data-loaded') === 'true',
        };
      });
      return { formatKnown, blocks };
    });
    return {
      ...unknownEditorEvidence(),
      known: true,
      store,
      remote,
      isDraft: !!remote,
      title: await page
        .getByRole('textbox', { name: 'Title', exact: true })
        .inputValue(),
      pendingUploads: false,
      contextKey: 'synthetic-rich-context',
      editorUrl: remote?.editUrl ?? url,
      rich: rich as { formatKnown: boolean; blocks: ObservedRichBlock[] },
    };
  };
  const pages: JudongchePages = {
    probe: async () => {
      await guard();
      return {
        status: 'ready',
        store,
        generation: '11111111-1111-4111-8111-111111111111',
      };
    },
    inspectEditor: async () => {
      throw Error('V2 cannot use legacy evidence');
    },
    inspectDraft: async () => {
      throw Error('V2 cannot use legacy evidence');
    },
    inspectRichEditor: read,
    inspectRichDraft: async () => read(),
    locateDraft: async () => remote ?? undefined,
    enterNewEditor: async () => {
      enters++;
      remote = null;
      await page.goto(url);
    },
    fillTitle: async (title) => {
      await page
        .getByRole('textbox', { name: 'Title', exact: true })
        .fill(title);
    },
    appendParagraph: async () => {
      throw Error('V2 cannot use legacy writer');
    },
    appendTextBlock: (block, stopped) =>
      appendRichTextBlock(port, block, stopped),
    appendImage: async () => {
      throw Error('image fixture requires explicit resource binding');
    },
    chooseFirstCover: async () => {
      throw Error('no cover operation');
    },
    saveOnce: async () => {
      saves++;
      remote = {
        recordKey: 'synthetic-record',
        editUrl: url + '?pgc_id=synthetic-record',
      };
    },
  };
  return { pages, port, read, store, saves: () => saves, enters: () => enters };
}

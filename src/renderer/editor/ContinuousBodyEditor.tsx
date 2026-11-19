import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorState,
  AllSelection,
  NodeSelection,
  Plugin,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { baseKeymap } from 'prosemirror-commands';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import {
  isManualImageBlock,
  type ManualDraft,
} from '../../contracts/manual-article';
import type {
  DraftRange,
  InternalPasteInput,
} from '../../contracts/manual-edit';
import type { WebPasteInput } from '../../contracts/web-paste';
import { parseManualClipboardFragment } from '../../contracts/editor-close';
import { editorSchema } from './editor-schema';
import {
  documentPatch,
  draftV2ToEditor,
  editorToDraftV2,
  emptyEditorKey,
  rangeFromSelection,
} from './editor-codec';
import {
  InlineArticleImage,
  InlinePreviewPool,
  type ImageProjection,
} from './InlineArticleImage';
import { RichTextToolbar } from './RichTextToolbar';
import {
  applyRichEditorCommand,
  readRichToolbarState,
  richEditorEnter,
  richEditorBackspace,
  richEditorSoftBreak,
  type RichEditorCommand,
} from './editor-commands';
import './editor.css';
/** Attribute-only decorations keep safe-integer labels outside text/clipboard/AST. */
export const orderedEditorMarkers = new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (
          node.type.name !== 'ordered_list' ||
          node.attrs.start + node.childCount - 1 <= 2147483647
        )
          return;
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: 'editor-ordered-list',
            role: 'list',
          }),
        );
        node.forEach((item, offset, index) =>
          decorations.push(
            Decoration.node(
              pos + 1 + offset,
              pos + 1 + offset + item.nodeSize,
              {
                'data-editor-ordinal': String(node.attrs.start + index),
                role: 'listitem',
              },
            ),
          ),
        );
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
});
export const keyedEditorBlocks = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((t) => t.docChanged)) return null;
    const seen = new Set<string>();
    let tr: Transaction | undefined;
    state.doc.descendants((node, pos) => {
      const key = node.attrs.blockKey;
      if (
        [
          'paragraph',
          'heading',
          'ordered_list',
          'bullet_list',
          'blockquote',
        ].includes(node.type.name) &&
        (!key || key === emptyEditorKey || seen.has(key))
      ) {
        tr ??= state.tr;
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          blockKey: crypto.randomUUID(),
        });
      } else if (key) seen.add(key);
    });
    return tr ?? null;
  },
});
/** Selection is a transient view projection, never a document edit or history event. */
function synchronizeNativeSelection(
  editor: EditorView,
  publish: (range: DraftRange) => void,
) {
  if (!editor.hasFocus()) return;
  const selected = editor.dom.ownerDocument.getSelection();
  if (
    !selected?.anchorNode ||
    !selected.focusNode ||
    !editor.dom.contains(selected.anchorNode) ||
    !editor.dom.contains(selected.focusNode)
  )
    return;
  const anchor = editor.posAtDOM(selected.anchorNode, selected.anchorOffset),
    head = editor.posAtDOM(selected.focusNode, selected.focusOffset);
  if (
    anchor === editor.state.selection.anchor &&
    head === editor.state.selection.head
  )
    return;
  const doc = editor.state.doc,
    from = Math.min(anchor, head),
    to = Math.max(anchor, head),
    node = doc.nodeAt(from);
  const selection =
    node &&
    node.isAtom &&
    NodeSelection.isSelectable(node) &&
    to - from === node.nodeSize
      ? NodeSelection.create(doc, from)
      : from === 0 && to === doc.content.size
        ? new AllSelection(doc)
        : TextSelection.between(doc.resolve(anchor), doc.resolve(head));
  editor.updateState(
    editor.state.apply(
      editor.state.tr.setSelection(selection).setMeta('addToHistory', false),
    ),
  );
  publish(rangeFromSelection(editor.state.doc, editor.state.selection));
}
export function ContinuousBodyEditor(props: {
  beforeBody?: React.ReactNode;
  onInsertImage?: () => void;
  session: string;
  draft: ManualDraft;
  imageProjection: ImageProjection[];
  editable: boolean;
  onTransaction: (draft: ManualDraft, composing: boolean) => void;
  onPaste: (input: WebPasteInput | InternalPasteInput) => void;
  onCopyCut: (cut: boolean) => void;
  onRangeChange: (range: DraftRange) => void;
}) {
  const [toolbar, setToolbar] = useState(() => ({
    format: readRichToolbarState(EditorState.create({ schema: editorSchema })),
    canUndo: false,
    canRedo: false,
  }));
  const queuedCommands = useRef<RichEditorCommand[]>([]);
  const plainPasteUntil = useRef(0);
  function updateToolbar(editor: EditorView) {
    setToolbar({
      format: readRichToolbarState(editor.state),
      canUndo: undo(editor.state),
      canRedo: redo(editor.state),
    });
  }
  function executeCommand(command: RichEditorCommand) {
    const editor = view.current;
    if (!editor || !latest.current.editable) return;
    if (composition.current || editor.composing) {
      queuedCommands.current.push(command);
      return;
    }
    synchronizeNativeSelection(editor, (range) => {
      latest.current.onRangeChange(range);
      updateToolbar(editor);
    });
    applyRichEditorCommand(editor, command);
    updateToolbar(editor);
    editor.focus();
  }
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const images = useRef(new Map<string, ManualDraft['blocks'][number]>());
  const roots = useRef(new Map<string, Root>());
  const pool = useRef<InlinePreviewPool | undefined>(undefined);
  const composition = useRef(false),
    endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const compositionGeneration = useRef(0);
  for (const block of props.draft.blocks)
    if (isManualImageBlock(block)) images.current.set(block.blockKey, block);
  // Title input may temporarily violate the contract. Validate the body projection
  // independently, then return the raw title to the existing session validator.
  function readDraft(doc: EditorState['doc']) {
    const raw = latest.current.draft;
    const body = editorToDraftV2(doc, { ...raw, title: '' }, [
      ...images.current.values(),
    ]);
    return { ...raw, blocks: body.blocks };
  }
  function projection(key: string) {
    return (
      latest.current.imageProjection.find((p) => p.blockKey === key) ?? {
        blockKey: key,
        disabled: !latest.current.editable,
      }
    );
  }
  useEffect(() => {
    if (!host.current) return;
    images.current = new Map(
      latest.current.draft.blocks
        .filter(isManualImageBlock)
        .map((b) => [b.blockKey, b]),
    );
    const previews = new InlinePreviewPool(
      props.beforeBody
        ? (host.current.closest<HTMLElement>('main') ?? host.current)
        : host.current,
    );
    pool.current = previews;
    const renderImage = (key: string, root: Root) =>
      root.render(
        <InlineArticleImage
          sessionId={latest.current.session}
          projection={projection(key)}
          pool={previews}
        />,
      );
    let nativeNavigation = false;
    const editor = new EditorView(host.current, {
      state: EditorState.create({
        schema: editorSchema,
        doc: draftV2ToEditor({ ...latest.current.draft, title: '' }),
        plugins: [
          keyedEditorBlocks,
          orderedEditorMarkers,
          history({ depth: 100, newGroupDelay: 500 }),
          keymap({
            'Mod-z': () => {
              executeCommand({ type: 'undo' });
              return true;
            },
            'Mod-y': () => {
              executeCommand({ type: 'redo' });
              return true;
            },
            'Mod-Shift-z': () => {
              executeCommand({ type: 'redo' });
              return true;
            },
            'Mod-b': () => {
              executeCommand({ type: 'toggleMark', mark: 'bold' });
              return true;
            },
            'Mod-i': () => {
              executeCommand({ type: 'toggleMark', mark: 'italic' });
              return true;
            },
            'Mod-u': () => {
              executeCommand({ type: 'toggleMark', mark: 'underline' });
              return true;
            },
            'Shift-Enter': richEditorSoftBreak,
            Enter: (state, dispatch) => {
              if (richEditorEnter(state, dispatch)) return true;
              // A closed list/quote cannot fall through to generic splitting,
              // including an overflow refusal at MAX_SAFE_INTEGER.
              for (let depth = state.selection.$from.depth; depth > 0; depth--)
                if (
                  ['list_item', 'blockquote'].includes(
                    state.selection.$from.node(depth).type.name,
                  )
                )
                  return true;
              return false;
            },
            Backspace: (state, dispatch) =>
              richEditorBackspace(state, dispatch),
          }),
          keymap(baseKeymap),
        ],
      }),
      attributes: {
        role: 'textbox',
        // Stay focusable while operation safety freezes contentEditable.
        tabindex: '0',
        'aria-label': '文章正文',
        'aria-multiline': 'true',
        'aria-readonly': String(!latest.current.editable),
      },
      editable: () => latest.current.editable,
      handleKeyDown() {
        if (composition.current || editor.composing) return false;
        synchronizeNativeSelection(editor, (range) => {
          latest.current.onRangeChange(range);
          updateToolbar(editor);
        });
        return false;
      },
      dispatchTransaction(tr) {
        if (tr.docChanged && !latest.current.editable && !composition.current)
          return;
        const state = editor.state.apply(tr);
        editor.updateState(state);
        updateToolbar(editor);
        latest.current.onRangeChange(
          rangeFromSelection(state.doc, state.selection),
        );
        if (tr.docChanged)
          latest.current.onTransaction(
            readDraft(state.doc),
            composition.current,
          );
      },
      nodeViews: {
        article_image(node) {
          const key = node.attrs.blockKey as string;
          const dom = document.createElement('div');
          dom.contentEditable = 'false';
          dom.dataset.blockKey = key;
          const root = createRoot(dom);
          roots.current.set(key, root);
          renderImage(key, root);
          return {
            dom,
            update(next) {
              if (next.type !== node.type || next.attrs.blockKey !== key)
                return false;
              renderImage(key, root);
              return true;
            },
            stopEvent: (event) =>
              event.target instanceof HTMLElement &&
              !!event.target.closest('button'),
            ignoreMutation: () => true,
            destroy() {
              roots.current.delete(key);
              queueMicrotask(() => root.unmount());
            },
          };
        },
      },
      handleDOMEvents: {
        focus() {
          // The browser may reset DOM selection on refocus. Align the retained
          // view caret immediately, before a projection can accept that reset.
          if (
            editor.hasFocus() &&
            editor.dom.ownerDocument.hasFocus() &&
            latest.current.editable &&
            !composition.current &&
            !editor.composing
          )
            editor.focus();
          return false;
        },
        keydown(_view, event) {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === 'v'
          )
            plainPasteUntil.current = Date.now() + 1500;
          else if (!['Control', 'Meta', 'Shift'].includes(event.key))
            plainPasteUntil.current = 0;
          if (
            composition.current ||
            editor.composing ||
            !latest.current.editable
          )
            return false;
          // Only native navigation makes a focus-reset position deliberate.
          nativeNavigation =
            /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(
              event.key,
            );
          return false;
        },
        keyup() {
          if (
            nativeNavigation &&
            !composition.current &&
            !editor.composing &&
            latest.current.editable
          )
            synchronizeNativeSelection(editor, (range) => {
              latest.current.onRangeChange(range);
              updateToolbar(editor);
            });
          nativeNavigation = false;
          return false;
        },
        blur() {
          nativeNavigation = false;
          return false;
        },
        compositionstart() {
          clearTimeout(endTimer.current);
          endTimer.current = undefined;
          compositionGeneration.current++;
          composition.current = true;
          latest.current.onTransaction(readDraft(editor.state.doc), true);
          return false;
        },
        compositionend() {
          clearTimeout(endTimer.current);
          const generation = compositionGeneration.current;
          endTimer.current = setTimeout(() => {
            if (
              view.current !== editor ||
              generation !== compositionGeneration.current
            )
              return;
            endTimer.current = undefined;
            composition.current = false;
            // Browser composition mutations are settled before any toolbar action.
            const commands = queuedCommands.current.splice(0);
            for (const command of commands) executeCommand(command);
            updateToolbar(editor);
            latest.current.onTransaction(readDraft(editor.state.doc), false);
          }, 30);
          return false;
        },
        paste(_view, event) {
          event.preventDefault();
          if (
            !latest.current.editable ||
            composition.current ||
            editor.composing
          )
            return true;
          const pure = Date.now() < plainPasteUntil.current;
          plainPasteUntil.current = 0;
          const html = pure
              ? ''
              : (event.clipboardData?.getData('text/html') ?? ''),
            plain = event.clipboardData?.getData('text/plain') ?? '';
          const grantId = parseManualClipboardFragment(html);
          captureActiveRange();
          latest.current.onPaste(
            grantId ? { kind: 'internal', grantId } : { html, plain },
          );
          return true;
        },
        copy(_view, event) {
          event.preventDefault();
          if (captureActiveRange()) latest.current.onCopyCut(false);
          return true;
        },
        cut(_view, event) {
          event.preventDefault();
          const selected = captureActiveRange();
          if (latest.current.editable && selected)
            latest.current.onCopyCut(true);
          return true;
        },
        drop(_view, event) {
          event.preventDefault();
          return true;
        },
      },
    });
    function captureActiveRange() {
      const selected = editor.dom.ownerDocument.getSelection();
      if (
        selected?.anchorNode &&
        selected.focusNode &&
        editor.dom.contains(selected.anchorNode) &&
        editor.dom.contains(selected.focusNode)
      ) {
        latest.current.onRangeChange(
          rangeFromSelection(editor.state.doc, {
            anchor: editor.posAtDOM(selected.anchorNode, selected.anchorOffset),
            head: editor.posAtDOM(selected.focusNode, selected.focusOffset),
          }),
        );
        return !selected.isCollapsed;
      } else {
        latest.current.onRangeChange(
          rangeFromSelection(editor.state.doc, editor.state.selection),
        );
        return !editor.state.selection.empty;
      }
    }
    const observeNativeNavigation = () => {
      if (
        nativeNavigation &&
        latest.current.editable &&
        !composition.current &&
        !editor.composing
      )
        synchronizeNativeSelection(editor, (range) => {
          latest.current.onRangeChange(range);
          updateToolbar(editor);
        });
    };
    // Capture navigation selection before the library's focus-reset recovery.
    const ownerDocument = editor.dom.ownerDocument;
    ownerDocument.addEventListener(
      'selectionchange',
      observeNativeNavigation,
      true,
    );
    view.current = editor;
    const scrollport = props.beforeBody
      ? host.current.closest<HTMLElement>('main')
      : null;
    const toolElement = host.current
      .closest('.rich-body-editor')
      ?.querySelector<HTMLElement>('.rich-text-tools');
    const resizeTools = () => {
      if (!scrollport || !toolElement) return;
      const top = Math.ceil(toolElement.getBoundingClientRect().height) + 16;
      scrollport.style.setProperty('--focused-toolbar-height', top + 'px');
      editor.setProps({
        scrollThreshold: { top, bottom: 20, left: 0, right: 0 },
        scrollMargin: { top, bottom: 20, left: 0, right: 0 },
      });
    };
    resizeTools();
    const toolResize = new ResizeObserver(resizeTools);
    if (scrollport && toolElement) toolResize.observe(toolElement);
    updateToolbar(editor);
    latest.current.onRangeChange(
      rangeFromSelection(editor.state.doc, editor.state.selection),
    );
    editor.focus();
    return () => {
      clearTimeout(endTimer.current);
      endTimer.current = undefined;
      compositionGeneration.current++;
      composition.current = false;
      queuedCommands.current = [];
      plainPasteUntil.current = 0;
      view.current = undefined;
      ownerDocument.removeEventListener(
        'selectionchange',
        observeNativeNavigation,
        true,
      );
      editor.destroy();
      toolResize.disconnect();
      scrollport?.style.removeProperty('--focused-toolbar-height');
      previews.dispose();
      roots.current.clear();
    };
  }, [props.session]);
  // Complete projection changes in the commit before another native edit can
  // make a captured draft stale and turn its echo into a new history event.
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (composition.current || editor.composing) return;
    synchronizeNativeSelection(editor, (range) => {
      latest.current.onRangeChange(range);
      updateToolbar(editor);
    });
    editor.setProps({
      editable: () => latest.current.editable,
      attributes: {
        role: 'textbox',
        // Stay focusable while operation safety freezes contentEditable.
        tabindex: '0',
        'aria-label': '文章正文',
        'aria-multiline': 'true',
        'aria-readonly': String(!props.editable),
      },
    });
    for (const [key, root] of roots.current)
      if (pool.current)
        root.render(
          <InlineArticleImage
            sessionId={props.session}
            projection={projection(key)}
            pool={pool.current}
          />,
        );
    const patch = documentPatch(
      editor.state.doc,
      draftV2ToEditor({ ...props.draft, title: '' }),
    );
    if (!patch) return;
    // Main-admitted paste/picker/cut is one user history event; ready metadata never changes nodes.
    const tr = closeHistory(editor.state.tr)
      .replaceWith(patch.from, patch.to, patch.content)
      .scrollIntoView();
    editor.updateState(editor.state.apply(tr));
    editor.updateState(
      editor.state.apply(
        closeHistory(editor.state.tr).setMeta('addToHistory', false),
      ),
    );
    updateToolbar(editor);
    latest.current.onRangeChange(
      rangeFromSelection(editor.state.doc, editor.state.selection),
    );
  }, [props.draft, props.imageProjection, props.editable, props.session]);
  return (
    <div className="rich-body-editor">
      <RichTextToolbar
        state={toolbar.format}
        disabled={!props.editable}
        canUndo={toolbar.canUndo}
        canRedo={toolbar.canRedo}
        onCommand={executeCommand}
        onInsertImage={props.onInsertImage}
      />
      <div className="article-writing-surface">
        {props.beforeBody}
        <div ref={host} className="continuous-body-shell" />
      </div>
    </div>
  );
}

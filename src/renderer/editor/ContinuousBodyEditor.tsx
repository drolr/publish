import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorState,
  AllSelection,
  NodeSelection,
  Plugin,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, chainCommands, exitCode } from 'prosemirror-commands';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { ManualDraft } from '../../contracts/manual-article';
import type {
  DraftRange,
  InternalPasteInput,
} from '../../contracts/manual-edit';
import type { WebPasteInput } from '../../contracts/web-paste';
import { parseManualClipboardFragment } from '../../contracts/editor-close';
import { editorSchema } from './editor-schema';
import {
  documentPatch,
  draftToEditor,
  editorToDraft,
  emptyEditorKey,
  rangeFromSelection,
} from './editor-codec';
import {
  InlineArticleImage,
  InlinePreviewPool,
  type ImageProjection,
} from './InlineArticleImage';
import './editor.css';
const keyedParagraphs = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((t) => t.docChanged)) return null;
    const seen = new Set<string>();
    let tr: Transaction | undefined;
    state.doc.forEach((node, pos) => {
      const key = node.attrs.blockKey;
      if (
        node.type.name === 'paragraph' &&
        (!key || key === emptyEditorKey || seen.has(key))
      ) {
        tr ??= state.tr;
        tr.setNodeMarkup(pos, undefined, { blockKey: crypto.randomUUID() });
      } else seen.add(key);
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
  session: string;
  draft: ManualDraft;
  imageProjection: ImageProjection[];
  editable: boolean;
  onTransaction: (draft: ManualDraft, composing: boolean) => void;
  onPaste: (input: WebPasteInput | InternalPasteInput) => void;
  onCopyCut: (cut: boolean) => void;
  onRangeChange: (range: DraftRange) => void;
}) {
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
    if (block.type !== 'paragraph') images.current.set(block.blockKey, block);
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
        .filter((b) => b.type !== 'paragraph')
        .map((b) => [b.blockKey, b]),
    );
    const previews = new InlinePreviewPool(host.current);
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
        doc: draftToEditor(latest.current.draft),
        plugins: [
          keyedParagraphs,
          history({ depth: 100, newGroupDelay: 500 }),
          keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Mod-Shift-z': redo,
            'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
              if (dispatch)
                dispatch(
                  state.tr
                    .replaceSelectionWith(editorSchema.node('hard_break'))
                    .scrollIntoView(),
                );
              return true;
            }),
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
        synchronizeNativeSelection(editor, (range) =>
          latest.current.onRangeChange(range),
        );
        return false;
      },
      dispatchTransaction(tr) {
        if (tr.docChanged && !latest.current.editable && !composition.current)
          return;
        const state = editor.state.apply(tr);
        editor.updateState(state);
        latest.current.onRangeChange(
          rangeFromSelection(state.doc, state.selection),
        );
        if (tr.docChanged)
          latest.current.onTransaction(
            editorToDraft(state.doc, latest.current.draft, [
              ...images.current.values(),
            ]),
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
            synchronizeNativeSelection(editor, (range) =>
              latest.current.onRangeChange(range),
            );
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
          latest.current.onTransaction(
            editorToDraft(editor.state.doc, latest.current.draft, [
              ...images.current.values(),
            ]),
            true,
          );
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
            latest.current.onTransaction(
              editorToDraft(editor.state.doc, latest.current.draft, [
                ...images.current.values(),
              ]),
              false,
            );
          }, 30);
          return false;
        },
        paste(_view, event) {
          event.preventDefault();
          if (!latest.current.editable) return true;
          const html = event.clipboardData?.getData('text/html') ?? '',
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
        synchronizeNativeSelection(editor, (range) =>
          latest.current.onRangeChange(range),
        );
    };
    // Capture navigation selection before the library's focus-reset recovery.
    const ownerDocument = editor.dom.ownerDocument;
    ownerDocument.addEventListener(
      'selectionchange',
      observeNativeNavigation,
      true,
    );
    view.current = editor;
    latest.current.onRangeChange(
      rangeFromSelection(editor.state.doc, editor.state.selection),
    );
    editor.focus();
    return () => {
      clearTimeout(endTimer.current);
      endTimer.current = undefined;
      compositionGeneration.current++;
      composition.current = false;
      view.current = undefined;
      ownerDocument.removeEventListener(
        'selectionchange',
        observeNativeNavigation,
        true,
      );
      editor.destroy();
      previews.dispose();
      roots.current.clear();
    };
  }, [props.session]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (composition.current || editor.composing) return;
    synchronizeNativeSelection(editor, (range) =>
      latest.current.onRangeChange(range),
    );
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
    const patch = documentPatch(editor.state.doc, draftToEditor(props.draft));
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
    latest.current.onRangeChange(
      rangeFromSelection(editor.state.doc, editor.state.selection),
    );
  }, [props.draft, props.imageProjection, props.editable, props.session]);
  return <div ref={host} className="continuous-body-shell" />;
}

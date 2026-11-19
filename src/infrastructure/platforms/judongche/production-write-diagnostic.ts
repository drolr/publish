// Browser-side observations. Return only fixed labels, positions, counts and equality flags.
export function inspectEditorControls({
  selector,
  editorUrl,
}: {
  selector: string;
  editorUrl: string;
}) {
  if (location.href !== editorUrl) return null;
  const visible = (e: Element) =>
    e.getClientRects().length > 0 &&
    getComputedStyle(e).visibility === 'visible';
  const count = (query: string) =>
    Array.from(document.querySelectorAll(query)).filter(visible).length;
  return {
    readyState: document.readyState,
    visibleTextareas: count('textarea'),
    visibleBodies: count(selector),
    visibleTextInputs: count(
      'input:not([type]),input[type=text],input[type=search]',
    ),
    visibleTextboxes: count('[role=textbox]'),
    visibleEditable: count('[contenteditable=true]'),
  };
}
export function inspectParagraphTarget({
  root,
  target,
  selector,
  placeholder,
  index,
  expected,
  source,
  collect,
  requireEmptyTail,
  observeOnly,
}: {
  root: Element;
  target: Element;
  selector: string;
  placeholder: string;
  index: number;
  expected: string;
  source: string;
  collect: boolean;
  requireEmptyTail: boolean;
  observeOnly: boolean;
}) {
  const guardResult = () => {
    if (
      !root.isConnected ||
      !target?.isConnected ||
      document.querySelectorAll(selector).length !== 1 ||
      document.querySelector(selector) !== root ||
      target.parentElement !== root
    )
      return 'target-changed' as const;
    if (document.activeElement !== root) return 'editor-unfocused' as const;
    const selection = getSelection();
    if (
      !selection?.isCollapsed ||
      !selection.anchorNode ||
      !selection.rangeCount
    )
      return 'no-collapsed-selection' as const;
    const interactive =
      '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=combobox],[role=slider],[role=spinbutton],[role=textbox],[role=searchbox],[role=listbox],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=scrollbar],[role=treeitem],[tabindex]';
    if (target.matches(interactive) || target.hasAttribute('contenteditable'))
      return 'interactive-target' as const;
    // E68 is a whole known empty UI shape. A matching class on later
    // source text or an image never makes that content disposable.
    const knownPlaceholder =
      target.matches(placeholder) &&
      target.childNodes.length === 3 &&
      target.children[0]?.childNodes.length === 1 &&
      target.children[0].firstChild?.nodeType === Node.TEXT_NODE &&
      target.textContent === '请输入正文' &&
      !target.querySelector(interactive + ',img[srcset],img[web_uri]');
    if (
      requireEmptyTail &&
      (root.lastChild !== target ||
        root.children.item(index) !== target ||
        selection.anchorNode !== target ||
        selection.anchorOffset !== 0 ||
        !(
          knownPlaceholder ||
          target.childNodes.length === 0 ||
          (target.childNodes.length === 1 &&
            target.firstElementChild?.matches('br.ProseMirror-trailingBreak'))
        ))
    )
      return 'empty-tail-changed' as const;
    if (selection.anchorNode === root) {
      const index = Array.prototype.indexOf.call(root.childNodes, target);
      const empty =
        (target.textContent === '' &&
          target.childNodes.length === 1 &&
          target.firstElementChild?.matches('br.ProseMirror-trailingBreak') &&
          !target.querySelector(interactive + ',[contenteditable]')) ||
        knownPlaceholder;
      return !!empty &&
        (selection.anchorOffset === index ||
          selection.anchorOffset === index + 1)
        ? ('ok' as const)
        : ('root-boundary' as const);
    }
    if (!target.contains(selection.anchorNode))
      return 'selection-outside-target' as const;
    if (knownPlaceholder)
      return selection.anchorNode === target
        ? ('ok' as const)
        : ('placeholder-boundary' as const);
    const rest = document.createRange();
    rest.selectNodeContents(target);
    rest.setStart(selection.anchorNode, selection.anchorOffset);
    const remainder = document.createElement('div');
    remainder.append(rest.cloneContents());
    // Native soft breaks may leave one terminal caret BR in a legal
    // inline wrapper. More BRs mean this caret precedes a source break.
    return remainder.textContent === '' &&
      remainder.querySelectorAll('br').length <= 1 &&
      Array.from(remainder.querySelectorAll('*')).every(
        (node) =>
          node.matches('br,span,strong,b,em,i,u,s,strike') &&
          !node.matches(interactive + ',[contenteditable]'),
      )
      ? ('ok' as const)
      : ('content-after-caret' as const);
  };
  const result = observeOnly ? ('observation-only' as const) : guardResult();
  if (!collect) return { result, sample: null };
  try {
    const roots = document.querySelectorAll(selector);
    const live = roots.length === 1 ? roots[0] : null;
    const current = live?.children.item(index);
    const anchor = getSelection()?.anchorNode;
    let block =
      anchor?.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor?.parentElement;
    while (block && block !== live && block.parentElement !== live)
      block = block.parentElement;
    // Root-boundary carets have a DOM child offset, not a paragraph index.
    const caretBlock =
      live && block && block.parentElement === live
        ? Array.prototype.indexOf.call(live.children, block) + 1
        : null;
    let matchesSource: boolean | null = null;
    let matchesExpected: boolean | null = null;
    if (current?.tagName === 'P') {
      const walker = document.createTreeWalker(
        current,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      let value = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) value += n.nodeValue;
        else if ((n as Element).matches('br:not(.ProseMirror-trailingBreak)'))
          value += '\n';
      }
      matchesExpected = value === expected;
      matchesSource = value === source;
    }
    return {
      result,
      sample: {
        rootCount: roots.length,
        sameRoot: live === root,
        sameTarget: current === target,
        targetConnected: target.isConnected,
        editorFocused: !!live && document.activeElement === live,
        caretBlock,
        caretAtRoot: !!live && anchor === live,
        caretOffset: getSelection()?.anchorOffset ?? null,
        collapsed: getSelection()?.isCollapsed ?? null,
        matchesExpected,
        matchesSource,
      },
    };
  } catch {
    return { result, sample: null };
  }
}

// Reposition once before any text is written. focus() can invoke synchronous
// page handlers, so check the exact empty nodes again before setting the caret.
export function restoreEmptyParagraphCaret({
  index,
  root,
  target,
  selector,
  placeholder,
}: {
  root: Element;
  target: Element;
  selector: string;
  placeholder: string;
  index: number;
}) {
  const originalEmptyParagraph = () => {
    if (
      !(root instanceof HTMLElement) ||
      !root.isContentEditable ||
      !document.hasFocus() ||
      document.visibilityState !== 'visible' ||
      !root.isConnected ||
      document.querySelectorAll(selector).length !== 1 ||
      document.querySelector(selector) !== root ||
      root.lastChild !== target ||
      root.children.item(index) !== target ||
      target.tagName !== 'P' ||
      target.hasAttribute('contenteditable') ||
      target.hasAttribute('role') ||
      target.hasAttribute('tabindex')
    )
      return false;
    if (target.childNodes.length === 0) return true;
    if (
      target.childNodes.length === 1 &&
      target.firstElementChild?.matches('br.ProseMirror-trailingBreak')
    )
      return true;
    return (
      target.matches(placeholder) &&
      target.childNodes.length === 3 &&
      target.firstElementChild?.childNodes.length === 1 &&
      target.firstElementChild.firstChild?.nodeType === Node.TEXT_NODE &&
      target.textContent === '请输入正文'
    );
  };
  if (!originalEmptyParagraph() || document.activeElement === root)
    return false;
  (root as HTMLElement).focus({ preventScroll: true });
  if (!originalEmptyParagraph() || document.activeElement !== root)
    return false;
  const selection = getSelection();
  if (!selection) return false;
  selection.collapse(target, 0);
  return true;
}

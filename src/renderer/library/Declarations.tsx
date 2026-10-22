import { useEffect, useRef, useState } from 'react';
import type { DeclarationItem } from '../../contracts/article-declaration';

type Declaration = DeclarationItem['contentDeclaration'];
export const declarationLabel = (value: Declaration) =>
  value === 'original' ? '原创' : '转载';
export function useDeclarations(options: {
  blocked: boolean;
  resetRevision?: number;
  beforeWrite?: () => Promise<boolean>;
  onContentChange?: () => void;
  invalidate: () => void;
  apply: (items: DeclarationItem[]) => void;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState<Map<string, DeclarationItem>>(
    new Map(),
  );
  const [panel, setPanel] = useState<{
    keys: string[];
    declaration: Declaration;
    items: DeclarationItem[] | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [uncertain, setUncertain] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [editorRevision, setEditorRevision] = useState(0);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const readSequence = useRef(0);
  useEffect(
    () => () => {
      readSequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (!options.resetRevision) return;
    readSequence.current++;
    lock.current = false;
    setSelected(new Map());
    setPanel(null);
    setReading(false);
    setSaving(false);
    setUncertain(null);
    setMessage('');
    setError('');
  }, [options.resetRevision]);
  const frozen = saving || reading || panel !== null || uncertain !== null;
  function update(items: DeclarationItem[]) {
    options.apply(items);
    setSelected((previous) => {
      const next = new Map(previous);
      for (const item of items)
        if (next.has(item.articleKey)) next.set(item.articleKey, item);
      return next;
    });
  }
  function toggle(items: DeclarationItem[], checked: boolean) {
    if (frozen || options.blocked) return;
    setSelected((previous) => {
      const next = new Map(previous);
      for (const item of items) {
        if (!checked) next.delete(item.articleKey);
        else if (next.size < 100) next.set(item.articleKey, item);
      }
      return next;
    });
  }
  async function open(declaration: Declaration) {
    if (lock.current || options.blocked || frozen || !selected.size) return;
    if (options.beforeWrite && !(await options.beforeWrite())) return;
    const keys = [...selected.keys()];
    setError('');
    setMessage('');
    setPanel({ keys, declaration, items: null });
    await read(keys, false, declaration);
  }
  async function read(
    keys: string[],
    reconcile: boolean,
    declaration?: Declaration,
  ) {
    const sequence = ++readSequence.current;
    setReading(true);
    options.invalidate();
    try {
      const result = await window.desktopApi.getArticleDeclarations(keys);
      if (sequence !== readSequence.current) return;
      if (result.status !== 'ok') {
        setError(
          result.status === 'not_found'
            ? '部分文章已不存在，请刷新列表后重新选择。'
            : '文章声明暂时无法读取，请重试。',
        );
        return;
      }
      update(result.items);
      setError('');
      if (reconcile) {
        setUncertain(null);
        setEditorRevision((value) => value + 1);
        setSelected(new Map());
        setMessage(
          '已核对当前属性；此前保存结果仍无法确认。如需修改，请重新选择并提交。',
        );
      } else if (declaration)
        setPanel({ keys, declaration, items: result.items });
    } catch {
      if (sequence === readSequence.current)
        setError('文章声明暂时无法读取，请重试。');
    } finally {
      if (sequence === readSequence.current) {
        setReading(false);
        options.refresh();
      }
    }
  }
  function close() {
    if (lock.current) return;
    readSequence.current++;
    setReading(false);
    setPanel(null);
    options.refresh();
  }
  async function save(
    items: DeclarationItem[],
    declaration: Declaration,
    bulk = false,
  ) {
    if (
      lock.current ||
      options.blocked ||
      reading ||
      uncertain ||
      !items.length
    )
      return;
    if (options.beforeWrite && !(await options.beforeWrite())) return;
    lock.current = true;
    const sequence = ++readSequence.current;
    setSaving(true);
    setError('');
    setMessage('');
    options.invalidate();
    try {
      const result = await window.desktopApi.setArticleDeclarations({
        targets: items.map((item) => ({
          articleKey: item.articleKey,
          expectedDeclaration: item.contentDeclaration,
        })),
        declaration,
      });
      if (sequence !== readSequence.current) return;
      if (result.status === 'updated') {
        if (result.changedCount > 0) options.onContentChange?.();
        update(result.items);
        setMessage(
          `已更新 ${result.changedCount} 篇，${result.unchangedCount} 篇原本已是该属性`,
        );
        if (bulk) setSelected(new Map());
        setPanel(null);
      } else {
        setPanel(null);
        setError(
          result.status === 'conflict'
            ? '文章属性已变化，请刷新后重新确认'
            : result.status === 'not_found'
              ? '部分文章已不存在，请刷新列表后重新选择。'
              : result.status === 'busy'
                ? '导入正在进行，请稍后修改声明。'
                : '声明未能保存，请稍后重试。',
        );
      }
      options.refresh();
    } catch {
      if (sequence !== readSequence.current) return;
      setPanel(null);
      setUncertain(items.map((item) => item.articleKey));
      setError('保存结果暂时无法确认，请核对当前属性');
    } finally {
      if (sequence === readSequence.current) {
        lock.current = false;
        setSaving(false);
      }
    }
  }
  return {
    selected,
    editorRevision,
    panel,
    saving,
    reading,
    uncertain,
    message,
    error,
    frozen,
    toggle,
    remove: (key: string) =>
      setSelected((previous) => {
        const next = new Map(previous);
        next.delete(key);
        return next;
      }),
    open,
    close,
    save,
    clear: () => {
      if (!frozen) setSelected(new Map());
    },
    retry: () =>
      uncertain
        ? read(uncertain, true)
        : panel
          ? read(panel.keys, false, panel.declaration)
          : Promise.resolve(),
  };
}
export type DeclarationController = ReturnType<typeof useDeclarations>;

export function DeclarationEditor({
  item,
  disabled,
  onSave,
}: {
  item: DeclarationItem;
  disabled: boolean;
  onSave: (items: DeclarationItem[], declaration: Declaration) => Promise<void>;
}) {
  const [draft, setDraft] = useState(item.contentDeclaration);
  useEffect(() => setDraft(item.contentDeclaration), [item.contentDeclaration]);
  return (
    <div className="declaration-editor">
      <label>
        文章声明{' '}
        <select
          aria-label="文章声明"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value as Declaration)}
        >
          <option value="original">原创</option>
          <option value="repost">转载</option>
        </select>
      </label>
      <button
        disabled={disabled || draft === item.contentDeclaration}
        onClick={() => void onSave([item], draft)}
      >
        保存声明
      </button>
    </div>
  );
}

export function DeclarationControls({
  controller: c,
  blocked,
}: {
  controller: DeclarationController;
  blocked: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const selectionSummary = useRef<HTMLSpanElement>(null);
  const panelOpen = c.panel !== null;
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (panelOpen) {
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      restoreFocus.current = true;
    }
  }, [panelOpen]);
  useEffect(() => {
    if (!panelOpen && !blocked && restoreFocus.current) {
      if (
        trigger.current instanceof HTMLButtonElement &&
        trigger.current.disabled
      )
        selectionSummary.current?.focus();
      else trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [panelOpen, blocked]);
  return (
    <>
      <div className="declaration-toolbar">
        <span ref={selectionSummary} tabIndex={-1}>
          已选择 {c.selected.size} 篇
        </span>
        <button
          disabled={blocked || c.frozen || !c.selected.size}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            void c.open('original');
          }}
        >
          设为原创
        </button>
        <button
          disabled={blocked || c.frozen || !c.selected.size}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            void c.open('repost');
          }}
        >
          设为转载
        </button>
        <button disabled={c.frozen || !c.selected.size} onClick={c.clear}>
          清空选择
        </button>
        {!c.selected.size && (
          <span className="hint">勾选文章后可批量修改声明</span>
        )}
        {c.selected.size === 100 && (
          <span className="hint">已达上限，每次最多选择 100 篇</span>
        )}
      </div>
      {(c.message || c.saving) && (
        <p role="status" aria-live="polite">
          {c.saving ? '正在保存声明…' : c.message}
        </p>
      )}
      {c.error && <p role="alert">{c.error}</p>}
      {c.uncertain && (
        <button disabled={c.reading} onClick={() => void c.retry()}>
          {c.reading ? '正在核对属性…' : '核对当前属性'}
        </button>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="declaration-confirm-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls =
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled)',
            );
          if (!controls.length) {
            event.preventDefault();
            return;
          }
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          c.close();
        }}
      >
        <h2 id="declaration-confirm-title">批量修改声明</h2>
        {c.panel && (
          <>
            <p>
              将 {c.panel.keys.length} 篇文章设为
              {declarationLabel(c.panel.declaration)}
            </p>
            {c.reading ? (
              <p>正在读取当前声明…</p>
            ) : c.panel.items ? (
              <ul className="declaration-confirm-items">
                {c.panel.items.map((item) => (
                  <li key={item.articleKey}>
                    <strong>{item.title}</strong>
                    <span>文章编号 {item.externalId}</span>
                    <span>
                      当前：{declarationLabel(item.contentDeclaration)} → 目标：
                      {declarationLabel(c.panel!.declaration)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p role="alert">无法读取当前声明，请重试后确认。</p>
                <button onClick={() => void c.retry()}>重新读取声明</button>
              </>
            )}
            <div className="declaration-toolbar">
              <button disabled={c.saving} onClick={c.close}>
                关闭
              </button>
              <button
                className="primary"
                disabled={blocked || c.reading || c.saving || !c.panel.items}
                onClick={() =>
                  c.panel?.items &&
                  void c.save(c.panel.items, c.panel.declaration, true)
                }
              >
                确认修改
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

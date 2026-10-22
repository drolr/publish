import { readArticlePreview as readPreview } from './readArticlePreview';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArticleCursor,
  ArticlePage,
  ArticlePreview,
  ImportSnapshot,
} from '../../contracts/article-library';
import { Preview } from './Preview';
import { ArticleDeleteDialog } from './ArticleDeleteDialog';
import { readDeletionArticle, useArticleDeletion } from './useArticleDeletion';
import {
  DeclarationControls,
  DeclarationEditor,
  useDeclarations,
} from './Declarations';

// Sharing the outstanding read also prevents a StrictMode remount from overlapping it.
let statusRead: Promise<ImportSnapshot> | undefined;
function readStatus() {
  statusRead ??= window.desktopApi.getImportStatus().finally(() => {
    statusRead = undefined;
  });
  return statusRead;
}
const active = (snapshot: ImportSnapshot | null) =>
  snapshot !== null &&
  snapshot.state !== 'idle' &&
  snapshot.state !== 'finished';
export function ArticleLibrary({
  initialArticleKey,
  onSelectionChange,
  successMessage,
  onNewArticle,
  manualBlocked = false,
  editor,
  onRequestSelection,
  refreshKey,
  beforeWrite,
  onContentChange,
  onArticleDeleted,
  onDeletionBusyChange,
  renderSelectedActions,
  resetRevision = 0,
}: {
  resetRevision?: number;
  renderSelectedActions?: (keys: string[], blocked: boolean) => React.ReactNode;
  initialArticleKey?: string;
  onSelectionChange?: (articleKey?: string) => void;
  successMessage?: string;
  onNewArticle?: () => void;
  manualBlocked?: boolean;
  editor?: React.ReactNode;
  onRequestSelection?: (key?: string) => void;
  refreshKey?: string;
  beforeWrite?: () => Promise<boolean>;
  onContentChange?: () => void;
  onArticleDeleted?: (key: string) => void;
  onDeletionBusyChange?: (busy: boolean) => void;
} = {}) {
  const selectionRequest = useRef(onRequestSelection);
  selectionRequest.current = onRequestSelection;
  const [page, setPage] = useState<ArticlePage | null>(null);
  const [cursors, setCursors] = useState<(ArticleCursor | undefined)[]>([
    undefined,
  ]);
  const [listError, setListError] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [selection, setSelection] = useState<{
    key: string;
    focus: boolean;
  } | null>(initialArticleKey ? { key: initialArticleKey, focus: true } : null);
  useEffect(() => {
    onSelectionChange?.(selection?.key);
  }, [selection?.key, onSelectionChange]);
  useEffect(() => {
    if (onRequestSelection) {
      const previous = selection?.key;
      setSelection(
        initialArticleKey ? { key: initialArticleKey, focus: true } : null,
      );
      if (!initialArticleKey && previous)
        requestAnimationFrame(() => rows.current.get(previous)?.focus());
    }
  }, [initialArticleKey]);
  const [article, setArticle] = useState<ArticlePreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [snapshot, setSnapshot] = useState<ImportSnapshot | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [pending, setPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const latest = useRef<ImportSnapshot | null>(null);
  const handled = useRef('');
  const pendingJob = useRef<string | null>(null);
  const expectedJob = useRef<string | null>(null);
  const listSequence = useRef(0);
  const previewSequence = useRef(0);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const listHeading = useRef<HTMLHeadingElement>(null);
  const declarationsFrozen = useRef(false);
  const deletionStatus = useRef<HTMLParagraphElement>(null);
  const load = useCallback(async (cursor?: ArticleCursor) => {
    const sequence = ++listSequence.current;
    setListLoading(true);
    setListError(false);
    try {
      const result = await window.desktopApi.listArticles(cursor);
      if (sequence !== listSequence.current) return;
      if (result.status === 'stale_cursor') {
        setCursors([undefined]);
        const fresh = await window.desktopApi.listArticles();
        if (sequence !== listSequence.current) return;
        if (fresh.status === 'ok') setPage(fresh.page);
        else setListError(true);
      } else if (result.status === 'ok') setPage(result.page);
      else setListError(true);
    } catch {
      if (sequence === listSequence.current) setListError(true);
    } finally {
      if (sequence === listSequence.current) setListLoading(false);
    }
  }, []);
  useEffect(() => {
    setCursors([undefined]);
    void load();
    return () => {
      listSequence.current++;
    };
  }, [load, refreshKey]);
  const accept = useCallback(
    (value: ImportSnapshot) => {
      if (
        expectedJob.current &&
        (!('jobId' in value) || value.jobId !== expectedJob.current)
      )
        return false;
      if (latest.current && value.revision < latest.current.revision)
        return false;
      const initialManualReturn =
        latest.current === null && !!initialArticleKey;
      expectedJob.current = null;
      latest.current = value;
      if ('jobId' in value) pendingJob.current = value.jobId;
      else pendingJob.current = null;
      setSnapshot(value);
      setUnknown(false);
      setPending(false);
      if (value.state === 'finished' || value.state === 'idle')
        setStopPending(false);
      if (value.state === 'finished' && handled.current !== value.jobId) {
        handled.current = value.jobId;
        if (
          !initialManualReturn &&
          (value.result.status === 'imported' ||
            value.result.status === 'already_exists')
        ) {
          setCursors([undefined]);
          void load();
          if (selectionRequest.current)
            selectionRequest.current(value.result.articleKey);
          else setSelection({ key: value.result.articleKey, focus: true });
        }
      }
      return true;
    },
    [load, initialArticleKey],
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let again = true;
      try {
        const value = await readStatus();
        if (disposed) return;
        const accepted = accept(value);
        again = !accepted || active(value);
      } catch {
        if (disposed) return;
        setUnknown(true);
      }
      if (!disposed && again) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [accept, epoch]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sequence = ++previewSequence.current;
    setArticle(null);
    setPreviewError(false);
    async function loadPreview() {
      if (!selection) return;
      try {
        const result = await readPreview(
          selection.key,
          () => !disposed && sequence === previewSequence.current,
        );
        if (disposed || sequence !== previewSequence.current || !result) return;
        if (result.status === 'busy')
          timer = setTimeout(() => void loadPreview(), 500);
        else if (result.status === 'ok') setArticle(result.article);
        else setPreviewError(true);
      } catch {
        if (!disposed && sequence === previewSequence.current)
          setPreviewError(true);
      }
    }
    void loadPreview();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selection, previewEpoch, refreshKey]);
  async function start() {
    if (
      pending ||
      unknown ||
      active(latest.current) ||
      declarations.frozen ||
      deletion.frozen
    )
      return;
    if (beforeWrite && !(await beforeWrite())) return;
    setPending(true);
    try {
      const result = await window.desktopApi.startArticleImport();
      if (result.status === 'unavailable') {
        setUnknown(true);
        setPending(false);
      } else {
        pendingJob.current = result.jobId;
        expectedJob.current = result.jobId;
      }
      // A lost response is resolved by querying; never resubmit automatically.
    } catch {
      setUnknown(true);
    }
    setEpoch((value) => value + 1);
  }
  async function cancel() {
    const jobId = pendingJob.current;
    if (!jobId) return;
    setStopPending(true);
    try {
      accept(await window.desktopApi.cancelArticleImport(jobId));
    } catch {
      setUnknown(true);
      setEpoch((value) => value + 1);
    }
  }
  function back() {
    const key = selection?.key;
    if (onRequestSelection) {
      onRequestSelection(undefined);
      return;
    }
    setSelection(null);
    requestAnimationFrame(() => {
      (key ? rows.current.get(key) : null)?.focus();
      if (!key || !rows.current.has(key)) listHeading.current?.focus();
    });
  }
  const busy =
    manualBlocked ||
    pending ||
    unknown ||
    snapshot === null ||
    active(snapshot);
  const deletionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterDelete = useRef<{ key: string; deleted: boolean } | null>(
    null,
  );
  const deletion = useArticleDeletion({
    blocked: busy || listLoading || listError || declarationsFrozen.current,
    beforeWrite,
    onBusyChange: onDeletionBusyChange,
    readArticle: async (key) => {
      try {
        const result = await readDeletionArticle(key);
        listSequence.current++;
        setListLoading(false);
        setListError(false);
        setCursors(result.cursors);
        setPage(result.page);
        return result.article;
      } catch {
        listSequence.current++;
        setListLoading(false);
        setListError(true);
        throw new Error('Article metadata unavailable');
      }
    },
    onDeleted: async (key) => {
      previewSequence.current++;
      declarations.remove(key);
      if (selection?.key === key) {
        setArticle(null);
        setPreviewError(false);
        setSelection(null);
      } else
        setSelection((previous) =>
          previous ? { ...previous, focus: false } : null,
        );
      onArticleDeleted?.(key);
      setCursors([undefined]);
      await load();
    },
    restoreFocus: (key, deleted) => {
      focusAfterDelete.current = { key, deleted };
    },
  });
  useEffect(() => {
    if (deletion.pending) deletionStatus.current?.focus();
  }, [deletion.pending]);
  useEffect(() => {
    const target = focusAfterDelete.current;
    if (!target || deletion.frozen || listLoading) return;
    focusAfterDelete.current = null;
    if (target.deleted) listHeading.current?.focus();
    else
      (
        deletionTriggers.current.get(target.key) ?? listHeading.current
      )?.focus();
  }, [deletion.frozen, listLoading]);
  useEffect(() => {
    if (!resetRevision) return;
    previewSequence.current++;
    statusRead = undefined;
    expectedJob.current = null;
    pendingJob.current = null;
    if (latest.current && 'jobId' in latest.current)
      handled.current = latest.current.jobId;
    setSelection(null);
    setArticle(null);
    setPreviewError(false);
    setUnknown(false);
    setPending(false);
    setStopPending(false);
    setEpoch((v) => v + 1);
  }, [resetRevision]);
  const declarations = useDeclarations({
    resetRevision,
    blocked: busy || listLoading || deletion.frozen,
    beforeWrite,
    onContentChange,
    invalidate: () => {
      listSequence.current++;
      previewSequence.current++;
    },
    apply: (items) => {
      const changes = new Map(items.map((item) => [item.articleKey, item]));
      setPage((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((item) => ({
                ...item,
                ...changes.get(item.articleKey),
              })),
            }
          : null,
      );
      setArticle((previous) =>
        previous ? { ...previous, ...changes.get(previous.articleKey) } : null,
      );
    },
    refresh: () => {
      setSelection((previous) =>
        previous ? { ...previous, focus: false } : null,
      );
      void load(cursors.at(-1));
      setPreviewEpoch((value) => value + 1);
    },
  });
  declarationsFrozen.current = declarations.frozen;
  const editorItem = selection
    ? (page?.items.find((item) => item.articleKey === selection.key) ??
      (article?.articleKey === selection.key ? article : undefined))
    : undefined;
  const result = snapshot?.state === 'finished' ? snapshot.result : null;
  return (
    <div className="library">
      <section className="article-module" aria-label="文章">
        <div className="toolbar">
          <div>
            <h2>文章</h2>
            <p>导入文章包，检查保存在本机的图文内容。</p>
          </div>
          {onNewArticle && (
            <button
              disabled={busy || declarations.frozen || deletion.frozen}
              onClick={onNewArticle}
            >
              新建文章
            </button>
          )}
          <button
            className="primary"
            disabled={busy || declarations.frozen || deletion.frozen}
            onClick={() => void start()}
            aria-describedby="import-help"
          >
            导入文章
          </button>
        </div>
        {successMessage && <p role="status">{successMessage}</p>}
        <p id="import-help" className="hint">
          选择文章包文件后会导入；本地图片需保留相对目录，网络图片会按文章包地址下载。
        </p>
        <div className="operation" role="status" aria-live="polite">
          {unknown
            ? '连接状态未知，正在确认导入结果…'
            : stopPending || snapshot?.state === 'stopping'
              ? '正在停止…'
              : snapshot?.state === 'selecting'
                ? '请选择文章包文件…'
                : pending || snapshot?.state === 'importing'
                  ? '正在导入文章…'
                  : result?.status === 'imported'
                    ? '已导入'
                    : result?.status === 'already_exists'
                      ? '这篇文章已在文章池中，未重复导入'
                      : result?.status === 'already_deleted'
                        ? '该文章已从本机文章池移除，未重新导入'
                        : result?.status === 'cancelled'
                          ? '已取消导入'
                          : snapshot === null
                            ? '正在确认导入状态…'
                            : '文章仅保存在本机'}
          {(active(snapshot) || (unknown && pendingJob.current)) && (
            <button
              disabled={stopPending || snapshot?.state === 'stopping'}
              onClick={() => void cancel()}
            >
              取消导入
            </button>
          )}
          {result?.status === 'imported' &&
            result.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
        </div>
        {result?.status === 'failed' && (
          <p role="alert">
            {result.imageIndex !== undefined
              ? `第 ${result.imageIndex + 1} 张图片：`
              : ''}
            {result.message}
          </p>
        )}
        {result?.status === 'invalid' && (
          <div role="alert">
            <p>文章包内容有误，请检查后重新导入。</p>
            <ul>
              {result.issues.map((issue, index) => (
                <li key={index}>
                  {issue.position ? `${issue.position}：` : ''}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DeclarationControls
          controller={declarations}
          blocked={busy || listLoading || deletion.frozen}
        />
        <p role="status" aria-live="polite" className="library-count">
          {listError
            ? '数量暂时无法读取'
            : listLoading
              ? '正在读取文章数量…'
              : page
                ? `本机文章共 ${page.totalCount} 篇`
                : '正在读取文章数量…'}
        </p>
        {deletion.message && <p role="status">{deletion.message}</p>}
        {deletion.error && <p role="alert">{deletion.error}</p>}
        {deletion.pending && (
          <p
            ref={deletionStatus}
            tabIndex={-1}
            role="status"
            aria-live="polite"
          >
            {deletion.uncertain
              ? '删除结果暂时无法确认，正在核对…'
              : '正在删除本机文章…'}
          </p>
        )}
        {deletion.article && !deletion.pending && (
          <ArticleDeleteDialog
            article={deletion.article}
            busy={deletion.pending}
            onCancel={deletion.cancel}
            onConfirm={() => void deletion.confirm()}
          />
        )}
        <div className="library-grid">
          <section className="article-list" aria-label="文章列表">
            <h3 ref={listHeading} tabIndex={-1}>
              已导入本机
            </h3>
            {!!page?.items.length && (
              <label className="select-page">
                <input
                  type="checkbox"
                  aria-label="全选本页"
                  disabled={
                    busy ||
                    listLoading ||
                    declarations.frozen ||
                    deletion.frozen
                  }
                  checked={page.items.every((item) =>
                    declarations.selected.has(item.articleKey),
                  )}
                  onChange={(event) =>
                    declarations.toggle(page.items, event.target.checked)
                  }
                />
                全选本页
              </label>
            )}
            {listError && (
              <div role="alert">
                <p>列表暂时无法刷新，请重新加载。</p>
                <button
                  disabled={declarations.frozen || deletion.frozen}
                  onClick={() => void load(cursors.at(-1))}
                >
                  重新加载
                </button>
              </div>
            )}
            {listError ? null : listLoading ? (
              <p>正在读取文章…</p>
            ) : page?.items.length === 0 ? (
              <div className="empty">
                <span className="mark" aria-hidden="true">
                  文
                </span>
                <h3>还没有文章</h3>
                <p>点击上方“导入文章”开始。</p>
              </div>
            ) : (
              <ul className="article-rows">
                {page?.items.map((item) => (
                  <li key={item.articleKey}>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.title}`}
                      checked={declarations.selected.has(item.articleKey)}
                      disabled={
                        busy ||
                        declarations.frozen ||
                        deletion.frozen ||
                        (declarations.selected.size === 100 &&
                          !declarations.selected.has(item.articleKey))
                      }
                      onChange={(event) =>
                        declarations.toggle([item], event.target.checked)
                      }
                    />
                    <button
                      disabled={
                        declarations.saving ||
                        !!declarations.uncertain ||
                        deletion.frozen
                      }
                      ref={(node) => {
                        if (node) rows.current.set(item.articleKey, node);
                        else rows.current.delete(item.articleKey);
                      }}
                      aria-pressed={selection?.key === item.articleKey}
                      onClick={() =>
                        onRequestSelection
                          ? onRequestSelection(item.articleKey)
                          : setSelection({ key: item.articleKey, focus: true })
                      }
                    >
                      <strong>{item.title}</strong>
                      <span>文章编号 {item.externalId}</span>
                      <span>
                        {item.contentDeclaration === 'original'
                          ? '原创'
                          : '转载'}{' '}
                        · {item.imageCount} 张独立图片
                      </span>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </time>
                      <span className="local-label">已导入本机</span>
                    </button>
                    <button
                      className="article-delete-trigger"
                      aria-label={`删除 ${item.title}`}
                      ref={(node) => {
                        if (node)
                          deletionTriggers.current.set(item.articleKey, node);
                        else deletionTriggers.current.delete(item.articleKey);
                      }}
                      disabled={
                        busy ||
                        listLoading ||
                        declarations.frozen ||
                        deletion.frozen
                      }
                      onClick={() => void deletion.open(item.articleKey)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <nav aria-label="文章分页">
              <button
                disabled={
                  declarations.frozen ||
                  deletion.frozen ||
                  listLoading ||
                  listError ||
                  cursors.length === 1
                }
                onClick={() => {
                  const next = cursors.slice(0, -1);
                  setCursors(next);
                  void load(next.at(-1));
                }}
              >
                上一页
              </button>
              <span>
                {listError
                  ? '页码暂时无法读取'
                  : listLoading
                    ? '正在读取页码…'
                    : `第 ${page?.pageNumber ?? 1} 页 / 共 ${page?.totalPages ?? 1} 页`}
              </span>
              <button
                disabled={
                  declarations.frozen ||
                  deletion.frozen ||
                  listLoading ||
                  listError ||
                  !page?.nextCursor
                }
                onClick={() => {
                  if (page?.nextCursor) {
                    setCursors([...cursors, page.nextCursor]);
                    void load(page.nextCursor);
                  }
                }}
              >
                下一页
              </button>
            </nav>
          </section>
          <section
            className={
              editor ? 'article-preview editor-workspace' : 'article-preview'
            }
            aria-label="文章预览"
          >
            {editor ? (
              editor
            ) : selection ? (
              <>
                <button
                  disabled={
                    declarations.saving ||
                    !!declarations.uncertain ||
                    deletion.frozen
                  }
                  onClick={back}
                >
                  返回列表
                </button>
                {editorItem && (
                  <DeclarationEditor
                    key={`${editorItem.articleKey}:${declarations.editorRevision}`}
                    item={editorItem}
                    disabled={
                      busy ||
                      listLoading ||
                      declarations.frozen ||
                      deletion.frozen
                    }
                    onSave={declarations.save}
                  />
                )}
                {previewError ? (
                  <p role="alert">文章素材无法读取，请检查本地存储。</p>
                ) : article ? (
                  <Preview
                    key={article.articleKey}
                    article={article}
                    focus={selection.focus}
                  />
                ) : (
                  <p>正在读取文章预览…</p>
                )}
              </>
            ) : (
              <div className="empty">
                <h3>选择一篇文章</h3>
                <p>在这里检查正文、图片顺序和原创声明。</p>
              </div>
            )}
          </section>
        </div>
      </section>
      {renderSelectedActions?.(
        [...declarations.selected.keys()],
        busy ||
          listLoading ||
          listError ||
          declarations.frozen ||
          deletion.frozen,
      )}
    </div>
  );
}

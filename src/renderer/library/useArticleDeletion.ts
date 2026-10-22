import { useEffect, useRef, useState } from 'react';
import type {
  ArticleCursor,
  ArticleSummary,
} from '../../contracts/article-library';
import type {
  DeleteArticleCommand,
  DeleteArticleResult,
} from '../../contracts/article-delete';

// A save may have moved the displayed page. Locate only through safe metadata,
// keeping a complete back stack for the membership revision used to confirm.
export async function readDeletionArticle(key: string) {
  let cursors: (ArticleCursor | undefined)[] = [undefined];
  let pageLimit: number | undefined;
  let membership: number | undefined;
  let staleResets = 0;
  const seen = new Set<string>();
  for (;;) {
    const result = await window.desktopApi.listArticles(cursors.at(-1));
    if (result.status === 'stale_cursor' && staleResets++ === 0) {
      cursors = [undefined];
      pageLimit = undefined;
      membership = undefined;
      seen.clear();
      continue;
    }
    if (result.status !== 'ok') throw new Error('Article metadata unavailable');
    const page = result.page;
    pageLimit ??= page.totalPages;
    membership ??= page.membershipRevision;
    if (
      page.totalPages !== pageLimit ||
      page.membershipRevision !== membership ||
      page.pageNumber !== cursors.length ||
      cursors.length > pageLimit
    )
      throw new Error('Article metadata changed');
    const article = page.items.find((item) => item.articleKey === key);
    if (article || !page.nextCursor) return { article, page, cursors };
    const cursor = page.nextCursor;
    const position = `${cursor.membershipRevision}:${cursor.createdAt}:${cursor.articleKey}`;
    if (seen.has(position) || cursors.length >= pageLimit)
      throw new Error('Article metadata cursor repeated');
    seen.add(position);
    cursors.push(cursor);
  }
}

// Coordinates one renderer confirmation and its receipt; never retries a write.
export function useArticleDeletion(options: {
  blocked: boolean;
  beforeWrite?: () => Promise<boolean>;
  readArticle: (key: string) => Promise<ArticleSummary | undefined>;
  onDeleted: (key: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  restoreFocus: (key: string, deleted: boolean) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [article, setArticle] = useState<ArticleSummary | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const command = useRef<DeleteArticleCommand | null>(null);
  const mounted = useRef(true);
  const querying = useRef<DeleteArticleCommand | null>(null);
  const transportPending = useRef<DeleteArticleCommand | null>(null);
  const settling = useRef<DeleteArticleCommand | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  function release(key: string, deleted = false) {
    clearTimeout(timer.current);
    settling.current = null;
    command.current = null;
    lock.current = false;
    setArticle(null);
    setFrozen(false);
    setPending(false);
    setUncertain(false);
    latest.current.onBusyChange?.(false);
    latest.current.restoreFocus(key, deleted);
  }
  async function open(key: string) {
    if (lock.current || latest.current.blocked) return;
    lock.current = true;
    setFrozen(true);
    setMessage('');
    setError('');
    try {
      if (latest.current.beforeWrite && !(await latest.current.beforeWrite())) {
        if (mounted.current) release(key);
        return;
      }
      if (!mounted.current) return;
      latest.current.onBusyChange?.(true);
      const current = await latest.current.readArticle(key);
      if (!mounted.current) return;
      if (!current) {
        setError('文章信息暂时无法确认，请刷新列表后重新选择。');
        release(key);
        return;
      }
      setArticle(current);
    } catch {
      if (mounted.current) {
        setError('文章信息暂时无法读取，请刷新列表后重试。');
        release(key);
      }
    }
  }
  async function accept(
    result: DeleteArticleResult,
    request: DeleteArticleCommand,
    fromQuery = false,
  ) {
    if (
      !mounted.current ||
      command.current !== request ||
      settling.current === request
    )
      return;
    if (
      result.operationId !== request.operationId ||
      (result.status === 'deleted' && result.articleKey !== request.articleKey)
    ) {
      throw new Error('Deletion receipt identity mismatch');
    }
    if (
      result.status === 'unavailable' ||
      (fromQuery &&
        result.status === 'not_started' &&
        transportPending.current === request)
    ) {
      setUncertain(true);
      return false;
    }
    // Claim the receipt before refresh yields: another reply cannot settle it twice.
    settling.current = request;
    clearTimeout(timer.current);
    if (result.status === 'deleted') {
      setMessage('已从本机文章池移除，不会删除巨懂车草稿。');
      try {
        await latest.current.onDeleted(request.articleKey);
      } catch {
        if (mounted.current && command.current === request)
          setError('文章已移除，列表暂时无法刷新，请重新加载。');
      }
    } else {
      setError(
        result.status === 'conflict'
          ? '文章已更新，请刷新后重新确认删除。'
          : result.status === 'blocked'
            ? '当前有操作尚未安全结束，暂时不能删除文章。'
            : result.status === 'not_found'
              ? '文章已不在本机文章池中，请刷新列表。'
              : '本次删除尚未开始，请刷新列表后重新确认。',
      );
    }
    if (mounted.current && command.current === request)
      release(request.articleKey, result.status === 'deleted');
    return true;
  }
  async function query(request: DeleteArticleCommand) {
    if (
      !mounted.current ||
      command.current !== request ||
      querying.current === request ||
      settling.current === request
    )
      return;
    querying.current = request;
    let settled = false;
    try {
      settled = !!(await accept(
        await window.desktopApi.getArticleDeletionResult(request.operationId),
        request,
        true,
      ));
    } catch {
      if (
        mounted.current &&
        command.current === request &&
        settling.current !== request
      )
        setUncertain(true);
    } finally {
      if (querying.current === request) querying.current = null;
    }
    if (
      !settled &&
      mounted.current &&
      command.current === request &&
      settling.current !== request
    )
      timer.current = setTimeout(() => void query(request), 1000);
  }
  async function confirm() {
    if (!article || command.current || pending) return;
    const request: DeleteArticleCommand = {
      operationId: crypto.randomUUID(),
      articleKey: article.articleKey,
      expectedArticleRevision: article.articleRevision,
    };
    command.current = request;
    transportPending.current = request;
    setPending(true);
    timer.current = setTimeout(() => {
      if (
        !mounted.current ||
        command.current !== request ||
        settling.current === request
      )
        return;
      setUncertain(true);
      void query(request);
    }, 3000);
    try {
      const result = await window.desktopApi.deleteArticle(request);
      if (transportPending.current === request) transportPending.current = null;
      if (await accept(result, request)) return;
    } catch {
      if (transportPending.current === request) transportPending.current = null;
      if (
        mounted.current &&
        command.current === request &&
        settling.current !== request
      )
        setUncertain(true);
    }
    if (
      mounted.current &&
      command.current === request &&
      settling.current !== request
    ) {
      clearTimeout(timer.current);
      void query(request);
    }
  }
  return {
    article,
    frozen,
    pending,
    uncertain,
    message,
    error,
    open,
    confirm,
    cancel: () => {
      if (article && !command.current) release(article.articleKey);
    },
  };
}

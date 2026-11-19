import { HelpTip } from '../HelpTip';
import type { WorkspaceTaskStatus } from '../WorkspaceFooter';
import { CoverTaskResult } from './CoverTaskResult';
import { useEffect, useRef, useState } from 'react';
import {
  BatchPrepareResultSchema,
  BatchCommandResultSchema,
  type BatchPreparationView,
  type BatchItemView,
} from '../../contracts/draft-batch';
import { DraftViewSchema } from '../../contracts/draft-task';
import { useBatch } from './useBatch';
import { manualUploadMessage, reasons } from './reasons';
const labels: Record<BatchItemView['state'], string> = {
  queued: '待上传',
  running: '正在上传',
  draft_saved: '草稿已保存',
  submission_recorded: '已尝试保存（待人工核对）',
  failed: '文章失败',
  needs_human: '需人工处理',
  stopped: '未执行',
  skipped: '已跳过',
};
export function BatchPanel({
  articleKeys,
  beforeWrite,
  blocked = false,
  operationGeneration,
  onBlockedChange,
  coverPanel,
  stopControl,
  contentEpoch = 0,
  configurationBlocked = false,
  onIssueChange,
  onTaskStatusChange,
}: {
  articleKeys: string[];
  onIssueChange?: (issue: string) => void;
  onTaskStatusChange?: (status: WorkspaceTaskStatus | null) => void;
  coverPanel?: React.ReactNode;
  stopControl?: React.ReactNode;
  contentEpoch?: number;
  configurationBlocked?: boolean;
  beforeWrite: () => Promise<boolean>;
  blocked?: boolean;
  operationGeneration?: () => number;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const [newAttempts, setNewAttempts] = useState<string[]>([]);
  const generation = operationGeneration?.() ?? 0;
  const batch = useBatch(generation);
  const actionId = useRef(0);
  useEffect(() => {
    actionId.current++;
    lock.current = false;
    setBusy(false);
    setUncertainStart(null);
    setNotice('');
    setPreparation(null);
    setNewAttempts([]);
    preparedContext.current = null;
  }, [generation]);
  const actionBar = useRef<HTMLDivElement>(null);
  const fixedActions = !!stopControl;
  useEffect(() => {
    if (!fixedActions) return;
    const bar = actionBar.current,
      main = bar?.closest('main');
    if (!bar || !main) return;
    const resize = () =>
      main.style.setProperty(
        '--draft-action-height',
        bar.getBoundingClientRect().height + 'px',
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      main.style.removeProperty('--draft-action-height');
    };
  }, [fixedActions]);
  const [preparation, setPreparation] = useState<BatchPreparationView | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [uncertainStart, setUncertainStart] = useState<{
    previousId: string | null;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const preparedContext = useRef<{
    selection: string;
    generation: number | undefined;
    contentEpoch: number;
  } | null>(null);
  const alive = useRef(true);
  const currentKeys = [...new Set(articleKeys)];
  const articleSelection = JSON.stringify(currentKeys);
  useEffect(() => {
    setNewAttempts([]);
  }, [articleSelection]);
  const selectedAttempts = newAttempts.filter((key) =>
    currentKeys.includes(key),
  );
  const allAttempts =
    !!currentKeys.length && selectedAttempts.length === currentKeys.length;
  const held =
    !!batch.view && !['completed', 'stopped'].includes(batch.view.state);
  const attemptsBlocked =
    busy ||
    !!uncertainStart ||
    held ||
    blocked ||
    configurationBlocked ||
    batch.unknown ||
    !currentKeys.length;
  function changeAttempts(keys: string[]) {
    if (lock.current || attemptsBlocked) return;
    setPreparation(null);
    preparedContext.current = null;
    setNewAttempts(
      [...new Set(keys)].filter((key) => currentKeys.includes(key)),
    );
  }
  const selection = JSON.stringify([articleKeys, selectedAttempts]);
  const current = useRef({
    selection,
    generation: operationGeneration?.(),
    contentEpoch,
  });
  current.current = {
    selection,
    generation: operationGeneration?.(),
    contentEpoch,
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setPreparation(null);
    preparedContext.current = null;
    setNotice('');
  }, [
    selection,
    current.current.generation,
    contentEpoch,
    configurationBlocked,
  ]);
  useEffect(() => {
    onBlockedChange?.(busy || !!uncertainStart || batch.unknown || held);
  }, [busy, uncertainStart, batch.unknown, held, onBlockedChange]);
  async function prepare() {
    if (
      lock.current ||
      uncertainStart ||
      blocked ||
      configurationBlocked ||
      batch.unknown ||
      held ||
      !articleKeys.length
    )
      return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    setPreparation(null);
    const action = ++actionId.current;
    const ticket = { ...current.current };
    const valid = () =>
      alive.current &&
      action === actionId.current &&
      ticket.selection === current.current.selection &&
      ticket.generation === operationGeneration?.() &&
      ticket.contentEpoch === current.current.contentEpoch;
    try {
      if (!(await beforeWrite())) {
        if (valid())
          setNotice('当前文章或草稿操作尚未结束，请先停止操作后再检查摘要。');
        return;
      }
      if (!valid()) return;
      const state = DraftViewSchema.parse(
        await window.desktopApi.getDraftState(),
      );
      if (!valid()) return;
      if (!state.session.bindingToken || state.session.status !== 'ready') {
        setNotice(
          state.session.status === 'closed'
            ? '请先打开专用浏览器并登录。'
            : state.session.status === 'opening'
              ? '专用浏览器正在打开，请稍候。'
              : '请在现有专用浏览器中确认登录，再点“检查登录状态”。',
        );
        return;
      }
      const result = BatchPrepareResultSchema.parse(
        await window.desktopApi.batch.prepare({
          articleKeys: [...articleKeys],
          newAttemptArticleKeys: [...selectedAttempts],
          bindingToken: state.session.bindingToken,
        }),
      );
      if (!valid()) return;
      if (result.status === 'ready') {
        preparedContext.current = ticket;
        setPreparation(result.preparation);
      } else setNotice(reasons[result.reason]);
    } catch {
      if (valid()) setNotice('摘要暂时无法确认，请核对状态后重新检查。');
    } finally {
      if (action === actionId.current) {
        lock.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function command(
    kind:
      | 'start'
      | 'stop'
      | 'finish'
      | 'archiveFinishedBatch'
      | 'skipCurrentAndContinue',
  ) {
    if (kind !== 'stop' && lock.current) return;
    if (
      kind === 'start' &&
      (!preparation ||
        uncertainStart ||
        blocked ||
        configurationBlocked ||
        held ||
        batch.unknown ||
        !preparation.items.some((item) => item.state === 'queued'))
    )
      return;
    if (
      kind === 'start' &&
      (preparedContext.current?.selection !== current.current.selection ||
        preparedContext.current?.generation !== operationGeneration?.() ||
        preparedContext.current?.contentEpoch !== contentEpoch)
    ) {
      setPreparation(null);
      return;
    }
    if (kind !== 'start' && !batch.view) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    if (kind === 'start')
      setUncertainStart({ previousId: batch.view?.id ?? null });
    const selected = preparation;
    const action = ++actionId.current;
    const commandGeneration = operationGeneration?.();
    const valid = () =>
      alive.current &&
      action === actionId.current &&
      commandGeneration === operationGeneration?.();
    setPreparation(null);
    try {
      const reply = BatchCommandResultSchema.parse(
        await (kind === 'start'
          ? window.desktopApi.batch.start({
              preparationId: selected!.preparationId,
              requestId: crypto.randomUUID(),
            })
          : kind === 'skipCurrentAndContinue'
            ? window.desktopApi.batch.skipCurrentAndContinue({
                batchId: batch.view!.id,
                expectedRevision: batch.view!.revision,
                taskId:
                  batch.view!.items.find((i) =>
                    ['running', 'needs_human'].includes(i.state),
                  )?.taskId ?? null,
              })
            : window.desktopApi.batch[kind]({ batchId: batch.view!.id })),
      );
      if (!valid()) return;
      if (kind === 'start') setUncertainStart(null);
      batch.update(reply.view);
      if (reply.status === 'blocked')
        setNotice(
          reply.view?.state === 'paused' || reply.view?.state === 'interrupted'
            ? manualUploadMessage
            : reasons[reply.reason],
        );
    } catch {
      if (valid()) {
        setNotice('操作回复未确认，正在核对批次记录；请勿重复开始。');
        await batch.refresh();
      }
    } finally {
      if (valid()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (
      uncertainStart &&
      batch.view &&
      batch.view.id !== uncertainStart.previousId
    )
      setUncertainStart(null);
  }, [batch.view, uncertainStart]);
  const uploadBlocked =
    batch.view?.state === 'paused' || batch.view?.state === 'interrupted';
  const issue = uploadBlocked
    ? manualUploadMessage
    : notice ||
      (batch.unknown
        ? '批次状态暂时无法读取，请停止并初始化。'
        : held && batch.view?.reason
          ? reasons[batch.view.reason]
          : '');
  useEffect(() => {
    onIssueChange?.(issue);
  }, [issue, onIssueChange]);
  const batchMessage = uploadBlocked
    ? manualUploadMessage
    : batch.unknown
      ? '批次状态待核对'
      : !batch.view
        ? ''
        : batch.view.stopRequested && held
          ? '批次正在停止'
          : batch.view.state === 'completed'
            ? '本批次尝试已结束，保存结果待人工核对'
            : batch.view.state === 'stopped'
              ? '批次已停止'
              : batch.view.state === 'paused'
                ? '批次已暂停，请返回工作区处理'
                : batch.view.state === 'interrupted'
                  ? '上次批次已中断，需人工处理'
                  : '批次执行中';
  const batchDetail =
    batch.view && (batch.view.counts.failed || batch.view.counts.needsHuman)
      ? `；失败 ${batch.view.counts.failed} 篇，需人工处理 ${batch.view.counts.needsHuman} 篇`
      : '';
  const batchAttention =
    batch.unknown ||
    (!!batch.view &&
      (['paused', 'interrupted'].includes(batch.view.state) ||
        batch.view.counts.failed > 0 ||
        batch.view.counts.needsHuman > 0));
  useEffect(() => {
    onTaskStatusChange?.(
      batchMessage
        ? {
            message: batchMessage + batchDetail,
            needsAttention: batchAttention,
            active: held,
          }
        : null,
    );
  }, [batchMessage, batchDetail, batchAttention, held, onTaskStatusChange]);
  const batchRecord = batch.view && (
    <>
      <p role="status">
        {batch.view.state === 'completed'
          ? '本批次尝试已结束，保存结果待人工核对'
          : batch.view.state === 'stopped'
            ? '已停止'
            : batch.view.state === 'paused'
              ? '批次已暂停'
              : batch.view.state === 'interrupted'
                ? '上次批次已中断'
                : '批次执行中'}
      </p>
      <p>
        已尝试保存 {batch.view.counts.attempted} · 已核对成功{' '}
        {batch.view.counts.saved} · 失败 {batch.view.counts.failed} · 跳过{' '}
        {batch.view.counts.skipped} · 待处理 {batch.view.counts.pending} ·
        需人工处理 {batch.view.counts.needsHuman} · 未执行{' '}
        {batch.view.counts.stopped}
      </p>
      {batch.view.reason && (
        <p role="alert">
          {uploadBlocked ? manualUploadMessage : reasons[batch.view.reason]}
        </p>
      )}
      {held && !stopControl && (
        <button
          disabled={batch.view.stopRequested}
          onClick={() => void command('stop')}
        >
          停止本批次
        </button>
      )}
      {batch.view.state === 'stopped' ||
      (batch.view.state === 'completed' &&
        (batch.view.counts.failed > 0 || batch.view.counts.needsHuman > 0)) ? (
        <button
          disabled={busy || blocked}
          onClick={() => void command('archiveFinishedBatch')}
        >
          移除失败批次
        </button>
      ) : null}
      {['paused', 'interrupted'].includes(batch.view.state) && (
        <>
          <p>人工处理当前文章后，可跳过并继续；保存结果仍需人工核对。</p>
          {(!batch.view.stopRequested ||
            (batch.view.state === 'interrupted' &&
              batch.view.reason === 'RESULT_AMBIGUOUS')) && (
            <button
              disabled={busy || batch.unknown}
              onClick={() => void command('skipCurrentAndContinue')}
            >
              {busy
                ? '正在接续…'
                : batch.view.items.some((i) =>
                      ['running', 'needs_human'].includes(i.state),
                    )
                  ? '跳过这篇，继续上传'
                  : '继续上传'}
            </button>
          )}
          <p>结束后剩余文章不会上传；未确认的草稿仍需人工核对。</p>
          <button disabled={busy} onClick={() => void command('finish')}>
            结束本批次
          </button>
        </>
      )}
    </>
  );
  const executableCount =
    preparation?.items.filter((item) => item.state === 'queued').length ?? 0;
  const noExecutableReason =
    '本次无可执行文章。此前同版本提交已跳过，或文章需处理；可逐项勾选“作为新尝试”后重新检查摘要。';
  return (
    <section className="draft-panel" aria-labelledby="batch-heading">
      <div className="heading-with-help">
        <h2 id="batch-heading">批量存草稿</h2>
        <HelpTip label="批量草稿帮助">
          按勾选顺序逐篇上传巨懂车。开始前检查摘要并确认文章顺序、封面及后台门店。
        </HelpTip>
      </div>
      <p>已选择 {articleKeys.length} 篇，按勾选顺序逐篇上传巨懂车。</p>
      {coverPanel}
      <fieldset disabled={attemptsBlocked}>
        <legend>人工新尝试（默认不选）</legend>
        <p>
          此前提交可能已生成草稿；选择后需重新确认当前摘要，重复结果由运营人员核对。
        </p>
        <label>
          <input
            type="checkbox"
            aria-label={allAttempts ? '取消全选新尝试' : '全选新尝试'}
            checked={allAttempts}
            ref={(node) => {
              if (node)
                node.indeterminate =
                  selectedAttempts.length > 0 && !allAttempts;
            }}
            onChange={(event) =>
              changeAttempts(event.target.checked ? currentKeys : [])
            }
          />
          {allAttempts ? '取消全选新尝试' : '全选新尝试'}
        </label>
        <p role="status">
          已选 {selectedAttempts.length} / {currentKeys.length} 篇作为新尝试
        </p>
        {currentKeys.map((key, index) => (
          <label key={key}>
            <input
              type="checkbox"
              aria-label={'第' + (index + 1) + '篇作为新尝试'}
              checked={selectedAttempts.includes(key)}
              onChange={(event) => {
                changeAttempts(
                  event.target.checked
                    ? [...selectedAttempts, key]
                    : selectedAttempts.filter((value) => value !== key),
                );
              }}
            />
            {preparation?.items.find((item) => item.articleKey === key)
              ?.title ?? '第' + (index + 1) + '篇'}
            ：作为新尝试
          </label>
        ))}
      </fieldset>
      {batch.unknown && <p role="alert">批次状态暂时无法确认，正在核对…</p>}
      <section aria-label="本次上传确认">
        <h3>本次上传确认</h3>
        {notice && <p role="alert">{notice}</p>}
        {preparation && <p>目标门店：{preparation.storeName}</p>}
        {preparation && (
          <p>
            选择{preparation.items.length}篇，可执行
            {preparation.items.filter((item) => item.state === 'queued').length}
            篇，跳过
            {
              preparation.items.filter((item) => item.state === 'skipped')
                .length
            }
            篇，需处理
            {preparation.items.filter((item) => item.state === 'failed').length}
            篇
          </p>
        )}
        {preparation &&
          !preparation.items.some((item) => item.state === 'queued') && (
            <p role="status">{noExecutableReason}</p>
          )}
        {preparation && (
          <>
            <p>
              请确认文章顺序、封面及后台门店。保存结果由运营人员核对，可能漏存或重复；旧内容残留或安全异常将停止。
            </p>
          </>
        )}
        <div
          ref={actionBar}
          className={
            stopControl ? 'batch-action-bar fixed' : 'batch-action-bar'
          }
          role="region"
          aria-label="草稿执行操作"
        >
          <div className="batch-action-summary" aria-live="polite">
            {busy
              ? '正在处理，请等待…'
              : held
                ? '批次执行或等待处理'
                : preparation
                  ? executableCount > 0
                    ? '准备上传 ' + executableCount + ' 篇'
                    : noExecutableReason
                  : '已选择 ' + articleKeys.length + ' 篇，请先检查摘要'}
            {batch.view && held && !preparation
              ? ' · 已尝试 ' +
                batch.view.counts.attempted +
                ' / ' +
                batch.view.counts.total
              : ''}
          </div>
          <div className="batch-start-actions">
            {preparation ? (
              <>
                {' '}
                <button
                  disabled={
                    blocked ||
                    configurationBlocked ||
                    busy ||
                    !preparation.items.some((i) => i.state === 'queued')
                  }
                  onClick={() => void command('start')}
                >
                  确认逐篇存草稿
                </button>
                <button disabled={busy} onClick={() => setPreparation(null)}>
                  取消摘要
                </button>
              </>
            ) : (
              <>
                {' '}
                <button
                  disabled={
                    blocked ||
                    configurationBlocked ||
                    busy ||
                    !!uncertainStart ||
                    batch.unknown ||
                    held ||
                    !articleKeys.length
                  }
                  onClick={() => void prepare()}
                >
                  检查批量草稿摘要
                </button>
              </>
            )}
          </div>
          {stopControl && (
            <div className="batch-stop-action">{stopControl}</div>
          )}
        </div>

        {preparation && <BatchItems items={preparation.items} />}
      </section>
      {batch.view && (
        <section aria-label={held ? '当前批次执行' : '上一批次记录'}>
          <h3>{held ? '当前批次执行' : '上一批次记录'}</h3>
          {batchRecord}
          <div
            className="batch-history-scroll"
            tabIndex={0}
            aria-label="批次文章记录"
          >
            <BatchItems items={batch.view.items} />
          </div>
        </section>
      )}
    </section>
  );
}

function BatchItems({ items }: { items: BatchItemView[] }) {
  return (
    <ol>
      {items.map((item) => (
        <li key={item.articleKey}>
          <strong>{item.title}</strong>
          <p>
            {item.coverSummary?.mode === 'single'
              ? '单图封面'
              : item.coverSummary?.mode === 'triple'
                ? '三图封面'
                : '无封面'}{' '}
            ·{' '}
            {item.state === 'skipped' && item.submission
              ? '此前已提交，本次跳过'
              : labels[item.state]}
          </p>
          {item.state === 'submission_recorded' || item.submission ? (
            <p>
              {item.submission?.observation === 'rejected'
                ? '保存返回失败，待人工核对'
                : item.submission?.observation === 'acknowledged'
                  ? '平台已响应，实际草稿待人工核对'
                  : '保存结果未知，待人工核对'}
            </p>
          ) : (
            item.reason && (
              <p role="alert">
                {['needs_human', 'failed'].includes(item.state)
                  ? manualUploadMessage
                  : reasons[item.reason]}
              </p>
            )
          )}
          {item.submission &&
            item.state !== 'submission_recorded' &&
            item.state !== 'skipped' &&
            item.reason && (
              <p role="alert">
                {['needs_human', 'failed'].includes(item.state)
                  ? manualUploadMessage
                  : reasons[item.reason]}
              </p>
            )}
          {item.state === 'skipped' && item.taskId && item.saveAttempted && (
            <p>曾尝试保存，原保存结果仍需人工核对；不会重传这篇。</p>
          )}
          {item.coverReport &&
            !['needs_human', 'failed'].includes(item.state) &&
            item.state !== 'submission_recorded' &&
            !item.submission && (
              <CoverTaskResult
                task={{
                  state:
                    item.state === 'draft_saved' ? 'draft_saved' : 'running',
                  coverReport: item.coverReport,
                }}
              />
            )}
        </li>
      ))}
    </ol>
  );
}

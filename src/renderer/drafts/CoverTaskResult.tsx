import type { TaskView } from '../../contracts/draft-task';
const coverReasons: Record<
  NonNullable<NonNullable<TaskView['coverReport']>['reason']>,
  string
> = {
  IMAGE_UNAVAILABLE: '本机封面图片无法读取。',
  UPLOAD_REJECTED: '平台未接受封面图片。',
  UPLOAD_INCOMPLETE: '封面上传数量不足。',
  LIBRARY_OPTION_UNVERIFIED: '无法确认未保存到平台素材库。',
  COVER_MISMATCH: '重开草稿后的封面与所选图片不一致。',
  COVER_REQUIRED: '平台要求补充封面，请人工处理。',
  COVER_UPLOAD_FAILED: '封面上传未完成，本篇草稿未保存。',
  PAGE_UNVERIFIED: '封面显示状态尚未核实，请人工核对。',
};
export const coverModeLabel = (mode: 'none' | 'single' | 'triple') =>
  mode === 'none' ? '无封面' : mode === 'single' ? '单图' : '三图';
export function CoverTaskResult({
  task,
}: {
  task: Pick<TaskView, 'state' | 'coverReport'>;
}) {
  const report = task.coverReport;
  if (!report) return <p>历史封面由人工处理；此记录没有本地封面上传结果。</p>;
  const warning = report.phase === 'failed' || report.phase === 'needs_human';
  return (
    <div className="cover-result" role={warning ? 'alert' : undefined}>
      <p>
        {report.phase === 'confirmed'
          ? '封面已上传并核对'
          : warning
            ? task.state === 'draft_saved'
              ? '草稿已保存；封面未上传成功，请人工补充'
              : '封面未完成，请人工核对'
            : report.phase === 'not_configured'
              ? '未配置封面，将由运营人员人工补充'
              : report.phase === 'uploading'
                ? '封面正在上传，仍待重开核对'
                : '封面仍待重开核对'}
      </p>
      <p>
        请求{coverModeLabel(report.requestedMode)} · 期望{report.expectedCount}
        张 · {report.phase === 'confirmed' ? '已核对' : '已关联'}
        {report.confirmedCount}/{report.expectedCount}张
        {report.phase !== 'confirmed' ? '；关联数量不代表封面已完成' : ''}
      </p>
      {report.reason && <p>{coverReasons[report.reason]}</p>}
    </div>
  );
}

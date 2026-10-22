import type { CandidateView, PasteErrorCode } from '../../contracts/web-paste';

export const pasteErrorMessages: Record<PasteErrorCode, string> = {
  EMPTY: '没有可加入的正文，请先复制网页中的文字或图文',
  INPUT_LIMIT: '本次内容超出支持范围，请减少内容后再粘贴',
  PARSE_LIMIT: '本次内容超出支持范围，请减少内容后再粘贴',
  PARSE_TIMEOUT: '粘贴内容暂时无法整理，请减少内容后再粘贴',
  UNSUPPORTED_STRUCTURE: '暂不支持表格或媒体等内容，请重新复制基本图文',
  INVALID_FRAGMENT: '粘贴内容无法安全整理，请重新复制基本图文',
  SOURCE_UNSUPPORTED: '图片来源暂不支持，请移除该位置或重新复制',
  IMAGE_NETWORK: '图片未能取得，可重试或移除',
  IMAGE_TIMEOUT: '图片取得超时，可重试或移除',
  IMAGE_INVALID: '图片内容无法读取，请移除该位置或重新复制',
  IMAGE_UNSUPPORTED: '图片格式暂不支持，请移除该位置或重新复制',
  IMAGE_LIMIT: '图片超出支持范围，请减少内容或移除该位置',
  OPERATION_TIMEOUT: '图片处理超时，可重试或移除',
  CANCELLED: '图片尚未完成，可重试或移除',
  RECOVERY_REQUIRED: '文章功能暂时无法使用，请关闭后重试',
};
export function PendingImage({
  candidate,
  disabled,
  onRetry,
}: {
  candidate: CandidateView;
  disabled: boolean;
  onRetry(): void;
}) {
  const waiting =
    candidate.state === 'waiting' || candidate.state === 'fetching';
  return (
    <div role={waiting ? 'status' : 'alert'} className="pending-image">
      <p>
        {waiting
          ? candidate.state === 'fetching'
            ? '图片正在取得…'
            : '图片等待处理…'
          : pasteErrorMessages[candidate.reason ?? 'IMAGE_NETWORK']}
      </p>
      {!waiting && candidate.retryable && (
        <button disabled={disabled} aria-label="重试正文图片" onClick={onRetry}>
          重试图片
        </button>
      )}
    </div>
  );
}

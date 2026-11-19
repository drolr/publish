import type { ReasonCode } from '../../contracts/draft-task';
export const manualUploadMessage = '上传遇到问题，请人工处理。';
export const reasons: Record<ReasonCode, string> = {
  FORMAT_UNSUPPORTED: '这篇文章包含当前平台尚未支持的格式',
  INPUT_UNSUPPORTED: '文章内容不符合要求，请检查本地文章。',
  TITLE_UNSUPPORTED: '标题不符合要求，请检查本地文章。',
  IMAGE_FORMAT_UNSUPPORTED: '正文图片只支持 JPEG 或 PNG。',
  IMAGE_SIZE_UNSUPPORTED: '正文单张图片不能超过 10 MB。',
  ASSET_UNAVAILABLE: '文章图片无法读取，请检查本地素材。',
  STALE_PREPARATION: '文章或会话已变化，请重新检查文章摘要。',
  LOGIN_REQUIRED: '请在专用浏览器中登录，再检查登录状态。',
  VERIFICATION_REQUIRED: '请在专用浏览器中完成人工验证，再核对状态。',
  PERMISSION_DENIED: '当前账号权限不足，请在后台核对。',
  STORE_UNCONFIRMED:
    '当前无法可靠确认门店，操作已暂停，请核对后台门店或联系维护人员。',
  STORE_CHANGED: '当前门店发生变化，操作已暂停，请核对门店。',
  PAGE_CHANGED: '后台页面暂时无法确认，操作已暂停。',
  EDITOR_NOT_EMPTY:
    '新建页恢复了旧内容或无法确认空白，批次已停止；请保留页面并人工处理。',
  COVER_REQUIRED: '封面未完成，平台未允许保存草稿，请人工处理。',
  COVER_UPLOAD_FAILED: '封面上传未完成，本篇未保存；批次已暂停，可稍后重试。',
  COVER_UNAVAILABLE:
    '展示封面未确认为空，尚未点击存草稿。请保留页面并联系维护人员。',
  DECLARATION_REQUIRED: '后台要求确认声明，请人工核对。',
  RESULT_AMBIGUOUS: '草稿状态尚未确认，请先核对后台记录。',
  MANUAL_REVIEW_REQUIRED:
    '平台已接受本次存草稿，待人工核对。请在巨懂车检查唯一草稿、标题、正文图片和顺序；不要再次保存。',
  CONTENT_MISMATCH: '草稿内容核对未通过，请人工核对。',
  BROWSER_UNAVAILABLE: '专用浏览器暂时不可用，请查看下方浏览器状态并重新检查。',
  BROWSER_UNSUPPORTED:
    '浏览器基础检查未通过，请查看下方浏览器状态并按提示处理。',
  STORAGE_UNAVAILABLE: '本地记录暂时无法确认，请保留现场并联系维护人员。',
  STOP_REQUESTED: '已请求停止，请核对已完成的操作。',
  INTERRUPTED: '上次操作中断，请先核对状态。',
  NEW_ATTEMPT_REQUIRED:
    '历史记录缺少版本信息，请勾选“作为新尝试”后重新检查当前摘要。',
  PLATFORM_BUSY: '当前有操作尚未结束，请等待后再检查。',
};

export const importMessages = {
  FILE_INVALID: '文章包内容无法识别，请提供有效的 UTF-8 JSON 文件。',
  FILE_TOO_LARGE: '文章包文件过大，请提供不超过 2 MiB 的文件。',
  FILE_UNAVAILABLE: '文章包文件无法读取，请重新选择本地文件。',
  IMAGE_UNAVAILABLE: '图片无法取得，请检查素材后重试。',
  IMAGE_UNSUPPORTED: '图片格式暂不支持，请使用单帧 JPEG、PNG 或 WebP。',
  IMAGE_INVALID: '图片内容损坏，请重新提供。',
  IMAGE_LIMIT_EXCEEDED: '图片超出当前支持范围，请减少大小后重试。',
  SOURCE_NOT_ALLOWED: '图片来源无法安全读取，请重新提供。',
  STORAGE_UNAVAILABLE: '文章暂时无法保存，请检查本地存储后重试。',
  RECOVERY_REQUIRED: '上次导入尚未安全恢复，请关闭应用后重试。',
} as const;
export type ImportErrorCode = keyof typeof importMessages;
export class ImportFailure extends Error {
  constructor(public readonly code: ImportErrorCode) {
    super(importMessages[code]);
    this.name = 'ImportFailure';
  }
}

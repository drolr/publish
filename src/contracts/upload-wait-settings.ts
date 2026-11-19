import { z } from 'zod';
const seconds = z.number().int().min(1).max(300);
export const UploadWaitSettingsSchema = z.strictObject({
  编辑页等待秒数: seconds,
  正文光标点击秒数: seconds,
  图片按钮和选文件秒数: seconds,
  正文图片预览秒数: seconds,
  图片插入和弹窗关闭秒数: seconds,
  封面上传完成秒数: seconds,
});
export type UploadWaitSettings = z.infer<typeof UploadWaitSettingsSchema>;
export const OPEN_UPLOAD_SETTINGS = 'upload-waits:open-dialog';
export interface UploadWaitSettingsApi {
  onOpenUploadSettings(listener: () => void): () => void;
  getUploadWaitSettings(): Promise<UploadWaitSettings>;
  saveUploadWaitSettings(
    settings: UploadWaitSettings,
  ): Promise<UploadWaitSettings>;
}
export const waitSettingsChannels = {
  getUploadWaitSettings: 'upload-waits:get',
  saveUploadWaitSettings: 'upload-waits:save',
} as const;
export const waitSettingsRequests = {
  getUploadWaitSettings: z.tuple([]),
  saveUploadWaitSettings: z.tuple([UploadWaitSettingsSchema]),
};

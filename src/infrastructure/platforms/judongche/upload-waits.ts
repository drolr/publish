import { UploadWaitSettingsSchema } from '../../../contracts/upload-wait-settings';
import defaults from '../../../../config/上传等待设置.json';
export function parseUploadWaits(data: unknown) {
  const value = UploadWaitSettingsSchema.parse(data);
  return {
    editor: value.编辑页等待秒数 * 1000,
    caretClick: value.正文光标点击秒数 * 1000,
    imageAction: value.图片按钮和选文件秒数 * 1000,
    preview: value.正文图片预览秒数 * 1000,
    settleImage: value.图片插入和弹窗关闭秒数 * 1000,
    cover: value.封面上传完成秒数 * 1000,
  };
}
export const defaultUploadWaits = parseUploadWaits(defaults);
export type UploadWaits = Readonly<typeof defaultUploadWaits>;

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UploadWaitSettings } from '../contracts/upload-wait-settings';

const labels = {
  编辑页等待秒数: '打开文章编辑页',
  正文光标点击秒数: '定位正文光标',
  图片按钮和选文件秒数: '点击图片按钮和选择文件',
  正文图片预览秒数: '加载正文图片预览',
  图片插入和弹窗关闭秒数: '插入图片并关闭弹窗',
  封面上传完成秒数: '等待封面上传完成',
} satisfies Record<keyof UploadWaitSettings, string>;
const fields = Object.keys(labels) as (keyof UploadWaitSettings)[];

function SettingsDialog({ onClose }: { onClose(saved: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<UploadWaitSettings>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    const element = dialog.current!;
    element.showModal();
    window.desktopApi.getUploadWaitSettings().then(
      (value) => {
        if (active) setSettings(value);
      },
      () => {
        if (active) setError('读取失败，请关闭设置后重试。');
      },
    );
    return () => {
      active = false;
      element.close();
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving) return;
    const data = new FormData(event.currentTarget);
    const next = { ...settings };
    for (const field of fields) next[field] = Number(data.get(field));
    setSaving(true);
    setError('');
    try {
      await window.desktopApi.saveUploadWaitSettings(next);
      onClose(true);
    } catch {
      setError('保存失败，请重试。');
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="upload-wait-dialog"
      aria-labelledby="wait-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose(false);
      }}
    >
      <h2 id="wait-settings-title">上传等待时间</h2>
      <p>
        每项可填 1 到 300
        秒。页面提前准备好时，助手会立即继续。保存后从下一篇文章生效。
      </p>
      <form onSubmit={save}>
        {settings ? (
          <fieldset disabled={saving}>
            {fields.map((field) => (
              <label key={field}>
                <span>{labels[field]}</span>
                <input
                  name={field}
                  type="number"
                  min="1"
                  max="300"
                  step="1"
                  required
                  defaultValue={settings[field]}
                />
                <span>秒</span>
              </label>
            ))}
          </fieldset>
        ) : (
          !error && <p role="status">正在读取设置…</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="wait-settings-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() => onClose(false)}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!settings || saving}
          >
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function UploadWaitSettingsMenuDialog() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(
    () =>
      window.desktopApi?.onOpenUploadSettings?.(() => {
        setSaved(false);
        setOpen(true);
      }),
    [],
  );
  return (
    <>
      {saved && (
        <p className="wait-settings-saved" role="status">
          等待时间已保存，从下一篇文章生效。
        </p>
      )}
      {open && (
        <SettingsDialog
          onClose={(didSave) => {
            setOpen(false);
            setSaved(didSave);
          }}
        />
      )}
    </>
  );
}

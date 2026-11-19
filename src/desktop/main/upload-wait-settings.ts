import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ipcMain, Menu, type BrowserWindow } from 'electron';
import defaults from '../../../config/上传等待设置.json';
import {
  OPEN_UPLOAD_SETTINGS,
  UploadWaitSettingsSchema,
  waitSettingsChannels,
  waitSettingsRequests,
} from '../../contracts/upload-wait-settings';
import { isTrustedSender } from './ipc-policy';

const filename = '上传等待设置.json';
export function registerUploadWaitSettings(
  window: BrowserWindow,
  entryUrl: string,
  userDirectory: string,
  programDirectory: string | undefined,
  onInvalid: () => void,
) {
  const trustedUrl = new URL(entryUrl).href;
  const menu = Menu.buildFromTemplate([
    {
      id: 'open-upload-settings',
      label: 'Settings',
      click: () => {
        if (!window.isDestroyed() && window.webContents.getURL() === trustedUrl)
          window.webContents.send(OPEN_UPLOAD_SETTINGS);
      },
    },
    ...(Menu.getApplicationMenu()?.items ?? []),
  ]);
  Menu.setApplicationMenu(menu);
  const savedPath = join(userDirectory, filename);
  const paths = programDirectory
    ? [savedPath, join(programDirectory, filename)]
    : [savedPath];
  let settings = UploadWaitSettingsSchema.parse(defaults);
  for (const path of paths) {
    try {
      if (statSync(path).size > 8192) throw Error('Invalid settings');
      settings = UploadWaitSettingsSchema.parse(
        JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')),
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        onInvalid();
        break;
      }
    }
  }
  for (const method of Object.keys(
    waitSettingsChannels,
  ) as (keyof typeof waitSettingsChannels)[]) {
    const channel = waitSettingsChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event, window.webContents, entryUrl))
        throw Error('Request rejected');
      const request = waitSettingsRequests[method].safeParse(args);
      if (!request.success) throw Error('Request rejected');
      const [next] = request.data;
      if (next) {
        const temporary = savedPath + '.' + randomUUID() + '.tmp';
        try {
          writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {
            flag: 'wx',
          });
          renameSync(temporary, savedPath);
          settings = next;
        } catch {
          throw Error('Settings could not be saved');
        } finally {
          try {
            rmSync(temporary, { force: true });
          } catch {
            /* The original settings are preserved on failure. */
          }
        }
      }
      return settings;
    });
    window.once('closed', () => ipcMain.removeHandler(channel));
  }
  return () => settings;
}

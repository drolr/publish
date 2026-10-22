import { ipcMain, type BrowserWindow } from 'electron';
import {
  APP_STATUS_CHANNEL,
  AppStatusSchema,
  NoArgumentsSchema,
  type AppStatus,
} from '../../contracts/app-status';
import { isTrustedSender } from './ipc-policy';
export function registerStatusHandler(
  window: BrowserWindow,
  entryUrl: string,
  query: () => AppStatus,
): void {
  ipcMain.removeHandler(APP_STATUS_CHANNEL);
  ipcMain.handle(APP_STATUS_CHANNEL, (event, ...args: unknown[]) => {
    if (
      !isTrustedSender(event, window.webContents, entryUrl) ||
      !NoArgumentsSchema.safeParse(args).success
    )
      throw new Error('Request rejected');
    return AppStatusSchema.parse(query());
  });
  window.once('closed', () => ipcMain.removeHandler(APP_STATUS_CHANNEL));
}

import { ipcMain, type BrowserWindow } from 'electron';
import {
  browserHealthChannels,
  browserHealthRequestSchemas,
  browserHealthResponseSchemas,
  type BrowserHealthApi,
} from '../../contracts/browser-health';
import { isTrustedSender } from './ipc-policy';
export function registerBrowserHealthHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: BrowserHealthApi,
): void {
  const methods = Object.keys(
    browserHealthChannels,
  ) as (keyof BrowserHealthApi)[];
  for (const method of methods) {
    const channel = browserHealthChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !browserHealthRequestSchemas[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return browserHealthResponseSchemas[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods)
      ipcMain.removeHandler(browserHealthChannels[method]);
  });
}

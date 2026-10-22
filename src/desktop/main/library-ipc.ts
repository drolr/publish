import { ipcMain, type BrowserWindow } from 'electron';
import {
  libraryChannels,
  libraryRequests,
  libraryResponses,
  type ArticleLibraryApi,
} from '../../contracts/article-library';
import { isTrustedSender } from './ipc-policy';
export function registerLibraryHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: ArticleLibraryApi,
): void {
  const methods = Object.keys(libraryChannels) as (keyof ArticleLibraryApi)[];
  for (const method of methods) {
    const channel = libraryChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !libraryRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return libraryResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods)
      ipcMain.removeHandler(libraryChannels[method]);
  });
}

import { ipcMain, type BrowserWindow } from 'electron';
import {
  articleDeletionChannels,
  articleDeletionRequests,
  articleDeletionResponses,
  type ArticleDeletionApi,
} from '../../contracts/article-delete';
import { isTrustedSender } from './ipc-policy';
export function registerArticleDeletionHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: ArticleDeletionApi,
): void {
  const methods = Object.keys(
    articleDeletionChannels,
  ) as (keyof ArticleDeletionApi)[];
  for (const method of methods) {
    const channel = articleDeletionChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !articleDeletionRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return articleDeletionResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods)
      ipcMain.removeHandler(articleDeletionChannels[method]);
  });
}

import { ipcMain, type BrowserWindow } from 'electron';
import {
  articleCoverChannels,
  articleCoverRequests,
  articleCoverResponses,
  type ArticleCoverApi,
} from '../../contracts/article-cover';
import { isTrustedSender } from './ipc-policy';
export function registerArticleCoverHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: ArticleCoverApi,
): void {
  const methods = Object.keys(
    articleCoverChannels,
  ) as (keyof ArticleCoverApi)[];
  for (const method of methods) {
    const channel = articleCoverChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !articleCoverRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return articleCoverResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods)
      ipcMain.removeHandler(articleCoverChannels[method]);
  });
}

import { ipcMain, type BrowserWindow } from 'electron';
import {
  batchChannels,
  batchRequests,
  batchResponses,
  type BatchApi,
} from '../../contracts/draft-batch';
import { isTrustedSender } from './ipc-policy';
export function registerBatchHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: BatchApi,
): void {
  const methods = Object.keys(batchChannels) as (keyof BatchApi)[];
  for (const method of methods) {
    const channel = batchChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !batchRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return batchResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods) ipcMain.removeHandler(batchChannels[method]);
  });
}

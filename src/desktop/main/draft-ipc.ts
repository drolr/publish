import { ipcMain, type BrowserWindow } from 'electron';
import {
  draftChannels,
  draftRequests,
  draftResponses,
  type DraftApi,
} from '../../contracts/draft-task';
import { isTrustedSender } from './ipc-policy';
export function registerDraftHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: DraftApi,
): void {
  const methods = Object.keys(draftChannels) as (keyof DraftApi)[];
  for (const method of methods) {
    const channel = draftChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !draftRequests[method].safeParse(args).success
      )
        throw new Error('Request rejected');
      try {
        return draftResponses[method].parse(
          await Reflect.apply(api[method], api, args),
        );
      } catch {
        throw new Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods) ipcMain.removeHandler(draftChannels[method]);
  });
}

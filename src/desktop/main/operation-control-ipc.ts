import { ipcMain, type BrowserWindow } from 'electron';
import {
  operationControlChannels,
  OperationControlRequestSchema,
  OperationControlViewSchema,
  type OperationControlApi,
} from '../../contracts/operation-control';
import { isTrustedSender } from './ipc-policy';

export function registerOperationControlHandlers(
  window: BrowserWindow,
  entryUrl: string,
  api: OperationControlApi,
): void {
  const methods = Object.keys(
    operationControlChannels,
  ) as (keyof OperationControlApi)[];
  for (const method of methods) {
    const channel = operationControlChannels[method];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (
        !isTrustedSender(event, window.webContents, entryUrl) ||
        !OperationControlRequestSchema.safeParse(args).success
      )
        throw Error('Request rejected');
      try {
        return OperationControlViewSchema.parse(await api[method]());
      } catch {
        throw Error('Request unavailable');
      }
    });
  }
  window.once('closed', () => {
    for (const method of methods)
      ipcMain.removeHandler(operationControlChannels[method]);
  });
}

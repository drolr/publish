import { ipcMain, type BrowserWindow } from 'electron';
import {
  manualCloseChannels,
  ManualCloseReadySchema,
  ManualCloseRequestSchema,
} from '../../contracts/editor-close';
import type { ManualState } from '../../contracts/manual-article';
import { isTrustedSender } from './ipc-policy';
export interface BlockedCloseProof {
  requestId: string;
  sessionId: string;
  documentRevision: number;
  status: 'blocked';
}
type FlushResult = boolean | BlockedCloseProof;
/** The ready latch belongs to the window, not the transient subscription. */
export function registerManualCloseHandlers(
  window: BrowserWindow,
  entryUrl: string,
  state: () => ManualState,
  newId: () => string,
) {
  let enabled = false;
  let proof: BlockedCloseProof | undefined;
  let closed = false;
  let pending:
    | {
        requestId: string;
        sessionId: string;
        promise: Promise<FlushResult>;
        settle(value: FlushResult): void;
      }
    | undefined;
  const ready = (
    event: Parameters<typeof isTrustedSender>[0],
    ...args: unknown[]
  ) => {
    if (
      isTrustedSender(event, window.webContents, entryUrl) &&
      ManualCloseReadySchema.safeParse(args).success
    )
      enabled = true;
  };
  ipcMain.on(manualCloseChannels.ready, ready);
  window.once('closed', () => {
    ipcMain.removeListener(manualCloseChannels.ready, ready);
    closed = true;
    proof = undefined;
    pending?.settle(false);
  });
  return {
    enabled: () => enabled,
    isPending: () => !!pending,
    isCurrentBlocked(value: FlushResult): value is BlockedCloseProof {
      const current = state();
      const valid =
        !!proof &&
        value === proof &&
        !closed &&
        !pending &&
        'sessionId' in current &&
        current.sessionId === proof.sessionId &&
        current.documentRevision === proof.documentRevision;
      if (!valid) proof = undefined;
      return valid;
    },
    retireBlocked() {
      proof = undefined;
    },
    requestFlush(): Promise<FlushResult> {
      if (closed) return Promise.resolve(false);
      if (!enabled) return Promise.resolve(true);
      if (pending) return pending.promise;
      proof = undefined;
      const current = state();
      if (!('sessionId' in current)) return Promise.resolve(true);
      if (
        !isTrustedSender(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          },
          window.webContents,
          entryUrl,
        )
      )
        return Promise.resolve(false);
      const requestId = newId();
      let resolve!: (value: FlushResult) => void;
      const promise = new Promise<FlushResult>((r) => {
        resolve = r;
      });
      const timer = setTimeout(
        () => pending?.requestId === requestId && pending.settle(false),
        30_000,
      );
      pending = {
        requestId,
        sessionId: current.sessionId,
        promise,
        settle(value) {
          clearTimeout(timer);
          pending = undefined;
          resolve(value);
        },
      };
      try {
        window.webContents.send(
          manualCloseChannels.request,
          ManualCloseRequestSchema.parse({ requestId }),
        );
      } catch {
        pending.settle(false);
      }
      return promise;
    },
    respond(
      requestId: string,
      sessionId: string,
      documentRevision: number,
      status: 'flushed' | 'blocked',
    ): boolean {
      const current = state();
      if (
        !pending ||
        pending.requestId !== requestId ||
        pending.sessionId !== sessionId ||
        !('sessionId' in current) ||
        current.sessionId !== sessionId ||
        current.documentRevision !== documentRevision
      )
        return false;
      if (status === 'blocked') {
        proof = { requestId, sessionId, documentRevision, status };
        pending.settle(proof);
      } else pending.settle(true);
      return true;
    },
  };
}

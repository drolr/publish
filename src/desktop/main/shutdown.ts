import type { createManualArticleController } from '../../application/manual-article';
interface Preventable {
  preventDefault(): void;
}
interface QuitHost {
  on(event: 'before-quit', listener: (event: Preventable) => void): unknown;
  quit(): void;
}
interface WindowHost {
  on(event: 'close', listener: (event: Preventable) => void): unknown;
  destroy(): void;
}
interface Operation {
  isActive(): boolean;
  stopAndWait(): Promise<void>;
}
export function protectShutdown(
  app: QuitHost,
  window: WindowHost,
  operation: Operation | undefined,
  close: () => void,
  confirm?: () => Promise<boolean>,
): () => boolean {
  let closing = false;
  let stopping = false;
  let closed = false;
  const closeOnce = () => {
    if (!closed) {
      close();
      closed = true;
    }
  };
  const stop = (event: Preventable) => {
    closing = true;
    if (closed) return;
    if (!operation && !confirm && !stopping) {
      closeOnce();
      return;
    }
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    const settle = async () => {
      if (confirm && !(await confirm())) {
        closing = false;
        stopping = false;
        return;
      }
      await operation?.stopAndWait();
      closeOnce();
      window.destroy();
      app.quit();
    };
    void settle().catch(() => {
      console.error('SHUTDOWN_FAILED');
      stopping = false;
    });
  };
  app.on('before-quit', stop);
  window.on('close', stop);
  return () => closing;
}

export async function confirmManualShutdown(
  manual:
    | Pick<
        ReturnType<typeof createManualArticleController>,
        'getManualArticleState' | 'hasSession' | 'isActive'
      >
    | undefined,
  confirmDiscard: () => Promise<boolean>,
): Promise<boolean> {
  if (!manual) return true;
  const state = manual.getManualArticleState();
  // A known commit is not unsaved loss, even while the cleanup owns the writer.
  if ('sessionId' in state && state.result?.status === 'imported') return true;
  if (!manual.hasSession() && !manual.isActive()) return true;
  return confirmDiscard();
}

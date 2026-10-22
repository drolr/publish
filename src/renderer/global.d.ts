import type { DesktopApi } from '../contracts/app-status';
declare global {
  interface Window {
    /** Narrow typed requests including nine cover methods, deletion/receipt inspection and the fixed editor-close event subscription. */
    desktopApi: DesktopApi;
  }
}

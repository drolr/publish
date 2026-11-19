import type {
  BrowserHealthResult,
  BrowserHealthView,
} from '../../contracts/browser-health';
export interface BrowserHealthRuntime {
  checkHealth(): Promise<BrowserHealthResult>;
  openUpdate(): Promise<BrowserHealthResult>;
  invalidateHealth(): void;
  isOccupied(): boolean;
  hasBusinessSession(): boolean;
  subscribeHealth(listener: (view: BrowserHealthView) => void): () => void;
}

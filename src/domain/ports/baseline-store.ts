export interface BaselineStore {
  getSchemaVersion(): number;
  close(): void;
}

import Database from 'better-sqlite3';
import type { BaselineStore } from '../../domain/ports/baseline-store';
import { migrate, readMigrations } from './migrate';
export function openBaselineStore(
  databasePath: string,
  migrationsDirectory: string,
): BaselineStore {
  const migrations = readMigrations(migrationsDirectory);
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    migrate(db, migrations);
    return {
      getSchemaVersion() {
        return (
          db
            .prepare('SELECT MAX(version) AS version FROM schema_migrations')
            .get() as { version: number }
        ).version;
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

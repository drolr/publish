// Test-only database setup. Never imported by application entry points.
import Database from 'better-sqlite3';
export const upgradeSql =
  "CREATE TABLE test_marker(value TEXT NOT NULL); INSERT INTO test_marker VALUES ('kept');";
export const failingSql =
  'CREATE TABLE should_rollback(value TEXT); INSERT INTO missing_table VALUES (1);';
export function inspectDatabase(path: string) {
  const db = new Database(path);
  try {
    return {
      versions: (
        db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as { version: number }[]
      ).map((row) => row.version),
      tables: (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    };
  } finally {
    db.close();
  }
}
export function corruptHistory(path: string) {
  const db = new Database(path);
  try {
    db.prepare(
      "UPDATE schema_migrations SET checksum='changed' WHERE version=1",
    ).run();
  } finally {
    db.close();
  }
}
export function seedFutureDatabase(path: string) {
  const db = new Database(path);
  try {
    db.prepare(
      "INSERT INTO schema_migrations VALUES (2, 'future.sql', 'future', '2026-09-15')",
    ).run();
  } finally {
    db.close();
  }
}

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
export function readMigrations(directory: string): Migration[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (!names.length) throw new Error('Missing migration sequence');
  return names.map((name, index) => {
    const match = /^(\d{4})_[a-z0-9_-]+\.sql$/.exec(name);
    if (!match || Number(match[1]) !== index + 1)
      throw new Error('Invalid migration sequence');
    const sql = readFileSync(join(directory, name), 'utf8');
    return {
      version: index + 1,
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}
export function migrate(db: Database.Database, migrations: Migration[]): void {
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = db
      .prepare(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      .all() as Omit<Migration, 'sql'>[];
    if (applied.some((row) => row.version > migrations.length))
      throw new Error('Database is newer than this application');
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index];
      if (
        row.version !== index + 1 ||
        row.name !== expected.name ||
        row.checksum !== expected.checksum
      )
        throw new Error('Migration history mismatch');
    }
    for (const item of migrations.slice(applied.length)) {
      db.transaction(() => {
        db.exec(item.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?,?,?,?)',
        ).run(item.version, item.name, item.checksum, new Date().toISOString());
      })();
    }
  })();
}

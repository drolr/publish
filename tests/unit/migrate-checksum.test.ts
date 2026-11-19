import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';
import { readMigrations } from '../../src/infrastructure/persistence/migrate';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
const sql =
  "CREATE TABLE marker(value TEXT);\nINSERT INTO marker VALUES ('kept');\n";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup(content = sql) {
  const root = mkdtempSync(join(tmpdir(), 'migrate-checksum-'));
  roots.push(root);
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  writeFileSync(join(migrations, '0001_baseline.sql'), content);
  return { root, migrations, db: join(root, 'app.sqlite') };
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function history(dbPath: string) {
  const db = new Database(dbPath);
  try {
    return db.prepare('SELECT checksum FROM schema_migrations').all();
  } finally {
    db.close();
  }
}
function replaceChecksum(dbPath: string, checksum: string) {
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE schema_migrations SET checksum=?').run(checksum);
  } finally {
    db.close();
  }
}
it.each([
  ['LF', sql],
  ['CRLF', sql.split(LF).join(CRLF)],
  ['lone CR', sql.split(LF).join(CR)],
])('%s line endings normalize to the same checksum', (_label, content) => {
  const { migrations } = setup(content);
  expect(readMigrations(migrations)).toMatchObject([
    { version: 1, checksum: hash(sql) },
  ]);
});
it('stores the normalized checksum when the migration file is CRLF', () => {
  const { db, migrations } = setup(sql.split(LF).join(CRLF));
  openBaselineStore(db, migrations).close();
  expect(history(db)).toEqual([{ checksum: hash(sql) }]);
});
it('refuses a migration whose content changed after normalization', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  writeFileSync(
    join(migrations, '0001_baseline.sql'),
    sql.split('kept').join('changed').split(LF).join(CRLF),
  );
  expect(() => openBaselineStore(db, migrations)).toThrow(/history/i);
});
it('accepts a stored CRLF checksum for the current LF migration without rewriting it', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  const legacy = hash(sql.split(LF).join(CRLF));
  expect(legacy).not.toBe(hash(sql));
  replaceChecksum(db, legacy);
  openBaselineStore(db, migrations).close();
  expect(history(db)).toEqual([{ checksum: legacy }]);
});
it('accepts the raw byte checksum of a migration with mixed line endings', () => {
  const mixed =
    'CREATE TABLE marker(value TEXT);' +
    CRLF +
    "INSERT INTO marker VALUES ('kept');" +
    LF;
  const { db, migrations } = setup(mixed);
  openBaselineStore(db, migrations).close();
  replaceChecksum(db, hash(mixed));
  expect(hash(mixed)).not.toBe(hash(sql));
  openBaselineStore(db, migrations).close();
  expect(history(db)).toEqual([{ checksum: hash(mixed) }]);
});
it('still refuses tampered content when the stored checksum is a CRLF legacy hash', () => {
  const { db, migrations } = setup();
  openBaselineStore(db, migrations).close();
  replaceChecksum(db, hash(sql.split(LF).join(CRLF)));
  writeFileSync(
    join(migrations, '0001_baseline.sql'),
    sql.split('kept').join('tampered'),
  );
  expect(() => openBaselineStore(db, migrations)).toThrow(/history/i);
});
it('keeps the recorded LF checksum of the shipped 0008 migration', () => {
  const migrations = readMigrations(
    resolve('src/infrastructure/persistence/migrations'),
  );
  expect(migrations[7]).toMatchObject({
    version: 8,
    name: '0008_article_covers.sql',
    checksum:
      '88cf36b10e658592ef962682659e37ae26c68aab7b6f724587a3aa94fd21087d',
  });
});

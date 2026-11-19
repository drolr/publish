import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../../src/contracts/storage-version';
import { openBaselineStore } from '../../src/infrastructure/persistence/database';

const directory = resolve('src/infrastructure/persistence/migrations');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const names = readdirSync(directory).sort();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function history(dbPath: string) {
  const db = new Database(dbPath);
  try {
    return db
      .prepare(
        'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
      )
      .all() as { version: number; name: string; checksum: string }[];
  } finally {
    db.close();
  }
}
function setChecksum(dbPath: string, version: number, checksum: string) {
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(
      checksum,
      version,
    );
  } finally {
    db.close();
  }
}
function crlfCopy(root: string) {
  const target = join(root, 'crlf-migrations');
  mkdirSync(target);
  for (const name of names)
    writeFileSync(
      join(target, name),
      readFileSync(join(directory, name), 'utf8').split(LF).join(CRLF),
    );
  return target;
}
it('starts when history holds the CRLF checksum of a shipped LF migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-legacy-lf-'));
  roots.push(root);
  const dbPath = join(root, 'app.sqlite');
  openBaselineStore(dbPath, directory).close();
  const before = history(dbPath);
  const legacy = hash(
    readFileSync(join(directory, '0008_article_covers.sql'), 'utf8')
      .split(LF)
      .join(CRLF),
  );
  expect(legacy).not.toBe(before[7].checksum);
  setChecksum(dbPath, 8, legacy);
  const store = openBaselineStore(dbPath, directory);
  try {
    expect(store.getSchemaVersion()).toBe(STORAGE_SCHEMA_VERSION);
  } finally {
    store.close();
  }
  expect(history(dbPath)).toEqual(
    before.map((row) =>
      row.version === 8 ? { ...row, checksum: legacy } : row,
    ),
  );
  setChecksum(dbPath, 8, hash('tampered'));
  expect(() => openBaselineStore(dbPath, directory)).toThrow(/history/i);
});
it('starts when the checked out migrations are CRLF and history holds their raw checksum', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-legacy-crlf-'));
  roots.push(root);
  const migrations = crlfCopy(root);
  const dbPath = join(root, 'app.sqlite');
  openBaselineStore(dbPath, migrations).close();
  const before = history(dbPath);
  const raw = hash(
    readFileSync(join(migrations, '0008_article_covers.sql'), 'utf8'),
  );
  expect(raw).not.toBe(before[7].checksum);
  setChecksum(dbPath, 8, raw);
  const store = openBaselineStore(dbPath, migrations);
  try {
    expect(store.getSchemaVersion()).toBe(STORAGE_SCHEMA_VERSION);
  } finally {
    store.close();
  }
  expect(history(dbPath)).toEqual(
    before.map((row) => (row.version === 8 ? { ...row, checksum: raw } : row)),
  );
});

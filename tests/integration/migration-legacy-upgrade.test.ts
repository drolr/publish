import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  migrate,
  readMigrations,
  type Migration,
} from '../../src/infrastructure/persistence/migrate';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
const migrationsDirectory = resolve(
  'src/infrastructure/persistence/migrations',
);
const migrations = readMigrations(migrationsDirectory);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(root.startsWith(join(tmpdir(), 'migration-legacy-upgrade-'))).toBe(
      true,
    );
    rmSync(root, { recursive: true, force: true });
  }
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLineEndings(sql: string): string {
  return sql.split(CRLF).join(LF).split(CR).join(LF);
}

// Historical releases hashed the checked-out CRLF bytes of the same file.
function legacyCrlfChecksum(sql: string): string {
  return hash(normalizeLineEndings(sql).split(LF).join(CRLF));
}

function lfChecksum(sql: string): string {
  return hash(normalizeLineEndings(sql));
}

function createDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'migration-legacy-upgrade-'));
  roots.push(root);
  const db = new Database(join(root, 'app.sqlite'));
  db.pragma('foreign_keys = ON');
  return db;
}

function readOnDisk(name: string): string {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

interface HistoryRow {
  version: number;
  name: string;
  checksum: string;
}

function history(db: Database.Database): HistoryRow[] {
  return db
    .prepare(
      'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
    )
    .all() as HistoryRow[];
}

function schemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number };
  return row.version;
}

function businessRows(db: Database.Database) {
  return {
    articles: db.prepare('SELECT * FROM articles ORDER BY article_key').all(),
    covers: db
      .prepare(
        'SELECT * FROM article_cover_versions ORDER BY article_key,cover_revision',
      )
      .all(),
    heads: db
      .prepare('SELECT * FROM article_cover_heads ORDER BY article_key')
      .all(),
  };
}

function seedBusinessRows(db: Database.Database): void {
  db.prepare(
    'INSERT INTO articles(article_key,external_id,import_id,title,body_json,content_declaration,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'legacy-article',
    'legacy-external',
    'legacy-import',
    '历史标题',
    '[{"type":"paragraph","text":"legacy body"}]',
    'original',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare(
    'INSERT INTO article_cover_versions(article_key,cover_revision,mode,assets_json,configuration_digest,save_operation_id,committed_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'legacy-article',
    1,
    'single',
    '[{"assetKey":"legacy-cover"}]',
    'legacy-digest',
    'legacy-operation',
    '2026-01-02T00:00:00.000Z',
  );
  db.prepare(
    'INSERT INTO article_cover_heads(article_key,cover_revision) VALUES(?,?)',
  ).run('legacy-article', 1);
}

it('upgrades a schema 14 database whose 0008 checksum is the historical CRLF hash', () => {
  const migration8 = migrations[7];
  expect(migration8).toMatchObject({
    version: 8,
    name: '0008_article_covers.sql',
    checksum:
      '88cf36b10e658592ef962682659e37ae26c68aab7b6f724587a3aa94fd21087d',
  });
  const shippedSql = readOnDisk(migration8.name);
  expect(migration8.sql).toBe(shippedSql);
  const canonical = lfChecksum(shippedSql);
  const legacy = legacyCrlfChecksum(shippedSql);
  expect(canonical).toBe(migration8.checksum);
  expect(legacy).not.toBe(canonical);

  const db = createDatabase();
  try {
    migrate(db, migrations.slice(0, 14));
    expect(schemaVersion(db)).toBe(14);
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=8').run(
      legacy,
    );
    expect(history(db).find((row) => row.version === 8)?.checksum).toBe(legacy);

    seedBusinessRows(db);
    const before = businessRows(db);
    const beforeHistory = history(db);

    migrate(db, migrations);

    expect(schemaVersion(db)).toBe(15);
    const afterHistory = history(db);
    expect(afterHistory).toHaveLength(15);
    expect(businessRows(db)).toEqual(before);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(afterHistory.slice(0, 14)).toEqual(beforeHistory);
    expect(afterHistory.find((row) => row.version === 8)).toEqual({
      version: 8,
      name: '0008_article_covers.sql',
      checksum: legacy,
    });
    expect(afterHistory[14]).toEqual({
      version: 15,
      name: '0015_rich_body_v2.sql',
      checksum: migrations[14].checksum,
    });
    expect(migrations[14].checksum).toBe(
      lfChecksum(readOnDisk(migrations[14].name)),
    );

    migrate(db, migrations);
    expect(history(db)).toEqual(afterHistory);
  } finally {
    db.close();
  }
});

it('rejects 0008 content changed after release even when history holds the CRLF checksum', () => {
  const migration8 = migrations[7];
  const legacy = legacyCrlfChecksum(migration8.sql);
  const db = createDatabase();
  try {
    migrate(db, migrations.slice(0, 14));
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=8').run(
      legacy,
    );
    seedBusinessRows(db);
    const before = businessRows(db);
    const tamperedSql = migration8.sql + '\n-- changed after release\n';
    const tampered = migrations.map((migration): Migration =>
      migration.version === 8
        ? {
            ...migration,
            sql: tamperedSql,
            checksum: lfChecksum(tamperedSql),
          }
        : migration,
    );

    expect(() => migrate(db, tampered)).toThrow('Migration history mismatch');
    expect(schemaVersion(db)).toBe(14);
    expect(businessRows(db)).toEqual(before);
    expect(history(db)).toHaveLength(14);
    expect(history(db).find((row) => row.version === 8)?.checksum).toBe(legacy);
  } finally {
    db.close();
  }
});

it('migrates an empty database to 15 with LF-normalized checksums', () => {
  const db = createDatabase();
  try {
    migrate(db, migrations);

    expect(schemaVersion(db)).toBe(15);
    const stored = history(db);
    expect(stored).toHaveLength(15);
    expect(stored).toEqual(
      migrations.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      })),
    );
    for (const migration of migrations) {
      const onDisk = readOnDisk(migration.name);
      expect(migration.checksum).toBe(lfChecksum(onDisk));
      expect(
        stored.find((row) => row.version === migration.version)?.checksum,
      ).toBe(lfChecksum(onDisk));
      expect(
        stored.find((row) => row.version === migration.version)?.checksum,
      ).not.toBe(legacyCrlfChecksum(onDisk));
    }
    expect(stored.find((row) => row.version === 8)?.checksum).toBe(
      '88cf36b10e658592ef962682659e37ae26c68aab7b6f724587a3aa94fd21087d',
    );
  } finally {
    db.close();
  }
});

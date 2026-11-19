// Historical business-data-only fixture. Never auto-migrate/open the immutable source for writing.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { manualTempLedgerSchema } from '../../src/contracts/manual-temp-ledger';
// Explicit opt-in only; no personal backup location is embedded or exported.
export const schema6Backup = process.env.DRAFT_ASSISTANT_SCHEMA6_BACKUP ?? '';
export const hasSchema6Backup =
  schema6Backup.length > 0 && existsSync(join(schema6Backup, 'manifest.json'));
export function treeHashes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      const bytes = readFileSync(path);
      return {
        path: path.slice(root.length + 1).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function quoted(value: string) {
  assert.match(value, /^[a-zA-Z0-9_]+$/);
  return `"${value}"`;
}
export function logicalSnapshot(
  path: string,
  original?: Record<string, { columns: string[]; rows: unknown[] }>,
) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = original
      ? Object.keys(original)
      : (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
    return Object.fromEntries(
      tables.map((table) => {
        const columns =
          original?.[table].columns ??
          (
            db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as {
              name: string;
            }[]
          ).map((r) => r.name);
        const rows = db
          .prepare(
            `SELECT ${columns.map(quoted).join(',')} FROM ${quoted(table)}`,
          )
          .all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        // The forward migration adds version7; historical migration rows must remain exact.
        return [
          table,
          {
            columns,
            rows:
              table === 'schema_migrations' && original
                ? rows.filter((r) => (r as { version: number }).version <= 6)
                : rows,
          },
        ];
      }),
    );
  } finally {
    db.close();
  }
}
export function copyHistoricalBusinessData(root: string) {
  assert.equal(
    hasSchema6Backup,
    true,
    'Explicit immutable schema6 backup unavailable',
  );
  const before = treeHashes(schema6Backup);
  const manifest = JSON.parse(
    readFileSync(join(schema6Backup, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.status, 'PASS');
  assert.deepEqual(manifest.migrations, [1, 2, 3, 4, 5, 6]);
  const db = before.find((e) => e.path === 'data/app.sqlite');
  assert.equal(db?.sha256, manifest.backupDbSha256);
  for (const group of ['data', 'assets']) {
    for (const file of manifest.sourceTrees[group]) {
      if (group === 'data' && file.path === 'app.sqlite') continue;
      const current = before.find((e) => e.path === `${group}/${file.path}`);
      assert.equal(current?.sha256, file.sha256);
      assert.equal(current?.bytes, file.bytes);
    }
  }
  const logical = logicalSnapshot(join(schema6Backup, 'data/app.sqlite'));
  const dbReadonly = new Database(join(schema6Backup, 'data/app.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(dbReadonly.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(dbReadonly.pragma('foreign_key_check'), []);
  } finally {
    dbReadonly.close();
  }
  // Deliberately copy only authorized business subtrees, excluding all browser/Profile data.
  cpSync(join(schema6Backup, 'data'), join(root, 'data'), { recursive: true });
  cpSync(join(schema6Backup, 'assets'), join(root, 'assets'), {
    recursive: true,
  });
  return {
    before,
    logical,
    assets: treeHashes(join(root, 'assets')),
    escrowLedger: undefined as string | undefined,
    nonDatabaseFiles: treeHashes(join(root, 'data')).filter(
      (file) => !file.path.startsWith('app.sqlite'),
    ),
  };
}
export function verifyHistoricalUpgrade(
  root: string,
  expected: ReturnType<typeof copyHistoricalBusinessData>,
) {
  assert.equal(
    JSON.stringify(
      logicalSnapshot(join(root, 'data/app.sqlite'), expected.logical),
    ) === JSON.stringify(expected.logical),
    true,
    'Historical original columns and rows must remain exact',
  );
  assert.deepEqual(treeHashes(join(root, 'assets')), expected.assets);
  assert.deepEqual(treeHashes(schema6Backup), expected.before);
  const nonLedger = (file: { path: string }) =>
    !expected.escrowLedger || file.path !== 'manual-temp-ledger.json';
  assert.deepEqual(
    treeHashes(join(root, 'data'))
      .filter((file) => !file.path.startsWith('app.sqlite'))
      .filter(nonLedger),
    expected.nonDatabaseFiles.filter(nonLedger),
  );
  if (expected.escrowLedger) {
    const original = expected.nonDatabaseFiles.find(
      (file) => file.path === 'manual-temp-ledger.json',
    )!;
    assert.equal(
      createHash('sha256')
        .update(readFileSync(expected.escrowLedger))
        .digest('hex'),
      original.sha256,
    );
    assert.deepEqual(
      manualTempLedgerSchema.parse(
        JSON.parse(
          readFileSync(join(root, 'data/manual-temp-ledger.json'), 'utf8'),
        ),
      ).sessions,
      [],
    );
  }
  const db = new Database(join(root, 'data/app.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(
      (
        db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as { version: number }[]
      ).map((r) => r.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    assert.equal(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM articles WHERE deleted_at IS NOT NULL',
          )
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    db.close();
  }
  return {
    status: 'PASS',
    source: schema6Backup,
    sourceFilesUnchanged: expected.before.length,
    originalColumnsRowsExact: true,
    assetFilesExact: expected.assets.length,
    integrity: 'ok',
    foreignKeyViolations: 0,
    schemaVersion: 15,
    historicalArticleCount: expected.logical.articles.rows.length,
    historicalTaskCount: expected.logical.judongche_draft_tasks.rows.length,
    historicalSaveOperations:
      expected.logical.article_edit_operations.rows.length,
  };
}

/** Prior approved clone-only adjustment: escrow a proved empty copied physical-identity ledger. */
export function prepareEmptyCopiedLedger(
  ownerRoot: string,
  userData: string,
  expected: ReturnType<typeof copyHistoricalBusinessData>,
) {
  assert.equal(
    resolve(userData).startsWith(resolve(ownerRoot) + sep),
    true,
    'Clone must be inside its owned temporary root',
  );
  const ledger = join(userData, 'data/manual-temp-ledger.json');
  const original = expected.nonDatabaseFiles.find(
    (file) => file.path === 'manual-temp-ledger.json',
  );
  assert.ok(original);
  const bytes = readFileSync(ledger);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    original.sha256,
  );
  assert.deepEqual(
    manualTempLedgerSchema.parse(JSON.parse(bytes.toString())).sessions,
    [],
  );
  const temp = join(userData, 'data/manual-temp');
  assert.equal(
    existsSync(temp) ? readdirSync(temp, { recursive: true }).length : 0,
    0,
    'Copied temporary assets must be empty',
  );
  assert.equal(
    readdirSync(join(userData, 'data')).some((name) =>
      /^manual-temp-ledger\..+\.tmp$/.test(name),
    ),
    false,
  );
  assert.equal(
    expected.logical.article_import_attempts.rows.length,
    0,
    'No pending import records',
  );
  assert.equal(
    expected.logical.article_edit_operations.rows.some((row) => {
      const r = row as { cleanup_complete: number; status: string };
      return (
        r.cleanup_complete !== 1 ||
        ['preparing', 'cleanup_required', 'needs_review'].includes(r.status)
      );
    }),
    false,
    'No pending save records',
  );
  assert.equal(
    expected.logical.judongche_draft_tasks.rows.some((row) => {
      const r = row as { holds_platform: number; state: string };
      return (
        r.holds_platform !== 0 ||
        ['queued', 'running', 'needs_human', 'interrupted'].includes(r.state)
      );
    }),
    false,
    'No pending platform records',
  );
  assert.equal(
    JSON.stringify(
      logicalSnapshot(join(userData, 'data/app.sqlite'), expected.logical),
    ) === JSON.stringify(expected.logical),
    true,
    'Copied old database rows must still be exact',
  );
  const escrow = join(ownerRoot, 'escrow');
  mkdirSync(escrow);
  expected.escrowLedger = join(escrow, 'manual-temp-ledger.json');
  renameSync(ledger, expected.escrowLedger);
  assert.equal(
    createHash('sha256')
      .update(readFileSync(expected.escrowLedger))
      .digest('hex'),
    original.sha256,
  );
  assert.deepEqual(treeHashes(schema6Backup), expected.before);
}

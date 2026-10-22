import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
import { createManualTempStore } from '../../src/infrastructure/assets/manual-temp-store';
const base = path.resolve('.tmp/manual-temp');
const roots: string[] = [];
const signal = () => new AbortController().signal;
async function setup() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  roots.push(root);
  const store = createManualTempStore(root);
  expect(await store.recover()).toBe(true);
  return {
    root,
    store,
    ledger: path.join(root, 'data/manual-temp-ledger.json'),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + path.sep)) throw Error('unsafe');
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('reserve_before_file persists reservation before exclusive creation and seals before returning', async () => {
  const { root, store, ledger } = await setup();
  const session = randomUUID();
  const realOpen = fs.open;
  let observed = false;
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof realOpen>) => {
      if (String(args[0]).endsWith('.bin') && args[1] === 'wx') {
        const journal = JSON.parse(await fs.readFile(ledger, 'utf8'));
        expect(JSON.stringify(journal)).toContain('reserved');
        observed = true;
      }
      return realOpen(...args);
    },
  );
  const ref = await store.put(session, Buffer.from('bytes'), signal());
  expect(observed).toBe(true);
  expect(await store.read(ref, signal())).toEqual(Buffer.from('bytes'));
  expect(await createManualTempStore(root).recover()).toBe(true);
  expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  expect(await createManualTempStore(root).recover()).toBe(true);
});
it.each([
  'hardlink',
  'replace',
  'junction',
  'corrupt',
  'unknown',
  'unsealed',
] as const)('foreign_or_linked_file_blocks_recovery: %s', async (mode) => {
  const { root, store, ledger } = await setup();
  const session = randomUUID();
  const ref = await store.put(session, Buffer.from('bytes'), signal());
  const dir = path.join(root, 'data/manual-temp', session);
  const file = path.join(dir, `${ref.fileId}.bin`);
  if (mode === 'hardlink') await fs.link(file, path.join(root, 'foreign'));
  if (mode === 'replace') {
    await fs.rename(file, path.join(root, 'original'));
    await fs.writeFile(file, 'bytes');
  }
  if (mode === 'junction') {
    await fs.rename(dir, path.join(root, 'original'));
    await fs.symlink(path.join(root, 'original'), dir, 'junction');
  }
  if (mode === 'corrupt') await fs.writeFile(ledger, '{}');
  if (mode === 'unknown') await fs.writeFile(path.join(dir, 'foreign'), 'keep');
  if (mode === 'unsealed') {
    const j = JSON.parse(await fs.readFile(ledger, 'utf8'));
    const f = j.sessions[0].files[0];
    delete f.identity;
    delete f.sha256;
    f.phase = 'reserved';
    await fs.writeFile(ledger, JSON.stringify(j));
  }
  expect(await createManualTempStore(root).recover()).toBe(false);
  expect(await fs.readFile(file, 'utf8')).toBe('bytes');
});
it('saved_read_hash_mismatch_rejects and cleanup preserves tampered bytes', async () => {
  const { root, store } = await setup();
  const ref = await store.put(randomUUID(), Buffer.from('bytes'), signal());
  const file = path.join(
    root,
    'data/manual-temp',
    ref.sessionId,
    `${ref.fileId}.bin`,
  );
  await fs.writeFile(file, 'other');
  await expect(store.read(ref, signal())).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  await expect(store.remove(ref)).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  expect(await fs.readFile(file, 'utf8')).toBe('other');
});
it('missing ledger and unknown root retains files and blocks writes', async () => {
  const { root, ledger } = await setup();
  await fs.unlink(ledger);
  const file = path.join(root, 'data/manual-temp/unknown');
  await fs.writeFile(file, 'keep');
  const store = createManualTempStore(root);
  expect(await store.recover()).toBe(false);
  await expect(
    store.put(randomUUID(), Buffer.from('bytes'), signal()),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await fs.readFile(file, 'utf8')).toBe('keep');
});
it('atomic ledger replacement never truncates the prior journal; failed replacement blocks writes', async () => {
  const { store, ledger } = await setup();
  const before = await fs.readFile(ledger);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Error('injected failure'));
  await expect(
    store.put(randomUUID(), Buffer.from('bytes'), signal()),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await fs.readFile(ledger)).toEqual(before);
  await expect(
    store.put(randomUUID(), Buffer.from('bytes'), signal()),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
it('abort before publication removes sealed bytes and does not touch formal assets', async () => {
  const { root, store } = await setup();
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/keep'), 'formal');
  const c = new AbortController();
  const realRename = fs.rename;
  let writes = 0;
  vi.spyOn(fs, 'rename').mockImplementation(
    async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (++writes === 4) c.abort();
    },
  );
  await expect(
    store.put(randomUUID(), Buffer.from('bytes'), c.signal),
  ).rejects.toThrow();
  expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
  expect(await fs.readFile(path.join(root, 'assets/keep'), 'utf8')).toBe(
    'formal',
  );
});
it('recovers a persisted reservation with no file but retains unsealed partial writes', async () => {
  const { root, store } = await setup();
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof realOpen>) => {
      if (String(args[0]).endsWith('.bin')) throw Error('before create');
      return realOpen(...args);
    },
  );
  await expect(
    store.put(randomUUID(), Buffer.from('bytes'), signal()),
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  vi.restoreAllMocks();
  expect(await createManualTempStore(root).recover()).toBe(true);
  expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual([]);
});
it('strict ledger rejects traversal, extra persisted content and duplicate identifiers without deleting bytes', async () => {
  const { root, store, ledger } = await setup();
  const ref = await store.put(randomUUID(), Buffer.from('bytes'), signal());
  const original = await fs.readFile(ledger, 'utf8');
  for (const change of [
    (j: Record<string, unknown>) => {
      j.html = 'secret';
    },
    (j: Record<string, unknown>) => {
      (j.sessions as { sessionId: string }[])[0].sessionId = '../assets';
    },
    (j: Record<string, unknown>) => {
      const sessions = j.sessions as unknown[];
      sessions.push(structuredClone(sessions[0]));
    },
    (j: Record<string, unknown>) => {
      const files = (j.sessions as { files: unknown[] }[])[0].files;
      files.push(structuredClone(files[0]));
    },
  ]) {
    const journal = JSON.parse(original);
    change(journal);
    await fs.writeFile(ledger, JSON.stringify(journal));
    expect(await createManualTempStore(root).recover()).toBe(false);
  }
  expect(
    await fs.readFile(
      path.join(root, 'data/manual-temp', ref.sessionId, `${ref.fileId}.bin`),
      'utf8',
    ),
  ).toBe('bytes');
});
it('serializes competing puts and retains both journal entries across atomic replacements', async () => {
  const { root, store } = await setup();
  const session = randomUUID();
  const refs = await Promise.all([
    store.put(session, Buffer.from('one'), signal()),
    store.put(session, Buffer.from('two'), signal()),
  ]);
  expect(await store.read(refs[0], signal())).toEqual(Buffer.from('one'));
  expect(await store.read(refs[1], signal())).toEqual(Buffer.from('two'));
  expect(await createManualTempStore(root).recover()).toBe(true);
});
it('hash verification rejects tampered read bytes even with unchanged identity', async () => {
  const { store } = await setup();
  const ref = await store.put(randomUUID(), Buffer.from('bytes'), signal());
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof realOpen>) => {
      const h = await realOpen(...args);
      if (String(args[0]).endsWith('.bin')) {
        const realRead = h.read.bind(h);
        h.read = (async (...readArgs: Parameters<typeof realRead>) => {
          const result = await realRead(...readArgs);
          if (result.bytesRead)
            new Uint8Array(
              result.buffer.buffer,
              result.buffer.byteOffset,
              result.buffer.byteLength,
            )[0] ^= 1;
          return result;
        }) as typeof h.read;
      }
      return h;
    },
  );
  await expect(store.read(ref, signal())).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
});
import { spawn } from 'node:child_process';
import { openArticleRepository } from '../../src/infrastructure/persistence/article-repository';
import { createAssetStore } from '../../src/infrastructure/assets/asset-store';
import { createArticleImportService } from '../../src/application/article-import';
it.each([
  { phase: 'sealed', name: 'killed_sealed_temp_recovered_no_draft' },
  { phase: 'unsealed', name: 'killed_unsealed_unknown_retained_blocks_writes' },
  {
    phase: 'committed',
    name: 'committed_before_temp_release_preserves_article',
  },
] as const)(
  '$name',
  async ({ phase }) => {
    const { root } = await setup();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('tests/integration/manual-temp-crash-child.ts'),
        root,
        phase,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<void>((done) =>
      child.once('exit', () => done()),
    );
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(Error(`checkpoint timeout ${stderr}`)),
          15000,
        );
        child.once('message', () => {
          clearTimeout(timer);
          done();
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(Error(`early exit ${code} ${stderr}`));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const repository = openArticleRepository(
      path.join(root, 'app.sqlite'),
      path.resolve('src/infrastructure/persistence/migrations'),
    );
    const assets = createAssetStore(path.join(root, 'assets'));
    const service = createArticleImportService(repository, assets, {
      read: async () => {
        throw Error('network forbidden');
      },
    });
    try {
      expect(await service.recover()).toBe(true);
      const recovered = createManualTempStore(root);
      expect(await recovered.recover()).toBe(phase !== 'unsealed');
      if (phase === 'unsealed') {
        await expect(
          recovered.put(randomUUID(), Buffer.from('new'), signal()),
        ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        const journal = JSON.parse(
          await fs.readFile(
            path.join(root, 'data/manual-temp-ledger.json'),
            'utf8',
          ),
        );
        const s = journal.sessions[0];
        expect(
          (
            await fs.readFile(
              path.join(
                root,
                'data/manual-temp',
                s.sessionId,
                `${s.files[0].fileId}.bin`,
              ),
            )
          ).length,
        ).toBeGreaterThan(0);
      } else
        expect(await fs.readdir(path.join(root, 'data/manual-temp'))).toEqual(
          [],
        );
      const article = repository.findExternal('crash');
      if (phase === 'committed') {
        expect(article).toBeDefined();
        await assets.verify(article!);
        expect(article!.body.map((b) => b.type)).toEqual([
          'paragraph',
          'image',
        ]);
        expect(article!.assets[0].relativePath).not.toContain('manual-temp');
      } else
        expect(repository.list!()).toMatchObject({
          status: 'ok',
          page: { items: [] },
        });
      expect(repository.attempts()).toEqual([]);
    } finally {
      repository.close();
    }
  },
  20000,
);

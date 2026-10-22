import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { WebPasteFailure } from '../../domain/web-paste-error';
import {
  assertLocalPath,
  assertPhysicalPath,
  readBoundedFile,
} from './local-reader';
import {
  manualTempLedgerSchema,
  tempSessionId,
  type ManualTempLedger,
  type TempFile,
  type TempSession,
} from '../../contracts/manual-temp-ledger';
export interface TempImageRef {
  sessionId: string;
  fileId: string;
  byteSize: number;
  sha256: string;
}
export interface ManualTempStore {
  recover(): Promise<boolean>;
  put(
    sessionId: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<TempImageRef>;
  read(ref: TempImageRef, signal: AbortSignal): Promise<Uint8Array>;
  remove(ref: TempImageRef): Promise<void>;
}
const fail = () => new WebPasteFailure('RECOVERY_REQUIRED');
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const identity = (s: BigIntStats) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  birth: String(s.birthtimeNs),
});
const fileIdentity = (s: BigIntStats) => ({
  ...identity(s),
  size: String(s.size),
  mtime: String(s.mtimeNs),
  ctime: String(s.ctimeNs),
});
const equal = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
const exists = async (p: string) => {
  try {
    return await lstat(p, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};
/** root is the trusted userData directory; assets/ is never accessed. */
export function createManualTempStore(root: string): ManualTempStore {
  assertLocalPath(root);
  root = path.resolve(root);
  const data = path.join(root, 'data'),
    temp = path.join(data, 'manual-temp'),
    journal = path.join(data, 'manual-temp-ledger.json');
  let ledger: ManualTempLedger | undefined;
  let journalHash: string | undefined;
  let journalIdentity: ReturnType<typeof fileIdentity> | undefined;
  let ready = false;
  let failed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const dir = (s: TempSession) => path.join(temp, s.sessionId);
  const owner = (s: TempSession) => path.join(dir(s), `${s.nonce}.owner`);
  const filename = (s: TempSession, f: TempFile) =>
    path.join(dir(s), `${f.fileId}.bin`);
  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const p = tail.then(operation);
    tail = p.catch(() => {});
    return p;
  }
  async function physical(p: string) {
    await assertPhysicalPath(path.parse(root).root, p);
  }
  async function directory(p: string, id?: ReturnType<typeof identity>) {
    await physical(p);
    const st = await lstat(p, { bigint: true });
    if (!st.isDirectory() || (id && !equal(identity(st), id))) throw fail();
    return identity(st);
  }
  async function fileBytes(p: string, id?: ReturnType<typeof fileIdentity>) {
    await physical(p);
    const st = await lstat(p, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || (id && !equal(fileIdentity(st), id)))
      throw fail();
    const b = await readBoundedFile(root, p, new AbortController().signal);
    const after = await lstat(p, { bigint: true });
    if (!equal(fileIdentity(st), fileIdentity(after)) || after.nlink !== 1n)
      throw fail();
    return b;
  }
  async function roots() {
    if (!ledger) throw fail();
    await directory(root, ledger.root);
    await directory(data, ledger.data);
    await directory(temp, ledger.temp);
  }
  async function journalUnchanged() {
    await roots();
    if (journalHash === undefined) {
      if (await exists(journal)) throw fail();
    } else if (
      digest(await fileBytes(journal, journalIdentity)) !== journalHash
    )
      throw fail();
  }
  async function save() {
    await journalUnchanged();
    const bytes = Buffer.from(JSON.stringify(ledger));
    const target = path.join(data, `manual-temp-ledger.${randomUUID()}.tmp`);
    const handle = await open(target, 'wx');
    let id: ReturnType<typeof fileIdentity>;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      id = fileIdentity(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
    await journalUnchanged();
    await fileBytes(target, id);
    await rename(target, journal);
    journalIdentity = fileIdentity(await lstat(journal, { bigint: true }));
    journalHash = digest(bytes);
    if (digest(await fileBytes(journal, journalIdentity)) !== journalHash)
      throw fail();
  }
  async function verifySession(s: TempSession) {
    await roots();
    if (!s.identity || !s.owner) throw fail();
    await directory(dir(s), s.identity);
    if ((await fileBytes(owner(s), s.owner)).toString() !== s.nonce)
      throw fail();
    const allowed = new Set([
      `${s.nonce}.owner`,
      ...s.files.map((f) => `${f.fileId}.bin`),
    ]);
    for (const name of await readdir(dir(s)))
      if (!allowed.has(name)) throw fail();
  }
  async function verifyFile(s: TempSession, f: TempFile) {
    await verifySession(s);
    if (f.phase !== 'sealed') throw fail();
    const bytes = await fileBytes(filename(s, f), f.identity);
    if (bytes.length !== f.byteSize || digest(bytes) !== f.sha256) throw fail();
    return bytes;
  }
  async function removeSession(s: TempSession) {
    if (!s.identity || !s.owner) {
      if (await exists(dir(s))) throw fail();
    } else if (await exists(dir(s))) {
      await directory(dir(s), s.identity);
      const entries = await readdir(dir(s));
      if (entries.length) {
        if (entries.length !== 1 || entries[0] !== `${s.nonce}.owner`)
          throw fail();
        await fileBytes(owner(s), s.owner);
        await unlink(owner(s));
      }
      await directory(dir(s), s.identity);
      await rmdir(dir(s));
    }
    ledger!.sessions = ledger!.sessions.filter((item) => item !== s);
    await save();
  }
  async function removeFile(s: TempSession, f: TempFile) {
    await roots();
    if (await exists(filename(s, f))) {
      await verifyFile(s, f);
      await unlink(filename(s, f));
    } else if (await exists(dir(s))) await verifySession(s);
    s.files = s.files.filter((item) => item !== f);
    await save();
    if (!s.files.length) await removeSession(s);
  }
  function find(ref: TempImageRef) {
    const s = ledger?.sessions.find((s) => s.sessionId === ref.sessionId);
    const f = s?.files.find((f) => f.fileId === ref.fileId);
    if (
      !s ||
      !f ||
      f.phase !== 'sealed' ||
      f.byteSize !== ref.byteSize ||
      f.sha256 !== ref.sha256
    )
      throw fail();
    return { s, f };
  }
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (!ready || failed) throw fail();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WebPasteFailure && e.code === 'CANCELLED') throw e;
      failed = true;
      throw fail();
    }
  }
  return {
    recover: () =>
      locked(async () => {
        if (failed) return false;
        if (ready) return true;
        try {
          await directory(root);
          if (!(await exists(data))) await mkdir(data);
          await directory(data);
          if (!(await exists(temp))) await mkdir(temp);
          await directory(temp);
          if (
            (await readdir(data)).some((n) =>
              /^manual-temp-ledger\..+\.tmp$/.test(n),
            )
          )
            throw fail();
          if (await exists(journal)) {
            const bytes = await fileBytes(journal);
            ledger = manualTempLedgerSchema.parse(JSON.parse(bytes.toString()));
            journalHash = digest(bytes);
            journalIdentity = fileIdentity(
              await lstat(journal, { bigint: true }),
            );
            await roots();
          } else {
            if ((await readdir(temp)).length) throw fail();
            ledger = {
              version: 1,
              root: await directory(root),
              data: await directory(data),
              temp: await directory(temp),
              sessions: [],
            };
            await save();
          }
          const allowed = new Set(ledger.sessions.map((s) => s.sessionId));
          for (const name of await readdir(temp))
            if (!allowed.has(name)) throw fail();
          // Validate all existing artifacts before deleting anything. Unsealed creation is ambiguous.
          for (const s of ledger.sessions) {
            if (!(await exists(dir(s)))) continue;
            if (!s.identity || !s.owner) throw fail();
            await directory(dir(s), s.identity);
            if (!s.files.length && (await readdir(dir(s))).length === 0)
              continue;
            await verifySession(s);
            for (const f of s.files)
              if (await exists(filename(s, f))) await verifyFile(s, f);
          }
          for (const s of [...ledger.sessions]) {
            for (const f of [...s.files]) {
              if (!(await exists(dir(s)))) {
                s.files = s.files.filter((x) => x !== f);
                await save();
              } else await removeFile(s, f);
            }
            if (ledger.sessions.includes(s)) await removeSession(s);
          }
          ready = true;
          return true;
        } catch {
          failed = true;
          return false;
        }
      }),
    put: (sessionId, bytes, signal) =>
      locked(() =>
        guarded(async () => {
          if (signal.aborted) throw new WebPasteFailure('CANCELLED');
          if (
            !tempSessionId.safeParse(sessionId).success ||
            !bytes.length ||
            bytes.length > 20 * 1024 * 1024
          )
            throw fail();
          await journalUnchanged();
          let s = ledger!.sessions.find((s) => s.sessionId === sessionId);
          if (!s) {
            s = { sessionId, nonce: randomUUID(), files: [] };
            ledger!.sessions.push(s);
            await save();
            await mkdir(dir(s));
            await directory(dir(s));
            const h = await open(owner(s), 'wx');
            try {
              await h.writeFile(s.nonce);
              await h.sync();
              s.owner = fileIdentity(await h.stat({ bigint: true }));
            } finally {
              await h.close();
            }
            s.identity = await directory(dir(s));
            await save();
          }
          await verifySession(s);
          const f: TempFile = {
            fileId: randomUUID(),
            nonce: randomUUID(),
            byteSize: bytes.length,
            phase: 'reserved',
          };
          s.files.push(f);
          await save();
          await verifySession(s);
          const h = await open(filename(s, f), 'wx');
          let id: ReturnType<typeof fileIdentity>;
          try {
            await h.writeFile(bytes);
            await h.sync();
            id = fileIdentity(await h.stat({ bigint: true }));
          } finally {
            await h.close();
          }
          await verifySession(s);
          const written = await fileBytes(filename(s, f), id);
          const sealed: TempFile = {
            ...f,
            phase: 'sealed',
            identity: id,
            sha256: digest(written),
          };
          if (!Buffer.from(bytes).equals(written)) throw fail();
          s.files[s.files.indexOf(f)] = sealed;
          await save();
          await verifyFile(s, sealed);
          if (signal.aborted) {
            await removeFile(s, sealed);
            throw new WebPasteFailure('CANCELLED');
          }
          return {
            sessionId,
            fileId: sealed.fileId,
            byteSize: sealed.byteSize,
            sha256: sealed.sha256,
          };
        }),
      ),
    read: (ref, signal) =>
      locked(() =>
        guarded(async () => {
          if (signal.aborted) throw new WebPasteFailure('CANCELLED');
          await journalUnchanged();
          const { s, f } = find(ref);
          const bytes = await verifyFile(s, f);
          if (signal.aborted) throw new WebPasteFailure('CANCELLED');
          return bytes;
        }),
      ),
    remove: (ref) =>
      locked(() =>
        guarded(async () => {
          await journalUnchanged();
          const s = ledger!.sessions.find((s) => s.sessionId === ref.sessionId);
          if (!s) return;
          const f = s.files.find((f) => f.fileId === ref.fileId);
          if (!f) return;
          find(ref);
          await removeFile(s, f);
        }),
      ),
  };
}

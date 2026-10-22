import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyNativeZipArtifacts } from '../e2e/helpers/native-artifact-provenance';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'native-proof-')))
      throw Error('unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-proof-'));
  roots.push(root);
  const candidate = join(root, 'candidate'),
    archives = join(root, 'archives');
  mkdirSync(join(candidate, 'resources'), { recursive: true });
  mkdirSync(archives);
  const part = (base: string, name: string, bytes: string) => {
    writeFileSync(join(base, name), bytes);
    return {
      path: name,
      byteSize: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const manifest = {
    sourceHead: 'a'.repeat(40),
    candidateRoot: candidate,
    executable: part(candidate, 'fixture.exe', 'explicit fixture executable'),
    asar: part(candidate, 'resources/app.asar', 'fixture asar'),
    zip: part(archives, 'fixture.zip', 'fixture zip'),
  };
  const file = join(root, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return {
    root,
    candidate,
    archives,
    manifest,
    file,
    exe: join(candidate, 'fixture.exe'),
  };
}
it('binds the explicit candidate executable and formal ASAR and ZIP bytes to one source manifest before launch', () => {
  const f = fixture();
  expect(verifyNativeZipArtifacts(f.exe, f.file, f.archives)).toMatchObject({
    sourceHead: 'a'.repeat(40),
    executable: { path: resolve(f.exe) },
    asar: { path: join(f.candidate, 'resources/app.asar') },
    zip: { path: join(f.archives, 'fixture.zip') },
  });
});
it.each(['executable', 'asar', 'zip'] as const)(
  'rejects changed %s bytes before native launch',
  (part) => {
    const f = fixture(),
      base = part === 'zip' ? f.archives : f.candidate;
    writeFileSync(join(base, f.manifest[part].path), 'unexpected bytes');
    expect(() => verifyNativeZipArtifacts(f.exe, f.file, f.archives)).toThrow();
  },
);
it.each([
  'foreign-exe',
  'nested-exe',
  'escaped-asar',
  'missing-source',
  'wrong-size',
  'wrong-hash',
] as const)('rejects mismatched manifest authority: %s', (mode) => {
  const f = fixture();
  let exe = f.exe;
  if (mode === 'foreign-exe') {
    exe = join(f.root, 'foreign.exe');
    writeFileSync(exe, 'explicit fixture executable');
  }
  if (mode === 'nested-exe') {
    mkdirSync(join(f.candidate, 'nested'));
    exe = join(f.candidate, 'nested', 'fixture.exe');
    writeFileSync(exe, 'explicit fixture executable');
    f.manifest.executable.path = 'nested/fixture.exe';
  }
  if (mode === 'escaped-asar') f.manifest.asar.path = '../outside.asar';
  if (mode === 'missing-source') f.manifest.sourceHead = '';
  if (mode === 'wrong-size') f.manifest.executable.byteSize++;
  if (mode === 'wrong-hash') f.manifest.zip.sha256 = 'b'.repeat(64);
  writeFileSync(f.file, JSON.stringify(f.manifest));
  expect(() => verifyNativeZipArtifacts(exe, f.file, f.archives)).toThrow();
});

it('accepts an explicitly retained absolute ZIP path only after checking its complete bytes', () => {
  const f = fixture();
  f.manifest.zip.path = join(f.archives, 'fixture.zip');
  writeFileSync(f.file, JSON.stringify(f.manifest));
  expect(verifyNativeZipArtifacts(f.exe, f.file, f.archives)).toMatchObject({
    zip: {
      path: join(f.archives, 'fixture.zip'),
      sha256: f.manifest.zip.sha256,
    },
  });
});

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
const artifact = z.object({
  path: z.string().min(1),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.object({
  sourceHead: z.string().regex(/^[a-f0-9]{40}$/),
  candidateRoot: z.string().min(1),
  executable: artifact,
  asar: artifact,
  zip: artifact,
});
export function verifyNativeZipArtifacts(
  executable: string,
  manifestFile: string,
  zipDirectory: string,
) {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(manifestFile, 'utf8')),
  );
  if (!isAbsolute(manifest.candidateRoot))
    throw Error('Candidate root must be absolute');
  const candidateRoot = realpathSync(manifest.candidateRoot);
  function owned(name: string) {
    const file = resolve(candidateRoot, name),
      inside = relative(candidateRoot, file);
    if (
      !inside ||
      inside === '..' ||
      inside.startsWith('..' + sep) ||
      isAbsolute(inside)
    )
      throw Error('Artifact escapes candidate root');
    const physical = realpathSync(file),
      physicalInside = relative(candidateRoot, physical);
    if (
      !physicalInside ||
      physicalInside === '..' ||
      physicalInside.startsWith('..' + sep) ||
      isAbsolute(physicalInside)
    )
      throw Error('Artifact escapes physical candidate root');
    return file;
  }
  const exe = owned(manifest.executable.path),
    asar = owned(manifest.asar.path);
  if (dirname(exe) !== candidateRoot)
    throw Error('Executable must be at candidate root');
  if (realpathSync(executable) !== realpathSync(exe))
    throw Error('Explicit executable does not match candidate manifest');
  if (asar !== join(candidateRoot, 'resources', 'app.asar'))
    throw Error('ASAR does not belong to supplied executable');
  function verify(file: string, proof: z.infer<typeof artifact>) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== proof.byteSize)
      throw Error('Artifact file or size mismatch');
    const bytes = readFileSync(file),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== proof.byteSize || sha256 !== proof.sha256)
      throw Error('Artifact bytes mismatch');
    return { path: realpathSync(file), byteSize: bytes.length, sha256 };
  }
  const zip = isAbsolute(manifest.zip.path)
    ? manifest.zip.path
    : resolve(zipDirectory, manifest.zip.path);
  return {
    manifestPath: realpathSync(manifestFile),
    sourceHead: manifest.sourceHead,
    candidateRoot,
    executable: verify(exe, manifest.executable),
    asar: verify(asar, manifest.asar),
    zip: verify(zip, manifest.zip),
  };
}

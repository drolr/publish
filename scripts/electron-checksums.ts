export function verifiedElectronChecksums(
  version: string,
  checksums: Record<string, string>,
): Record<string, string> {
  const checksum = checksums[`electron-v${version}-win32-x64.zip`];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
    throw new Error('Pinned Electron Windows checksum missing or invalid');
  return checksums;
}

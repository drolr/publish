import { expect, it } from 'vitest';
import checksums from 'electron/checksums.json';
import electron from 'electron/package.json';
import project from '../../package.json';
import { verifiedElectronChecksums } from '../../scripts/electron-checksums';
it('uses checksums shipped with the same locked Electron version', () => {
  expect(electron.version).toBe(project.devDependencies.electron);
  expect(verifiedElectronChecksums(electron.version, checksums)).toBe(
    checksums,
  );
});
it.each<Record<string, string>>([
  {},
  { 'electron-v44.3.0-win32-x64.zip': '' },
  { 'electron-v44.3.0-win32-x64.zip': 'invalid' },
  { 'electron-v44.2.0-win32-x64.zip': 'a'.repeat(64) },
])('refuses empty, malformed or wrong-version checksum metadata', (input) => {
  expect(() => verifiedElectronChecksums('44.3.0', input)).toThrow('checksum');
});

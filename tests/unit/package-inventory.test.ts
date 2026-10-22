import { expect, it } from 'vitest';
import { validatePackageInventory } from '../../scripts/package-inventory';
const valid = [
  '/node_modules/playwright-core/package.json',
  '/node_modules/playwright-core/index.js',
  '/node_modules/playwright-core/browsers.json',
  '/node_modules/playwright-core/lib/coreBundle.js',
];
it('accepts the required packaged runtime inventory', () => {
  expect(() => validatePackageInventory(valid)).not.toThrow();
});
it.each(valid)('rejects missing runtime file %s', (missing) => {
  expect(() =>
    validatePackageInventory(valid.filter((p) => p !== missing)),
  ).toThrow('Incomplete');
});
it.each([
  'profiles/judongche/Default/Preferences',
  'Default/Cookies',
  'Network/Cookies',
  'Login Data',
  '.draft-assistant-profile',
])('rejects accidental profile file %s', (file) => {
  expect(() => validatePackageInventory([...valid, `/${file}`])).toThrow(
    'Profile',
  );
});

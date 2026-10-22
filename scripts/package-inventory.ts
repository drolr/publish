export function validatePackageInventory(paths: string[]): void {
  const normalized = paths.map(
    (path) => '/' + path.replaceAll('\\', '/').replace(/^\/+/, ''),
  );
  for (const file of [
    'package.json',
    'index.js',
    'browsers.json',
    'lib/coreBundle.js',
  ]) {
    if (!normalized.includes(`/node_modules/playwright-core/${file}`))
      throw new Error('Incomplete packaged Playwright runtime');
  }
  validateNoProfileFiles(normalized);
}

export function validateNoProfileFiles(paths: string[]): void {
  if (
    paths.some((path) =>
      /\/(?:profiles|Default|Network)\/|\/(?:Cookies|Login Data|Preferences|Local State|\.draft-assistant-profile)$/i.test(
        '/' + path.replaceAll('\\', '/'),
      ),
    )
  )
    throw new Error('Profile data must not enter the package');
}

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { packagePlaywrightCore } from '../../scripts/package-playwright';
const roots: string[] = [];
async function fixture(version = '1.63.0') {
  const root = await mkdtemp(join(tmpdir(), 'draft-package-test-'));
  roots.push(root);
  const source = join(root, 'project', 'node_modules', 'playwright-core');
  await mkdir(join(source, 'lib', 'server'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ version }));
  await writeFile(
    join(source, 'lib', 'server', 'browser.js'),
    'complete runtime',
  );
  await writeFile(join(source, 'browsers.json'), 'browser metadata');
  return { root, project: join(root, 'project'), build: join(root, 'build') };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('copies nested runtime files and package metadata to the packaged node_modules', async () => {
  const { project, build } = await fixture();
  await packagePlaywrightCore(project, build);
  expect(
    await readFile(
      join(build, 'node_modules/playwright-core/lib/server/browser.js'),
      'utf8',
    ),
  ).toBe('complete runtime');
  expect(
    await readFile(
      join(build, 'node_modules/playwright-core/browsers.json'),
      'utf8',
    ),
  ).toBe('browser metadata');
});
it('fails packaging on a runtime version outside the approved pin', async () => {
  const { project, build } = await fixture('1.62.0');
  await expect(packagePlaywrightCore(project, build)).rejects.toThrow('1.63.0');
});

it('copies a loadable installed runtime including its server implementation', async () => {
  const { build } = await fixture();
  const { resolve } = await import('node:path');
  const { createRequire } = await import('node:module');
  await packagePlaywrightCore(resolve('.'), build);
  const requirePackaged = createRequire(join(build, 'index.cjs'));
  expect(requirePackaged('playwright-core').chromium.name()).toBe('chromium');
  expect(requirePackaged('playwright-core/package.json').version).toBe(
    '1.63.0',
  );
});

import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function packagePlaywrightCore(
  projectRoot: string,
  buildPath: string,
): Promise<void> {
  const source = join(projectRoot, 'node_modules/playwright-core');
  const metadata: unknown = JSON.parse(
    await readFile(join(source, 'package.json'), 'utf8'),
  );
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('version' in metadata) ||
    metadata.version !== '1.63.0'
  ) {
    throw new Error('Packaging requires playwright-core 1.63.0');
  }
  await mkdir(join(buildPath, 'node_modules'), { recursive: true });
  await cp(source, join(buildPath, 'node_modules/playwright-core'), {
    recursive: true,
  });
}

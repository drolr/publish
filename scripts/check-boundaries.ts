import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBoundaries } from './boundaries';
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}
const errors = checkBoundaries(
  walk('src')
    .filter((file) => /\.(tsx?|sql)$/.test(file))
    .map((path) => ({ path, source: readFileSync(path, 'utf8') })),
);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Architecture boundaries PASS');

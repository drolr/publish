import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ReserveInputSchema } from '../../src/contracts/draft-task';
import { openDraftTaskRepository } from '../../src/infrastructure/persistence/draft-task-repository';
const [path, migrations, id, now, stage, file] = process.argv.slice(2);
const r = openDraftTaskRepository(path, migrations);
if (stage === 'race') {
  process.stdout.write('ready\n');
  process.stdin.once('data', () => {
    const input = ReserveInputSchema.parse(
      JSON.parse(readFileSync(file, 'utf8')) as unknown,
    );
    const result = r.reserve({
      ...input,
      taskId: randomUUID(),
      preparationId: randomUUID(),
    });
    process.stdout.write(result.status + '\n');
    r.close();
    process.exit(0);
  });
} else {
  r.apply(id, 0, { type: 'begin' }, now);
  r.apply(id, 1, { type: 'before-effect', stage: 'editor' }, now);
  if (stage === 'save') r.apply(id, 2, { type: 'before-save' }, now);
  process.exit(77);
}

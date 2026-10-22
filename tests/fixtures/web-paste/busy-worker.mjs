import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
parentPort.once('message', (input) => {
  writeFileSync(input.plain, 'running');
  while (true) {
    /* A real CPU-bound operation cannot cooperate with abort. */
  }
});

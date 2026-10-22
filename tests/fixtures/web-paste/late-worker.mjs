import { setTimeout } from 'node:timers';
import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
parentPort.once('message', (input) => {
  parentPort.postMessage({
    ok: true,
    result: {
      blocks: [{ type: 'paragraph', text: 'first' }],
      plainOnly: false,
    },
  });
  setTimeout(() => {
    writeFileSync(input.plain, 'late');
    parentPort.postMessage({
      ok: true,
      result: {
        blocks: [{ type: 'paragraph', text: 'late' }],
        plainOnly: false,
      },
    });
  }, 100);
});

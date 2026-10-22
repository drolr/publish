import { parentPort } from 'node:worker_threads';
parentPort.once('message', () => {
  parentPort.postMessage({
    ok: true,
    result: { blocks: [{ type: 'paragraph', text: 'safe' }], plainOnly: false },
    html: 'SECRET',
  });
});

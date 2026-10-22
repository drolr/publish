import { parentPort } from 'node:worker_threads';
parentPort.once('message', (input) => {
  let reply;
  switch (input.plain) {
    case 'empty':
      reply = { ok: true, result: { blocks: [], plainOnly: false } };
      break;
    case 'blank':
      reply = {
        ok: true,
        result: {
          blocks: [{ type: 'paragraph', text: '  ' }],
          plainOnly: false,
        },
      };
      break;
    case 'overbudget':
      reply = {
        ok: true,
        result: {
          blocks: [{ type: 'paragraph', text: 'x'.repeat(20001) }],
          plainOnly: false,
        },
      };
      break;
    case 'unknown':
      reply = { ok: false, code: 'SECRET exception' };
      break;
    case 'extra':
      reply = { ok: false, code: 'EMPTY', exception: 'SECRET' };
      break;
  }
  parentPort.postMessage(reply);
});

import { parentPort } from 'node:worker_threads';
parentPort.once('message', () => {
  throw new Error('SECRET https://private.test');
});

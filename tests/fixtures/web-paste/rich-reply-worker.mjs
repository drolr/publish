import { parentPort } from 'node:worker_threads';
parentPort.once('message', ({ input }) => {
  const result = {
    version: 2,
    plainOnly: false,
    warnings: [],
    blocks: [
      { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [] }] },
    ],
  };
  if (input.plain === 'warning') result.warnings = ['SECRET_HTML'];
  if (input.plain === 'html') result.html = '<p>SECRET</p>';
  if (input.plain === 'nested')
    result.blocks = [
      { type: 'blockquote', paragraphs: [{ type: 'heading', content: [] }] },
    ];
  parentPort.postMessage({ ok: true, result });
});
